import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ContentStatus,
  IndexStatus,
  KnowledgeImportFileType,
  KnowledgeImportStatus,
  ImportSourceCleanupStatus,
  KnowledgeKind,
  KnowledgeLibraryScope,
  Prisma,
  Role,
  type KnowledgeImportJob,
  type User,
} from '@prisma/client';
import {
  KNOWLEDGE_CHUNKER_VERSION,
  KNOWLEDGE_PARSER_VERSION,
  KNOWLEDGE_RENDER_BLOCK_VERSION,
  deterministicUuid,
  normalizeKnowledgeName,
} from '@bmc3/knowledge-core';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, extname } from 'node:path';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { KnowledgeAccessService } from './knowledge-access.service';
import {
  assertIncomingH2Target,
  lockKnowledgeLibrary,
} from './knowledge-h2';
import {
  readKnowledgeLimits,
  type KnowledgeLimits,
} from './knowledge-limits';

const CONFIRM_TTL_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_STATUSES: KnowledgeImportStatus[] = [
  KnowledgeImportStatus.PREFLIGHT_PENDING,
  KnowledgeImportStatus.PREFLIGHTING,
  KnowledgeImportStatus.AWAITING_CONFIRMATION,
  KnowledgeImportStatus.INDEX_PENDING,
  KnowledgeImportStatus.PROCESSING,
];

interface CreateKnowledgeImportInput {
  libraryId: string;
  targetDocumentId?: string;
}

interface PreviewSummary {
  titleMarkdown: string;
  contentHash: string;
  imageManifestHash: string;
  parserVersion: string;
  chunkerVersion: string;
  renderBlockVersion: string;
  renderBlockCount: number;
  mathCount: number;
  nodes: Array<{
    level: number;
    title: string;
    titleMarkdown: string;
    path: string;
    chapterName: string;
    chunkCount: number;
  }>;
  images: Array<{
    entryPath: string;
    altText: string;
    nodePathHash: string;
    occurrenceIndex: number;
  }>;
  replacement: {
    mode: 'CREATE' | 'REPLACE';
    targetDocumentId: string | null;
    targetDocumentTitle: string | null;
    targetDocumentCreatedAt: string | null;
    activeVersionId: string | null;
    matchedH2Titles: string[];
  };
}

