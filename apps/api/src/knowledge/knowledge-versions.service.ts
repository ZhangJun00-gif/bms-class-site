import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ContentStatus,
  IndexStatus,
  KnowledgeIndexOperation,
  KnowledgeKind,
  KnowledgeLibraryScope,
  KnowledgeRenderStatus,
  Prisma,
  type User,
} from '@prisma/client';
import {
  KNOWLEDGE_CHUNKER_VERSION,
  KNOWLEDGE_PARSER_VERSION,
  KNOWLEDGE_RENDER_BLOCK_VERSION,
  parseKnowledgeMarkdown,
} from '@bmc3/knowledge-core';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { markQuestionSourcesReviewRequired } from '../quiz/question-source-lifecycle';
import { KnowledgeAccessService } from './knowledge-access.service';
import {
  assertCandidateH2Unique,
  lockKnowledgeLibrary,
} from './knowledge-h2';
import { readKnowledgeLimits } from './knowledge-limits';
import { KnowledgeVectorService } from './knowledge-vector.service';

function versionActivityKey(documentId: string) {
  return `sync-version-activity:${documentId}`;
}

@Injectable()
export class KnowledgeVersionsService {
  private readonly logger = new Logger(KnowledgeVersionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: KnowledgeAccessService,
    private readonly vectors: KnowledgeVectorService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async listDocuments(user: User, libraryId: string) {
    await this.access.getAccessible(user, libraryId);
    const items = await this.prisma.knowledgeDocument.findMany({
      where: { libraryId, deletedAt: null },
      select: {
        id: true,
        title: true,
        kind: true,
        status: true,
        activeVersionId: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { versions: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return { items, total: items.length };
  }

  async listVersions(user: User, documentId: string) {
    const document = await this.documentForRead(user, documentId);
    const items = await this.prisma.knowledgeDocumentVersion.findMany({
      where: { documentId },
      select: {
        id: true,
        version: true,
        origin: true,
        title: true,
        titleMarkdown: true,
        contentHash: true,
        imageManifestHash: true,
        indexStatus: true,
        nodeCount: true,
        chunkCount: true,
        vectorCount: true,
        imageCount: true,
        renderStatus: true,
        renderBlockVersion: true,
        renderBlockCount: true,
        mathCount: true,
        renderError: true,
        error: true,
        indexedAt: true,
        activatedAt: true,
        retiredAt: true,
        createdAt: true,
      },
      orderBy: { version: 'desc' },
    });
    return { documentId, activeVersionId: document.activeVersionId, items };
  }

  async tree(user: User, documentId: string, requestedVersionId?: string) {
    const document = await this.documentForRead(user, documentId);
    const versionId = requestedVersionId ?? document.activeVersionId;
    if (!versionId) throw new NotFoundException('文档尚无活动版本');
    const version = await this.prisma.knowledgeDocumentVersion.findFirst({
      where: { id: versionId, documentId },
      select: {
        id: true,
        version: true,
        title: true,
        indexStatus: true,
        nodes: {
          select: {
            id: true,
            parentId: true,
            level: true,
            title: true,
            titleMarkdown: true,
            path: true,
            breadcrumb: true,
            sortOrder: true,
            libraryChapterId: true,
            _count: { select: { chunks: true, imageReferences: true } },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!version) throw new NotFoundException('知识版本不存在');
    return version;
  }

  async publish(user: User, documentId: string, versionId: string) {
    const document = await this.documentForManage(user, documentId);
    const version = await this.prisma.knowledgeDocumentVersion.findFirst({
      where: {
        id: versionId,
        documentId,
        indexStatus: IndexStatus.READY,
        renderStatus: KnowledgeRenderStatus.READY,
      },
    });
    if (!version) {
      throw new BadRequestException('只能发布已完成索引和阅读块生成的版本');
    }
    await this.vectors.setVersionActive(versionId, true);
    if (document.activeVersionId === versionId) {
      await this.queueVersionActivityReconciliation(documentId);
      return {
        documentId,
        activeVersionId: versionId,
        published: true as const,
        vectorSyncPending: true as const,
      };
    }
    const oldVersionId = document.activeVersionId;
    try {
      await this.prisma.$transaction(
        async (transaction) => {
          await lockKnowledgeLibrary(transaction, document.libraryId);
          const current = await transaction.knowledgeDocument.findUniqueOrThrow({
            where: { id: documentId },
          });
          if (current.activeVersionId !== oldVersionId || current.deletedAt) {
            throw new ConflictException({
              statusCode: 409,
              code: 'KNOWLEDGE_VERSION_STATUS_CHANGED',
              message: '文档活动版本已变化，请刷新后重试',
            });
          }
          const candidate = await transaction.knowledgeDocumentVersion.findFirst({
            where: {
              id: versionId,
              documentId,
              indexStatus: IndexStatus.READY,
              renderStatus: KnowledgeRenderStatus.READY,
            },
          });
          if (!candidate) {
            throw new ConflictException({
              statusCode: 409,
              code: 'KNOWLEDGE_VERSION_STATUS_CHANGED',
              message: '待发布版本状态已变化，请刷新后重试',
            });
          }
          await assertCandidateH2Unique(
            transaction,
            document.libraryId,
            documentId,
            versionId,
          );
          if (oldVersionId) {
            await transaction.knowledgeDocumentVersion.update({
              where: { id: oldVersionId },
              data: { retiredAt: new Date() },
            });
          }
          await transaction.knowledgeDocumentVersion.update({
            where: { id: versionId },
            data: { activatedAt: new Date(), retiredAt: null },
          });
          await transaction.knowledgeDocument.update({
            where: { id: documentId },
            data: {
              activeVersionId: versionId,
              title: version.title,
              status: ContentStatus.PUBLISHED,
              indexStatus: IndexStatus.READY,
              publishedAt: new Date(),
            },
          });
          if (oldVersionId) {
            await markQuestionSourcesReviewRequired(transaction, {
              documentVersionId: oldVersionId,
            });
          }
          await transaction.indexJob.upsert({
            where: { idempotencyKey: versionActivityKey(documentId) },
            create: {
              documentId,
              documentVersionId: versionId,
              operation: KnowledgeIndexOperation.SYNC_VERSION_ACTIVITY,
              idempotencyKey: versionActivityKey(documentId),
              stage: 'QUEUED',
            },
            update: {
              documentVersionId: versionId,
              status: IndexStatus.PENDING,
              stage: 'QUEUED',
              attempts: 0,
              leaseOwnerToken: null,
              leasedUntil: null,
              error: null,
            },
          });
          await this.audit.record(
            user.id,
            'knowledge.version.publish',
            'KnowledgeDocumentVersion',
            versionId,
            { documentId, previousVersionId: oldVersionId },
            transaction,
          );
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000,
        },
      );
    } catch (error) {
      await this.queueVersionActivityReconciliation(documentId).catch(
        (reconciliationError) => {
          this.logger.error(
            JSON.stringify({
              event: 'knowledge.version-activity-reconciliation-queue-failed',
              documentId,
              message:
                reconciliationError instanceof Error
                  ? reconciliationError.message
                  : String(reconciliationError),
            }),
          );
        },
      );
      throw error;
    }
    return {
      documentId,
      activeVersionId: versionId,
      published: true as const,
      vectorSyncPending: true as const,
    };
  }

  async rebuild(user: User, documentId: string) {
    const limits = readKnowledgeLimits();
    const document = await this.documentForManage(user, documentId);
    if (document.kind !== KnowledgeKind.MARKDOWN || !document.activeVersionId) {
      throw new BadRequestException('只有已发布 Markdown 文档可以重建索引');
    }
    const result = await this.prisma.$transaction(
      async (transaction) => {
        const current = await transaction.knowledgeDocument.findUniqueOrThrow({
          where: { id: documentId },
          include: { activeVersion: true, library: true },
        });
        if (!current.activeVersion) throw new BadRequestException('活动版本不存在');
        const parsed = parseKnowledgeMarkdown(current.activeVersion.markdown, {
          allowImages: current.activeVersion.imageCount > 0,
        });
        if (parsed.issues.some((issue) => issue.severity === 'ERROR')) {
          throw new BadRequestException('活动版本不符合当前 Markdown/公式合同');
        }
        const pending = await transaction.knowledgeDocumentVersion.count({
          where: {
            documentId,
            indexStatus: { in: [IndexStatus.PENDING, IndexStatus.PROCESSING] },
          },
        });
        if (pending) throw new BadRequestException('已有候选版本正在处理');
        const counterKeys = ['GLOBAL'];
        if (current.library.scope === KnowledgeLibraryScope.PRIVATE) {
          counterKeys.push('PRIVATE_GLOBAL', `USER:${current.library.ownerId}`);
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
        if (
          global.activeChunks + global.reservedChunks +
            parsed.chunkCount >
          limits.maxActiveChunks
        ) {
          throw new BadRequestException('知识分片总容量已满');
        }
        if (
          global.livePoints + global.reservedPoints +
            parsed.chunkCount >
          limits.maxLiveQdrantPoints
        ) {
          throw new BadRequestException('向量索引容量已满');
        }
        if (current.library.scope === KnowledgeLibraryScope.PRIVATE) {
          const privateGlobal = counters.find(
            (counter) => counter.key === 'PRIVATE_GLOBAL',
          )!;
          const own = counters.find(
            (counter) => counter.key === `USER:${current.library.ownerId}`,
          )!;
          if (
            privateGlobal.activeChunks + privateGlobal.reservedChunks +
              parsed.chunkCount >
            limits.maxPrivateActiveChunks
          ) {
            throw new BadRequestException('私有知识分片总容量已满');
          }
          if (
            own.activeChunks + own.reservedChunks +
              parsed.chunkCount >
            limits.privateMaxActiveChunksPerUser
          ) {
            throw new BadRequestException('个人私有知识分片超过限制');
          }
        }
        const versionNumber = current.nextVersion;
        const version = await transaction.knowledgeDocumentVersion.create({
          data: {
            documentId,
            version: versionNumber,
            origin: 'REINDEX',
            title: parsed.title,
            titleMarkdown: parsed.titleMarkdown,
            markdown: parsed.markdown,
            contentHash: parsed.contentHash,
            imageManifestHash: parsed.imageManifestHash,
            parserVersion: KNOWLEDGE_PARSER_VERSION,
            chunkerVersion: KNOWLEDGE_CHUNKER_VERSION,
            renderBlockVersion: KNOWLEDGE_RENDER_BLOCK_VERSION,
            embeddingModel: current.activeVersion.embeddingModel,
            embeddingDimensions: current.activeVersion.embeddingDimensions,
            nodeCount: parsed.nodes.length,
            chunkCount: parsed.chunkCount,
            imageCount: current.activeVersion.imageCount,
          },
        });
        await transaction.knowledgeDocument.update({
          where: { id: documentId },
          data: { nextVersion: { increment: 1 } },
        });
        const job = await transaction.indexJob.create({
          data: {
            documentId,
            documentVersionId: version.id,
            operation: KnowledgeIndexOperation.INDEX_VERSION,
            idempotencyKey: `index-version:${version.id}`,
            stage: 'CAPACITY_RESERVED',
            progressTotal: version.chunkCount,
          },
        });
        await this.audit.record(
          user.id,
          'knowledge.version.rebuild',
          'KnowledgeDocumentVersion',
          version.id,
          { documentId, sourceVersionId: current.activeVersion.id, jobId: job.id },
          transaction,
        );
        for (const key of counterKeys) {
          await transaction.knowledgeCapacityCounter.update({
            where: { key },
            data: {
              reservedChunks: { increment: version.chunkCount },
              reservedPoints: { increment: version.chunkCount },
            },
          });
        }
        return { versionId: version.id, version: version.version, jobId: job.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { documentId, ...result, indexStatus: IndexStatus.PENDING };
  }

  async removeVersion(user: User, documentId: string, versionId: string) {
    const document = await this.documentForManage(user, documentId);
    if (document.activeVersionId === versionId) {
      throw new BadRequestException('活动版本不能直接删除');
    }
    const version = await this.prisma.knowledgeDocumentVersion.findFirst({
      where: { id: versionId, documentId },
      select: { id: true },
    });
    if (!version) throw new NotFoundException('知识版本不存在');
    await this.prisma.$transaction(async (transaction) => {
      await markQuestionSourcesReviewRequired(transaction, {
        documentVersionId: versionId,
      });
      await transaction.indexJob.upsert({
        where: { idempotencyKey: `delete-version:${versionId}` },
        create: {
          documentId,
          documentVersionId: versionId,
          operation: KnowledgeIndexOperation.DELETE_VERSION_VECTORS,
          idempotencyKey: `delete-version:${versionId}`,
        },
        update: {
          status: IndexStatus.PENDING,
          leaseOwnerToken: null,
          leasedUntil: null,
          error: null,
        },
      });
      await this.audit.record(
        user.id,
        'knowledge.version.delete-request',
        'KnowledgeDocumentVersion',
        versionId,
        { documentId },
        transaction,
      );
    });
    return { documentId, versionId, cleanupPending: true as const };
  }

  async removeDocument(user: User, documentId: string) {
    const document = await this.prisma.knowledgeDocument.findUnique({
      where: { id: documentId },
      include: { library: true },
    });
    if (!document) throw new NotFoundException('知识文档不存在');
    await this.access.assertManage(user, document.libraryId);
    const now = new Date();
    const cleanupJob = document.deletedAt
      ? await this.prisma.indexJob.findUnique({
          where: { idempotencyKey: `delete-document:${documentId}` },
        })
      : await this.prisma.$transaction(async (transaction) => {
          await markQuestionSourcesReviewRequired(transaction, { documentId });
          await transaction.knowledgeDocument.update({
            where: { id: documentId },
            data: {
              activeVersionId: null,
              status: ContentStatus.ARCHIVED,
              body: null,
              deletedAt: now,
            },
          });
          await transaction.knowledgeImportJob.updateMany({
            where: {
              targetDocumentId: documentId,
              status: {
                in: [
                  'PREFLIGHT_PENDING',
                  'PREFLIGHTING',
                  'AWAITING_CONFIRMATION',
                  'INDEX_PENDING',
                  'PROCESSING',
                ],
              },
            },
            data: {
              cancelRequestedAt: now,
              expiresAt: now,
              errorCode: 'DOCUMENT_DELETED',
              errorMessage: '知识文档已删除',
            },
          });
          const queued = await transaction.indexJob.upsert({
            where: { idempotencyKey: `delete-document:${documentId}` },
            create: {
              documentId,
              operation: KnowledgeIndexOperation.DELETE_DOCUMENT_VECTORS,
              idempotencyKey: `delete-document:${documentId}`,
            },
            update: {
              status: IndexStatus.PENDING,
              stage: 'QUEUED',
              leaseOwnerToken: null,
              leasedUntil: null,
              error: null,
            },
          });
          await this.audit.record(
            user.id,
            'knowledge.document.delete-request',
            'KnowledgeDocument',
            documentId,
            { libraryId: document.libraryId },
            transaction,
          );
          return queued;
        });
    let storageDeleted = true;
    if (document.objectKey) {
      try {
        await this.storage.remove(document.objectKey);
        await this.prisma.knowledgeDocument.updateMany({
          where: { id: documentId, objectKey: document.objectKey },
          data: { objectKey: null },
        });
      } catch (error) {
        storageDeleted = false;
        this.logger.error(
          JSON.stringify({
            event: 'knowledge.orphan-object',
            documentId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return {
      documentId,
      deleted: true as const,
      cleanupPending: Boolean(cleanupJob),
      cleanupJobId: cleanupJob?.id ?? null,
      storageDeleted,
      storageCleanupPending: !storageDeleted,
    };
  }

  async retryCleanup(user: User, jobId: string) {
    const job = await this.prisma.indexJob.findUnique({
      where: { id: jobId },
      include: { document: { include: { library: true } } },
    });
    if (
      !job ||
      (job.operation !== KnowledgeIndexOperation.DELETE_VERSION_VECTORS &&
        job.operation !== KnowledgeIndexOperation.DELETE_DOCUMENT_VECTORS)
    ) {
      throw new NotFoundException('知识清理任务不存在');
    }
    if (job.document.library.scope === KnowledgeLibraryScope.PRIVATE) {
      if (job.document.library.ownerId !== user.id) {
        throw new ForbiddenException('无权重试该私有知识清理任务');
      }
    } else if (user.role === 'MEMBER') {
      throw new ForbiddenException('普通成员不能重试共享知识清理任务');
    }
    if (job.status !== IndexStatus.FAILED) {
      throw new BadRequestException('只有失败的知识清理任务可以重试');
    }
    const changed = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.indexJob.updateMany({
        where: { id: jobId, status: IndexStatus.FAILED },
        data: {
          status: IndexStatus.PENDING,
          stage: 'QUEUED',
          attempts: 0,
          leaseOwnerToken: null,
          leasedUntil: null,
          error: null,
        },
      });
      if (result.count !== 1) {
        throw new BadRequestException('清理任务状态已变化，请刷新后重试');
      }
      await this.audit.record(
        user.id,
        'knowledge.cleanup.retry',
        'IndexJob',
        jobId,
        { operation: job.operation, documentId: job.documentId },
        transaction,
      );
      return result;
    });
    return { jobId, queued: changed.count === 1 };
  }

  private async queueVersionActivityReconciliation(documentId: string) {
    const current = await this.prisma.knowledgeDocument.findUnique({
      where: { id: documentId },
      select: { activeVersionId: true },
    });
    if (!current) return;
    await this.prisma.indexJob.upsert({
      where: { idempotencyKey: versionActivityKey(documentId) },
      create: {
        documentId,
        documentVersionId: current.activeVersionId,
        operation: KnowledgeIndexOperation.SYNC_VERSION_ACTIVITY,
        idempotencyKey: versionActivityKey(documentId),
        stage: 'QUEUED',
      },
      update: {
        documentVersionId: current.activeVersionId,
        status: IndexStatus.PENDING,
        stage: 'QUEUED',
        attempts: 0,
        leaseOwnerToken: null,
        leasedUntil: null,
        error: null,
      },
    });
  }

  private async documentForRead(user: User, documentId: string) {
    const document = await this.prisma.knowledgeDocument.findFirst({
      where: { id: documentId, deletedAt: null },
      include: { library: true },
    });
    if (!document) throw new NotFoundException('知识文档不存在');
    await this.access.getAccessible(user, document.libraryId);
    if (
      document.library.scope === KnowledgeLibraryScope.SHARED &&
      document.status !== ContentStatus.PUBLISHED &&
      user.role === 'MEMBER'
    ) {
      throw new NotFoundException('知识文档不存在');
    }
    return document;
  }

  private async documentForManage(user: User, documentId: string) {
    const document = await this.prisma.knowledgeDocument.findFirst({
      where: { id: documentId, deletedAt: null },
      include: { library: true },
    });
    if (!document) throw new NotFoundException('知识文档不存在');
    await this.access.assertManage(user, document.libraryId);
    return document;
  }
}