@Injectable()
export class KnowledgeImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly access: KnowledgeAccessService,
  ) {}

  async create(
    user: User,
    file: Express.Multer.File | undefined,
    input: CreateKnowledgeImportInput,
  ) {
    const limits = readKnowledgeLimits();
    if (!file?.path) throw new BadRequestException('请选择 Markdown 或 ZIP 文件');
    let stored: Awaited<ReturnType<StorageService['save']>> | null = null;
    try {
      const library = await this.access.assertManage(user, input.libraryId);
      if (!library.active) throw new BadRequestException('知识库已停用');
      if (input.targetDocumentId) {
        const target = await this.prisma.knowledgeDocument.findFirst({
          where: {
            id: input.targetDocumentId,
            libraryId: library.id,
            kind: KnowledgeKind.MARKDOWN,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!target) throw new BadRequestException('目标 Markdown 文档不存在');
      }
      const fileType = await validateFile(file);
      const disk = await fs.statfs(dirname(file.path));
      const freeBytes = BigInt(disk.bavail) * BigInt(disk.bsize);
      if (freeBytes < limits.importMinFreeBytes) {
        throw new BadRequestException('导入临时目录可用空间不足');
      }
      const [userActive, totalActive, privateActive, ownPrivateActive] = await Promise.all([
        this.prisma.knowledgeImportJob.count({
          where: { createdById: user.id, status: { in: ACTIVE_STATUSES } },
        }),
        this.prisma.knowledgeImportJob.count({
          where: { status: { in: ACTIVE_STATUSES } },
        }),
        this.prisma.knowledgeImportJob.count({
          where: {
            status: { in: ACTIVE_STATUSES },
            library: { scope: KnowledgeLibraryScope.PRIVATE },
          },
        }),
        this.prisma.knowledgeImportJob.count({
          where: {
            createdById: user.id,
            status: { in: ACTIVE_STATUSES },
            library: { scope: KnowledgeLibraryScope.PRIVATE },
          },
        }),
      ]);
      assertImportQueueAvailability(limits, library.scope, {
        userActive,
        totalActive,
        privateActive,
        ownPrivateActive,
      });
      const sourceSha256 = await hashFile(file.path);
      stored = await this.storage.save(file, 'knowledge-imports');
      const job = await this.prisma.$transaction(async (transaction) => {
        const lockKeys = ['GLOBAL', `USER:${user.id}`];
        if (library.scope === KnowledgeLibraryScope.PRIVATE) {
          lockKeys.push('PRIVATE_GLOBAL');
        }
        for (const key of lockKeys) {
          await transaction.knowledgeCapacityCounter.upsert({
            where: { key },
            create: { key },
            update: {},
          });
        }
        await transaction.$queryRaw(
          Prisma.sql`
            SELECT ${Prisma.raw('`key`')} FROM KnowledgeCapacityCounter
            WHERE ${Prisma.raw('`key`')} IN (${Prisma.join(lockKeys)}) FOR UPDATE
          `,
        );
        const lockedCounts = {
          userActive: await transaction.knowledgeImportJob.count({
            where: { createdById: user.id, status: { in: ACTIVE_STATUSES } },
          }),
          totalActive: await transaction.knowledgeImportJob.count({
            where: { status: { in: ACTIVE_STATUSES } },
          }),
          privateActive: await transaction.knowledgeImportJob.count({
            where: {
              status: { in: ACTIVE_STATUSES },
              library: { scope: KnowledgeLibraryScope.PRIVATE },
            },
          }),
          ownPrivateActive: await transaction.knowledgeImportJob.count({
            where: {
              createdById: user.id,
              status: { in: ACTIVE_STATUSES },
              library: { scope: KnowledgeLibraryScope.PRIVATE },
            },
          }),
        };
        assertImportQueueAvailability(limits, library.scope, lockedCounts);
        const created = await transaction.knowledgeImportJob.create({
          data: {
            createdById: user.id,
            libraryId: library.id,
            targetDocumentId: input.targetDocumentId,
            fileType,
            sourceObjectKey: stored!.key,
            sourceName: file.originalname.normalize('NFC').slice(0, 255),
            sourceSize: stored!.size,
            sourceSha256,
            expiresAt: new Date(Date.now() + CONFIRM_TTL_MS),
          },
        });
        await this.audit.record(
          user.id,
          'knowledge.import.create',
          'KnowledgeImportJob',
          created.id,
          { libraryId: library.id, scope: library.scope, fileType, sourceSize: stored!.size },
          transaction,
        );
        return created;
      });
      return serializeJob(job);
    } catch (error) {
      if (stored) await this.storage.remove(stored.key).catch(() => undefined);
      else await this.storage.discardUpload(file);
      throw error;
    }
  }

  async list(user: User, page: number, pageSize: number) {
    const where: Prisma.KnowledgeImportJobWhereInput =
      user.role === Role.MEMBER
        ? { createdById: user.id }
        : {
            OR: [
              { createdById: user.id },
              { library: { scope: KnowledgeLibraryScope.SHARED } },
            ],
          };
    const [items, total] = await Promise.all([
      this.prisma.knowledgeImportJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.knowledgeImportJob.count({ where }),
    ]);
    return { items: items.map(serializeJob), total, page, pageSize };
  }

  async get(user: User, id: string) {
    const job = await this.findAccessible(user, id);
    return serializeJob(job);
  }

  async structure(user: User, id: string, cursor: number, pageSize: number) {
    const job = await this.findAccessible(user, id);
    const summary = asSummary(job.summary);
    const items = summary?.nodes.slice(cursor, cursor + pageSize) ?? [];
    return {
      items,
      nextCursor: cursor + items.length < (summary?.nodes.length ?? 0)
        ? cursor + items.length
        : null,
      total: summary?.nodes.length ?? 0,
      images: cursor === 0 ? summary?.images ?? [] : [],
      titleMarkdown: cursor === 0 ? summary?.titleMarkdown ?? null : null,
      replacement: cursor === 0 ? summary?.replacement ?? null : null,
    };
  }

  async issues(user: User, id: string, page: number, pageSize: number) {
    await this.findAccessible(user, id);
    const where = { importId: id };
    const [items, total] = await Promise.all([
      this.prisma.knowledgeImportIssue.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.knowledgeImportIssue.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async confirm(user: User, id: string) {
    const limits = readKnowledgeLimits();
    const accessible = await this.findAccessible(user, id);
    if (
      ([
        KnowledgeImportStatus.INDEX_PENDING,
        KnowledgeImportStatus.PROCESSING,
        KnowledgeImportStatus.READY,
      ] as KnowledgeImportStatus[]).includes(accessible.status)
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: 'KNOWLEDGE_IMPORT_STATUS_CHANGED',
        message: '任务状态已变化，请刷新后重试',
      });
    }
    if (accessible.status !== KnowledgeImportStatus.AWAITING_CONFIRMATION) {
      throw new BadRequestException('当前任务状态不能确认');
    }
    if (accessible.expiresAt <= new Date()) {
      await this.expire(accessible);
      throw new BadRequestException('预检结果已过期，请重新上传');
    }
    const summary = asSummary(accessible.summary);
    if (!summary || !accessible.title) {
      throw new BadRequestException('预检结果不完整，请重新上传');
    }
    if (
      summary.parserVersion !== KNOWLEDGE_PARSER_VERSION ||
      summary.chunkerVersion !== KNOWLEDGE_CHUNKER_VERSION ||
      summary.renderBlockVersion !== KNOWLEDGE_RENDER_BLOCK_VERSION
    ) {
      throw new BadRequestException('Markdown 解析规则已更新，请重新上传并预检');
    }

    await this.prisma.$transaction(
      async (transaction) => {
        const job = await transaction.knowledgeImportJob.findUniqueOrThrow({
          where: { id },
          include: { library: true },
        });
        if (
          job.status !== KnowledgeImportStatus.AWAITING_CONFIRMATION ||
          job.expiresAt <= new Date()
        ) {
          throw new BadRequestException('任务状态已变化，请刷新后重试');
        }
        if (!job.library.active || job.library.deletedAt) {
          throw new BadRequestException('知识库已停用或删除');
        }
        if (
          job.library.scope === KnowledgeLibraryScope.PRIVATE &&
          !job.library.aiEnabled
        ) {
          throw new BadRequestException('请先明确启用私有知识库的 AI 使用');
        }
        await lockKnowledgeLibrary(transaction, job.libraryId);
        if (summary.replacement.targetDocumentId !== job.targetDocumentId) {
          throw new ConflictException({
            statusCode: 409,
            code: 'H2_REPLACEMENT_CHANGED',
            message: '整份替换目标已变化，请重新上传并预检',
          });
        }
        await assertIncomingH2Target(
          transaction,
          job.libraryId,
          [
            ...new Set(
              summary.nodes
                .filter((node) => node.level === 2)
                .map((node) => normalizeKnowledgeName(node.title)),
            ),
          ],
          job.targetDocumentId,
        );

        const counterKeys = ['GLOBAL'];
        if (job.library.scope === KnowledgeLibraryScope.PRIVATE) {
          counterKeys.push('PRIVATE_GLOBAL', `USER:${user.id}`);
        }
        for (const key of counterKeys) {
          await transaction.knowledgeCapacityCounter.upsert({
            where: { key },
            create: { key },
            update: {},
          });
        }
        await transaction.$queryRaw(
          Prisma.sql`
            SELECT ${Prisma.raw('`key`')} FROM KnowledgeCapacityCounter
            WHERE ${Prisma.raw('`key`')} IN (${Prisma.join(counterKeys)}) FOR UPDATE
          `,
        );
        const counters = await transaction.knowledgeCapacityCounter.findMany({
          where: { key: { in: counterKeys } },
        });
        const global = counters.find((counter) => counter.key === 'GLOBAL')!;
        checkLimit(
          global.activeChunks + global.reservedChunks + job.estimatedChunkCount,
          limits.maxActiveChunks,
          '知识分片总容量已满',
        );
        checkLimit(
          global.livePoints + global.reservedPoints + job.estimatedChunkCount,
          limits.maxLiveQdrantPoints,
          '向量索引容量已满，请先完成旧向量清理',
        );
        if (job.library.scope === KnowledgeLibraryScope.PRIVATE) {
          const privateGlobal = counters.find((counter) => counter.key === 'PRIVATE_GLOBAL')!;
          const own = counters.find((counter) => counter.key === `USER:${user.id}`)!;
          checkLimit(
            privateGlobal.activeChunks + privateGlobal.reservedChunks + job.estimatedChunkCount,
            limits.maxPrivateActiveChunks,
            '私有知识分片总容量已满',
          );
          checkLimit(
            own.activeChunks + own.reservedChunks + job.estimatedChunkCount,
            limits.privateMaxActiveChunksPerUser,
            `个人私有知识分片超过 ${limits.privateMaxActiveChunksPerUser} 限制`,
          );
          checkLimit(
            own.imageCount + own.reservedImages + job.imageCount,
            limits.privateMaxImagesPerUser,
            `个人私有知识图片超过 ${limits.privateMaxImagesPerUser} 张限制`,
          );
          checkLimitBigInt(
            own.mediaBytes + own.reservedMediaBytes + job.processedImageBytes,
            limits.privateMaxMediaBytesPerUser,
            '个人私有知识图片超过媒体容量限制',
          );
        }

        const chapterNames = [
          ...new Set(summary.nodes.map((node) => normalizeKnowledgeName(node.chapterName))),
        ];
        for (let index = 0; index < chapterNames.length; index += 1) {
          const name = chapterNames[index]!;
          await transaction.knowledgeLibraryChapter.upsert({
            where: {
              libraryId_normalizedName: {
                libraryId: job.libraryId,
                normalizedName: name,
              },
            },
            create: {
              id: deterministicUuid('knowledge-library-chapter', job.libraryId, name),
              libraryId: job.libraryId,
              name,
              normalizedName: name,
              slug: `md-${createHash('sha256').update(`${job.libraryId}\0${name}`).digest('hex').slice(0, 32)}`,
              sortOrder: index,
            },
            update: {},
          });
        }

        let documentId = job.targetDocumentId;
        let documentCreated = false;
        let versionNumber: number;
        if (documentId) {
          const document = await transaction.knowledgeDocument.findFirst({
            where: {
              id: documentId,
              libraryId: job.libraryId,
              kind: KnowledgeKind.MARKDOWN,
              deletedAt: null,
            },
            include: { activeVersion: { select: { contentHash: true, imageManifestHash: true } } },
          });
          if (!document) throw new BadRequestException('目标文档不存在');
          if (
            document.activeVersion?.contentHash === summary.contentHash &&
            document.activeVersion.imageManifestHash === summary.imageManifestHash
          ) {
            throw new BadRequestException('上传内容与活动版本完全相同');
          }
          const activeCandidate = await transaction.knowledgeDocumentVersion.count({
            where: {
              documentId,
              indexStatus: { in: [IndexStatus.PENDING, IndexStatus.PROCESSING] },
            },
          });
          if (activeCandidate) throw new BadRequestException('该文档已有候选版本正在处理');
          versionNumber = document.nextVersion;
          await transaction.knowledgeDocument.update({
            where: { id: documentId },
            data: { nextVersion: { increment: 1 } },
          });
        } else {
          if (job.library.scope === KnowledgeLibraryScope.PRIVATE) {
            const documentCount = await transaction.knowledgeDocument.count({
              where: {
                deletedAt: null,
                library: {
                  scope: KnowledgeLibraryScope.PRIVATE,
                  ownerId: user.id,
                },
              },
            });
            if (documentCount >= limits.privateMaxActiveDocumentsPerUser) {
              throw new BadRequestException(
                `每人最多保留 ${limits.privateMaxActiveDocumentsPerUser} 个活动私有文档`,
              );
            }
          }
          const document = await transaction.knowledgeDocument.create({
            data: {
              title: accessible.title!,
              kind: KnowledgeKind.MARKDOWN,
              fileSize: accessible.sourceSize,
              sourceName: accessible.sourceName,
              mimeType:
                accessible.fileType === KnowledgeImportFileType.ZIP
                  ? 'application/zip'
                  : 'text/markdown',
              subjectId: job.library.subjectId,
              libraryId: job.libraryId,
              authorId: user.id,
              nextVersion: 2,
            },
          });
          documentId = document.id;
          documentCreated = true;
          versionNumber = 1;
        }

        const version = await transaction.knowledgeDocumentVersion.create({
          data: {
            documentId,
            version: versionNumber,
            title: accessible.title!,
            titleMarkdown: summary.titleMarkdown,
            markdown: '',
            contentHash: summary.contentHash,
            imageManifestHash: summary.imageManifestHash,
            parserVersion: KNOWLEDGE_PARSER_VERSION,
            chunkerVersion: KNOWLEDGE_CHUNKER_VERSION,
            renderBlockVersion: KNOWLEDGE_RENDER_BLOCK_VERSION,
            embeddingModel: 'embedding-3',
            embeddingDimensions: 1_024,
            nodeCount: job.nodeCount,
            chunkCount: job.estimatedChunkCount,
            imageCount: job.imageCount,
          },
        });

        const queued = await transaction.knowledgeImportJob.updateMany({
          where: {
            id,
            status: KnowledgeImportStatus.AWAITING_CONFIRMATION,
            expiresAt: { gt: new Date() },
          },
          data: {
            targetDocumentId: documentId,
            confirmedById: user.id,
            confirmedAt: new Date(),
            confirmedVersionId: version.id,
            status: KnowledgeImportStatus.INDEX_PENDING,
            stage: 'QUEUED_FOR_INDEX',
            attempts: 0,
            reservedChunks: job.estimatedChunkCount,
            reservedPoints: job.estimatedChunkCount,
            reservedImages: job.imageCount,
            reservedMediaBytes: job.processedImageBytes,
          },
        });
        if (queued.count !== 1) {
          throw new ConflictException({
            statusCode: 409,
            code: 'KNOWLEDGE_IMPORT_STATUS_CHANGED',
            message: '任务状态已变化，请刷新后重试',
          });
        }

        for (const key of counterKeys) {
          await transaction.knowledgeCapacityCounter.update({
            where: { key },
            data: {
              ...(documentCreated
                ? { activeDocuments: { increment: 1 } }
                : {}),
              reservedChunks: { increment: job.estimatedChunkCount },
              reservedPoints: { increment: job.estimatedChunkCount },
              reservedImages: { increment: job.imageCount },
              reservedMediaBytes: { increment: job.processedImageBytes },
            },
          });
        }
        await this.audit.record(
          user.id,
          'knowledge.import.confirm',
          'KnowledgeImportJob',
          id,
          { libraryId: job.libraryId, documentId, versionId: version.id },
          transaction,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 },
    );
    return this.get(user, id);
  }

  async cancel(user: User, id: string) {
    const job = await this.findAccessible(user, id);
    if (([KnowledgeImportStatus.READY, KnowledgeImportStatus.FAILED, KnowledgeImportStatus.COMPENSATION_FAILED, KnowledgeImportStatus.INVALID, KnowledgeImportStatus.EXPIRED] as KnowledgeImportStatus[]).includes(job.status)) {
      return serializeJob(job);
    }
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const terminal = ([
        KnowledgeImportStatus.PREFLIGHT_PENDING,
        KnowledgeImportStatus.PREFLIGHTING,
        KnowledgeImportStatus.AWAITING_CONFIRMATION,
      ] as KnowledgeImportStatus[]).includes(job.status);
      const changed = await transaction.knowledgeImportJob.updateMany({
        where: { id, status: job.status },
        data: terminal
          ? {
              status: KnowledgeImportStatus.EXPIRED,
              stage: 'CANCELLED',
              cancelRequestedAt: now,
              completedAt: now,
              leaseOwnerToken: null,
              leasedUntil: null,
              sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
              sourceCleanupNextAttemptAt: now,
            }
          : { cancelRequestedAt: now },
      });
      if (changed.count !== 1) {
        throw new ConflictException({
          statusCode: 409,
          code: 'KNOWLEDGE_IMPORT_STATUS_CHANGED',
          message: '任务状态已变化，请刷新后重试',
        });
      }
      await this.audit.record(
        user.id,
        'knowledge.import.cancel',
        'KnowledgeImportJob',
        id,
        undefined,
        transaction,
      );
    });
    return this.get(user, id);
  }

  async retryCompensation(user: User, id: string) {
    const job = await this.findAccessible(user, id);
    if (job.status !== KnowledgeImportStatus.COMPENSATION_FAILED) {
      throw new BadRequestException('只有补偿失败任务可以重试清理');
    }
    await this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.knowledgeImportJob.updateMany({
        where: {
          id,
          status: KnowledgeImportStatus.COMPENSATION_FAILED,
        },
        data: {
          status: KnowledgeImportStatus.INDEX_PENDING,
          stage: 'COMPENSATION_RETRY',
          attempts: 0,
          leaseOwnerToken: null,
          leasedUntil: null,
          completedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException({
          statusCode: 409,
          code: 'KNOWLEDGE_IMPORT_STATUS_CHANGED',
          message: '任务状态已变化，请刷新后重试',
        });
      }
      await this.audit.record(
        user.id,
        'knowledge.import.retry-compensation',
        'KnowledgeImportJob',
        id,
        undefined,
        transaction,
      );
    });
    return this.get(user, id);
  }

  private async expire(job: KnowledgeImportJob) {
    await this.prisma.knowledgeImportJob.updateMany({
      where: { id: job.id, status: KnowledgeImportStatus.AWAITING_CONFIRMATION },
      data: {
        status: KnowledgeImportStatus.EXPIRED,
        stage: 'EXPIRED',
        completedAt: new Date(),
        sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
        sourceCleanupNextAttemptAt: new Date(),
      },
    });
  }

  private async findAccessible(user: User, id: string) {
    const job = await this.prisma.knowledgeImportJob.findUnique({
      where: { id },
      include: { library: true },
    });
    if (!job) throw new NotFoundException('知识导入任务不存在');
    if (job.library.scope === KnowledgeLibraryScope.PRIVATE) {
      if (job.library.ownerId !== user.id) {
        throw new ForbiddenException('无权访问该私有导入任务');
      }
    } else if (user.role === Role.MEMBER) {
      throw new ForbiddenException('无权访问共享知识导入任务');
    }
    return job;
  }
}

async function validateFile(file: Express.Multer.File) {
  const limits = readKnowledgeLimits();
  const extension = extname(file.originalname).toLowerCase();
  if (extension !== '.md' && extension !== '.zip') {
    throw new BadRequestException('仅支持 Markdown 或 ZIP 知识包');
  }
  if (extension === '.md' && file.size > limits.importMaxMarkdownBytes) {
    throw new BadRequestException('Markdown 文件超过 10 MiB 限制');
  }
  if (file.size > limits.importMaxZipBytes) {
    throw new BadRequestException('ZIP 文件超过 200 MiB 限制');
  }
  if (extension === '.zip') {
    const handle = await fs.open(file.path, 'r');
    try {
      const signature = Buffer.alloc(4);
      await handle.read(signature, 0, 4, 0);
      if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
        throw new BadRequestException('ZIP 文件签名无效');
      }
    } finally {
      await handle.close();
    }
  }
  return extension === '.zip'
    ? KnowledgeImportFileType.ZIP
    : KnowledgeImportFileType.MARKDOWN;
}

async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function asSummary(value: Prisma.JsonValue | null): PreviewSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as unknown as PreviewSummary;
}

function checkLimit(value: number, maximum: number, message: string) {
  if (value > maximum) throw new BadRequestException(message);
}

function checkLimitBigInt(value: bigint, maximum: bigint, message: string) {
  if (value > maximum) throw new BadRequestException(message);
}

function assertImportQueueAvailability(
  limits: KnowledgeLimits,
  scope: KnowledgeLibraryScope,
  counts: {
    userActive: number;
    totalActive: number;
    privateActive: number;
    ownPrivateActive: number;
  },
) {
  if (counts.userActive >= limits.importUnconfirmedPerUser) {
    throw new BadRequestException(
      `每人最多同时保留 ${limits.importUnconfirmedPerUser} 个未完成导入任务`,
    );
  }
  if (counts.totalActive >= limits.activeImportsGlobal) {
    throw new BadRequestException('当前知识导入队列已满，请稍后重试');
  }
  if (
    scope === KnowledgeLibraryScope.PRIVATE &&
    counts.privateActive >= limits.privateActiveImportsGlobal
  ) {
    throw new BadRequestException('当前私有知识导入队列已满，请稍后重试');
  }
  if (
    scope === KnowledgeLibraryScope.PRIVATE &&
    counts.ownPrivateActive >= limits.privateActiveImportsPerUser
  ) {
    throw new BadRequestException(
      `每人同时只能进行 ${limits.privateActiveImportsPerUser} 个私有知识导入`,
    );
  }
}

function serializeJob(job: KnowledgeImportJob) {
  return {
    id: job.id,
    libraryId: job.libraryId,
    targetDocumentId: job.targetDocumentId,
    fileType: job.fileType,
    sourceName: job.sourceName,
    sourceSize: job.sourceSize,
    status: job.status,
    stage: job.stage,
    progressCurrent: job.progressCurrent,
    progressTotal: job.progressTotal,
    title: job.title,
    nodeCount: job.nodeCount,
    estimatedChunkCount: job.estimatedChunkCount,
    imageCount: job.imageCount,
    processedImageBytes: Number(job.processedImageBytes),
    warningCount: job.warningCount,
    errorCount: job.errorCount,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    sourceCleanupStatus: job.sourceCleanupStatus,
    sourceCleanupAttempts: job.sourceCleanupAttempts,
    sourceCleanupNextAttemptAt:
      job.sourceCleanupNextAttemptAt?.toISOString() ?? null,
    sourceCleanupError: job.sourceCleanupError,
    sourceCleanedAt: job.sourceCleanedAt?.toISOString() ?? null,
    cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
    confirmedVersionId: job.confirmedVersionId,
    expiresAt: job.expiresAt.toISOString(),
    confirmedAt: job.confirmedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
