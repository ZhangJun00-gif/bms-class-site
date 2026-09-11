import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  CreditHourDecisionSource,
  CreditHourReviewJobStatus,
  CreditHourSubmissionStatus,
  CreditHourType,
  Prisma,
  Role,
  type User,
} from '@prisma/client';
import {
  inspectImage,
  type SupportedImageFormat,
} from '@bmc3/media-core';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../common/audit.service';
import {
  decodeKeysetCursor,
  decodeTimeIdCursor,
  encodeKeysetCursor,
  encodeTimeIdCursor,
} from '../common/keyset-cursor';
import { PrismaService } from '../database/prisma.service';
import { MediaStorageService } from '../media/media-storage.service';
import { ImageProcessingService } from '../media/image-processing.service';
import { CreditHourStorageRecoveryService, type UploadLease } from './credit-hour-storage-recovery.service';
import { serializeManualReview } from './credit-hour-manual-review';
import {
  AdminCreditHourActionDto,
  AdminCreditHourCreateDto,
  AdminCreditHourDecisionDto,
  AdminCreditHourPageQuery,
  CreditHourLeaderboardQuery,
  CREDIT_HOUR_MAX_HOURS,
  CREDIT_HOUR_MIN_HOURS,
  CreditHourPageQuery,
  CreditHourSubmissionDto,
} from './credit-hours.dto';

const SUBMISSION_INCLUDE = {
  user: { select: { id: true, displayName: true } },
  revisions: {
    orderBy: { revision: 'desc' as const },
    take: 1,
    select: {
      id: true,
      revision: true,
      activityName: true,
      halfHours: true,
      sourceDescription: true,
      evidence: {
        orderBy: { sortOrder: 'asc' as const },
        select: {
          id: true,
          sortOrder: true,
          originalMimeType: true,
          originalSize: true,
          originalWidth: true,
          originalHeight: true,
          displayMimeType: true,
          displaySize: true,
          displayWidth: true,
          displayHeight: true,
        },
      },
    },
  },
  reviewJobs: {
    orderBy: { reviewCycle: 'desc' as const },
    take: 1,
    select: {
      id: true,
      reviewCycle: true,
      status: true,
      attempts: true,
      errorCategory: true,
      errorMessage: true,
      completedAt: true,
      updatedAt: true,
      reviewAttempts: {
        orderBy: { attempt: 'desc' as const },
        take: 1,
        select: {
          attempt: true,
          decision: true,
          userReason: true,
          riskCodes: true,
          completedAt: true,
          errorCategory: true,
        },
      },
    },
  },
} as const;

type SubmissionWithDetail = Prisma.CreditHourSubmissionGetPayload<{
  include: typeof SUBMISSION_INCLUDE;
}>;

interface PreparedEvidence {
  sortOrder: number;
  original: Buffer;
  originalMimeType: string;
  originalExtension: SupportedImageFormat;
  originalSize: number;
  originalWidth: number;
  originalHeight: number;
  originalSha256: string;
  display: Buffer;
  displaySize: number;
  displayWidth: number;
  displayHeight: number;
  originalObjectKey: string | null;
  displayObjectKey: string | null;
}

@Injectable()
export class CreditHoursService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorageService,
    private readonly audit: AuditService,
    private readonly imageProcessing: ImageProcessingService,
    private readonly recovery: CreditHourStorageRecoveryService,
  ) {}

  async createSubmission(
    user: User,
    idempotencyKey: string,
    dto: CreditHourSubmissionDto,
    files: Express.Multer.File[],
  ) {
    const normalized = this.normalizeSubmission(idempotencyKey, dto, files);
    const inspected = await Promise.all(
      files.map(async (file, sortOrder) => {
        const metadata = await this.inspectUpload(file.buffer);
        return {
          sortOrder,
          original: file.buffer,
          originalMimeType: mimeForFormat(metadata.format),
          originalExtension: metadata.format,
          originalSize: file.buffer.length,
          originalWidth: metadata.width,
          originalHeight: metadata.height,
          originalSha256: sha256(file.buffer),
        };
      }),
    );
    if (new Set(inspected.map((item) => item.originalSha256)).size !== inspected.length) {
      throw new BadRequestException('同一次提交不能包含内容完全相同的凭证');
    }
    const requestHash = hashSubmission(normalized, inspected);
    const existing = await this.prisma.creditHourSubmission.findUnique({
      where: {
        userId_idempotencyKey: { userId: user.id, idempotencyKey },
      },
      include: SUBMISSION_INCLUDE,
    });
    if (existing) return this.idempotentResult(existing, requestHash);

    if (dto.replacesSubmissionId) {
      const replaced = await this.prisma.creditHourSubmission.findFirst({
        where: {
          id: dto.replacesSubmissionId,
          userId: user.id,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!replaced) throw new BadRequestException('被替代的提交不存在或不属于当前用户');
    }

    const now = new Date();
    const prepared: PreparedEvidence[] = [];
    let uploadLease: UploadLease | null = null;
    try {
      for (const item of inspected) {
        const display = await this.imageProcessing.compress(item.original);
        const objectId = randomUUID();
        const originalObjectKey = this.storage.usesCos()
          ? creditHourObjectKey(now, 'original', objectId, item.originalExtension)
          : null;
        const displayObjectKey = this.storage.usesCos()
          ? creditHourObjectKey(now, 'display', objectId, 'webp')
          : null;
        prepared.push({
          ...item,
          display: display.data,
          displaySize: display.size,
          displayWidth: display.width,
          displayHeight: display.height,
          originalObjectKey,
          displayObjectKey,
        });
      }

      if (this.storage.usesCos()) {
        uploadLease = await this.recovery.beginUpload(
          user.id,
          idempotencyKey,
          requestHash,
          prepared.flatMap((item) => [item.originalObjectKey!, item.displayObjectKey!]),
        );
        for (const item of prepared) {
          await this.recovery.renewUpload(uploadLease);
          await this.storage.upload(item.original, item.originalObjectKey!, item.originalMimeType);
          await this.recovery.renewUpload(uploadLease);
          await this.storage.upload(item.display, item.displayObjectKey!, 'image/webp');
          await this.recovery.renewUpload(uploadLease);
        }
      }

      const created = await this.prisma.$transaction(
        async (transaction) => {
          if (uploadLease) await this.recovery.commitUpload(transaction, uploadLease);
          const submission = await transaction.creditHourSubmission.create({
            data: {
              userId: user.id,
              type: normalized.type,
              idempotencyKey,
              requestHash,
              replacesSubmissionId: normalized.replacesSubmissionId,
              revisions: {
                create: {
                  revision: 1,
                  activityName: normalized.activityName,
                  halfHours: normalized.halfHours,
                  sourceDescription: normalized.sourceDescription,
                  requestHash,
                  evidence: {
                    create: prepared.map((item) => ({
                      sortOrder: item.sortOrder,
                      originalObjectKey: item.originalObjectKey,
                      originalData: this.storage.usesCos()
                        ? null
                        : Uint8Array.from(item.original),
                      originalMimeType: item.originalMimeType,
                      originalSize: item.originalSize,
                      originalWidth: item.originalWidth,
                      originalHeight: item.originalHeight,
                      originalSha256: item.originalSha256,
                      displayObjectKey: item.displayObjectKey,
                      displayData: this.storage.usesCos()
                        ? null
                        : Uint8Array.from(item.display),
                      displaySize: item.displaySize,
                      displayWidth: item.displayWidth,
                      displayHeight: item.displayHeight,
                    })),
                  },
                },
              },
              reviewJobs: {
                create: {
                  reviewCycle: 1,
                  contentRevision: 1,
                  generation: 1,
                },
              },
            },
            include: SUBMISSION_INCLUDE,
          });
          await this.audit.record(
            user.id,
            'credit-hour.submit',
            'CreditHourSubmission',
            submission.id,
            {
              type: normalized.type,
              halfHours: normalized.halfHours,
              evidenceCount: prepared.length,
            },
            transaction,
          );
          return submission;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return this.serializeSubmission(created, true);
    } catch (error) {
      if (uploadLease) await this.recovery.compensateUpload(uploadLease);
      if (isUniqueConflict(error)) {
        const winner = await this.prisma.creditHourSubmission.findUnique({
          where: {
            userId_idempotencyKey: { userId: user.id, idempotencyKey },
          },
          include: SUBMISSION_INCLUDE,
        });
        if (winner) return this.idempotentResult(winner, requestHash);
      }
      throw error;
    }
  }

  async createAdminSubmission(
    actor: User,
    idempotencyKey: string,
    dto: AdminCreditHourCreateDto,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 191) {
      throw new BadRequestException('Idempotency-Key 必须为 1-191 个字符');
    }
    if (dto.userId === actor.id) {
      throw new ForbiddenException('管理员不能通过此入口为自己录入学时');
    }
    const activityName = dto.activityName.trim();
    const sourceDescription = dto.description.trim();
    const halfHours = halfHoursFor(dto.hours);
    if (!activityName || !sourceDescription) {
      throw new BadRequestException('活动名称和描述不能为空');
    }
    const requestHash = hashAdminSubmission({
      actorId: actor.id,
      userId: dto.userId,
      type: dto.type,
      activityName,
      halfHours,
      sourceDescription,
    });
    const existing = await this.prisma.creditHourSubmission.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: dto.userId,
          idempotencyKey,
        },
      },
      include: SUBMISSION_INCLUDE,
    });
    if (existing) return this.idempotentResult(existing, requestHash);

    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const target = await transaction.user.findUnique({
            where: { id: dto.userId },
            select: { id: true, status: true },
          });
          if (!target) throw new NotFoundException('目标用户不存在');
          if (target.status !== AccountStatus.ACTIVE) {
            throw new BadRequestException('只能为正常状态的用户录入学时');
          }
          const now = new Date();
          const submission = await transaction.creditHourSubmission.create({
            data: {
              userId: target.id,
              type: dto.type,
              status: CreditHourSubmissionStatus.APPROVED,
              idempotencyKey,
              requestHash,
              decisionSource: CreditHourDecisionSource.ADMIN_CREATED,
              decisionReason: '管理员直接录入，无需 AI 审核',
              decidedAt: now,
              revisions: {
                create: {
                  revision: 1,
                  activityName,
                  halfHours,
                  sourceDescription,
                  requestHash,
                },
              },
              decisionEvents: {
                create: {
                  reviewCycle: 1,
                  contentRevision: 1,
                  source: CreditHourDecisionSource.ADMIN_CREATED,
                  actorId: actor.id,
                  fromStatus: CreditHourSubmissionStatus.PENDING_REVIEW,
                  toStatus: CreditHourSubmissionStatus.APPROVED,
                  reason: '管理员直接录入，无需 AI 审核',
                },
              },
            },
            include: SUBMISSION_INCLUDE,
          });
          await this.audit.record(
            actor.id,
            'credit-hour.admin-create',
            'CreditHourSubmission',
            submission.id,
            {
              targetUserId: target.id,
              type: dto.type,
              halfHours,
            },
            transaction,
          );
          return this.serializeSubmission(submission, true, true);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isUniqueConflict(error)) {
        const winner = await this.prisma.creditHourSubmission.findUnique({
          where: {
            userId_idempotencyKey: {
              userId: dto.userId,
              idempotencyKey,
            },
          },
          include: SUBMISSION_INCLUDE,
        });
        if (winner) return this.idempotentResult(winner, requestHash);
      }
      throw error;
    }
  }

  async listMine(userId: string, query: CreditHourPageQuery) {
    return this.listSubmissions(
      { userId, deletedAt: null, type: query.type, status: query.status },
      query,
      true,
    );
  }

  async getMine(userId: string, id: string) {
    const item = await this.prisma.creditHourSubmission.findFirst({
      where: { id, userId, deletedAt: null },
      include: SUBMISSION_INCLUDE,
    });
    if (!item) throw new NotFoundException('学时记录不存在');
    return this.serializeSubmission(item, true);
  }

  async withdraw(user: User, id: string, expectedRevision: number) {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.creditHourSubmission.findFirst({
        where: { id, userId: user.id, deletedAt: null },
      });
      if (!current) throw new NotFoundException('学时记录不存在');
      const claimed = await transaction.creditHourSubmission.updateMany({
        where: {
          id,
          userId: user.id,
          deletedAt: null,
          revision: expectedRevision,
          status: { in: [CreditHourSubmissionStatus.PENDING_REVIEW, CreditHourSubmissionStatus.PENDING_MANUAL_REVIEW] },
        },
        data: {
          status: CreditHourSubmissionStatus.WITHDRAWN,
          revision: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        const latest = await transaction.creditHourSubmission.findUnique({
          where: { id },
          select: { revision: true },
        });
        throw revisionConflict(latest?.revision ?? current.revision);
      }
      const now = new Date();
      await transaction.creditHourReviewJob.updateMany({
        where: {
          submissionId: id,
          status: {
            in: [
              CreditHourReviewJobStatus.PENDING,
              CreditHourReviewJobStatus.RETRY_PENDING,
              CreditHourReviewJobStatus.RUNNING,
            ],
          },
        },
        data: {
          status: CreditHourReviewJobStatus.CANCELLED,
          leaseOwnerToken: null,
          leasedUntil: null,
          completedAt: now,
        },
      });
      await transaction.creditHourDecisionEvent.create({
        data: {
          submissionId: id,
          reviewCycle: current.currentReviewCycle,
          contentRevision: 1,
          actorId: user.id,
          fromStatus: current.status,
          toStatus: CreditHourSubmissionStatus.WITHDRAWN,
          reason: '用户撤回',
        },
      });
      await this.audit.record(
        user.id,
        'credit-hour.withdraw',
        'CreditHourSubmission',
        id,
        undefined,
        transaction,
      );
      const updated = await transaction.creditHourSubmission.findUniqueOrThrow({
        where: { id },
        include: SUBMISSION_INCLUDE,
      });
      return this.serializeSubmission(updated, true);
    });
  }

  async summary(userId: string) {
    const rows = await this.prisma.creditHourSubmission.findMany({
      where: {
        userId,
        status: CreditHourSubmissionStatus.APPROVED,
        deletedAt: null,
      },
      select: {
        type: true,
        revisions: {
          orderBy: { revision: 'desc' },
          take: 1,
          select: { halfHours: true },
        },
      },
    });
    const totals = totalsFor(rows);
    const statusCounts = await this.prisma.creditHourSubmission.groupBy({
      by: ['type', 'status'],
      where: { userId, deletedAt: null },
      _count: { _all: true },
    });
    return {
      qualityHours: hours(totals.QUALITY),
      volunteerHours: hours(totals.VOLUNTEER),
      totalHours: hours(totals.QUALITY + totals.VOLUNTEER),
      statusCounts: Object.fromEntries(
        statusCounts.map((item) => [
          `${item.type}:${item.status}`,
          item._count._all,
        ]),
      ),
    };
  }

  async leaderboard(currentUserId: string, query: CreditHourLeaderboardQuery) {
    const withRank = await this.activeUserTotals(query.type);
    const cursor = query.cursor ? readLeaderboardCursor(query.cursor) : null;
    const remaining = cursor
      ? withRank.filter(
          (item) =>
            item.selected < cursor.halfHours ||
            (item.selected === cursor.halfHours && item.id > cursor.userId),
        )
      : withRank;
    const page = remaining.slice(0, query.pageSize + 1);
    const hasMore = page.length > query.pageSize;
    const items = page.slice(0, query.pageSize);
    const last = items.at(-1);
    return {
      type: query.type,
      items: items.map((item) => ({
        userId: item.id,
        displayName: item.displayName,
        qualityHours: hours(item.totals.QUALITY),
        volunteerHours: hours(item.totals.VOLUNTEER),
        totalHours: hours(item.totals.QUALITY + item.totals.VOLUNTEER),
        rank: item.rank,
        currentUser: item.id === currentUserId,
      })),
      nextCursor:
        hasMore && last
          ? encodeKeysetCursor({
              halfHours: last.selected,
              userId: last.id,
            })
          : null,
    };
  }

  async publicSubmissions(userId: string, query: CreditHourPageQuery) {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, status: AccountStatus.ACTIVE },
      select: { id: true, displayName: true },
    });
    if (!target) throw new NotFoundException('用户不存在或当前不可公示');
    const cursor = query.cursor ? decodeTimeIdCursor(query.cursor) : null;
    const rows = await this.prisma.creditHourSubmission.findMany({
      where: {
        userId,
        type: query.type,
        status: CreditHourSubmissionStatus.APPROVED,
        deletedAt: null,
        ...(cursor
          ? {
              OR: [
                { decidedAt: { lt: cursor.timestamp } },
                { decidedAt: cursor.timestamp, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        type: true,
        decidedAt: true,
        revisions: {
          orderBy: { revision: 'desc' },
          take: 1,
          select: { activityName: true, halfHours: true },
        },
      },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: query.pageSize + 1,
    });
    const hasMore = rows.length > query.pageSize;
    const page = rows.slice(0, query.pageSize);
    const last = page.at(-1);
    return {
      user: target,
      items: page.map((item) => ({
        id: item.id,
        type: item.type,
        activityName: item.revisions[0]!.activityName,
        hours: hours(item.revisions[0]!.halfHours),
        decidedAt: item.decidedAt,
      })),
      nextCursor:
        hasMore && last?.decidedAt
          ? encodeTimeIdCursor(last.decidedAt, last.id)
          : null,
    };
  }

  async evidenceForDisplay(id: string, user: User) {
    const evidence = await this.prisma.creditHourEvidence.findUnique({
      where: { id },
      select: {
        displayObjectKey: true,
        displayData: true,
        displayMimeType: true,
        revision: {
          select: {
            submission: {
              select: { userId: true, deletedAt: true },
            },
          },
        },
      },
    });
    if (!evidence || evidence.revision.submission.deletedAt) {
      throw new NotFoundException('凭证不存在');
    }
    if (evidence.revision.submission.userId !== user.id && user.role !== Role.ADMIN) {
      throw new ForbiddenException('无权查看该凭证');
    }
    return {
      objectKey: evidence.displayObjectKey,
      data: evidence.displayData,
      mimeType: evidence.displayMimeType,
    };
  }

  async evidenceOriginal(id: string, user: User) {
    const evidence = await this.prisma.creditHourEvidence.findUnique({
      where: { id },
      select: {
        originalObjectKey: true,
        originalData: true,
        originalMimeType: true,
        revision: {
          select: {
            submissionId: true,
            submission: { select: { deletedAt: true } },
          },
        },
      },
    });
    if (!evidence || evidence.revision.submission.deletedAt) {
      throw new NotFoundException('凭证不存在');
    }
    await this.audit.record(
      user.id,
      'credit-hour.evidence-original.read',
      'CreditHourSubmission',
      evidence.revision.submissionId,
      { evidenceId: id },
    );
    return {
      objectKey: evidence.originalObjectKey,
      data: evidence.originalData,
      mimeType: evidence.originalMimeType,
    };
  }

  async listAdmin(query: AdminCreditHourPageQuery) {
    const keyword = query.keyword?.trim();
    return this.listSubmissions(
      {
        deletedAt: null,
        type: query.type,
        status: query.status,
        ...(query.jobStatus
          ? { reviewJobs: { some: { status: query.jobStatus } } }
          : {}),
        ...(keyword
          ? {
              OR: [
                { id: keyword },
                { user: { displayName: { contains: keyword } } },
                {
                  revisions: {
                    some: {
                      OR: [
                        { activityName: { contains: keyword } },
                        { sourceDescription: { contains: keyword } },
                      ],
                    },
                  },
                },
              ],
            }
          : {}),
      },
      query,
      true,
      true,
    );
  }

  async getAdmin(id: string) {
    const item = await this.prisma.creditHourSubmission.findFirst({
      where: { id },
      include: {
        ...SUBMISSION_INCLUDE,
        reviewJobs: {
          orderBy: { reviewCycle: 'desc' },
          include: {
            reviewAttempts: {
              orderBy: { attempt: 'desc' },
              select: {
                id: true,
                attempt: true,
                model: true,
                strategy: true,
                promptVersion: true,
                decision: true,
                userReason: true,
                fieldSummary: true,
                riskCodes: true,
                errorCategory: true,
                errorMessage: true,
                completedAt: true,
                createdAt: true,
              },
            },
          },
        },
        decisionEvents: { orderBy: { createdAt: 'desc' }, take: 100 },
      },
    });
    if (!item) throw new NotFoundException('学时记录不存在');
    return {
      ...this.serializeSubmission(item, true, true),
      reviewJobs: item.reviewJobs,
      decisionEvents: item.decisionEvents,
    };
  }

  async adminOverview(query: { cursor?: string; pageSize: number }) {
    const ordered = (await this.activeUserTotals('TOTAL')).sort(
      (left, right) =>
        left.selected - right.selected || left.id.localeCompare(right.id),
    );
    const cursor = query.cursor ? readLeaderboardCursor(query.cursor) : null;
    const remaining = cursor
      ? ordered.filter(
          (item) =>
            item.selected > cursor.halfHours ||
            (item.selected === cursor.halfHours && item.id > cursor.userId),
        )
      : ordered;
    const page = remaining.slice(0, query.pageSize + 1);
    const hasMore = page.length > query.pageSize;
    const items = page.slice(0, query.pageSize);
    const last = items.at(-1);
    return {
      type: 'TOTAL' as const,
      items: items.map((item) => ({
        userId: item.id,
        displayName: item.displayName,
        qualityHours: hours(item.totals.QUALITY),
        volunteerHours: hours(item.totals.VOLUNTEER),
        totalHours: hours(item.totals.QUALITY + item.totals.VOLUNTEER),
        rank: item.rank,
        currentUser: false,
      })),
      nextCursor:
        hasMore && last
          ? encodeKeysetCursor({
              halfHours: last.selected,
              userId: last.id,
            })
          : null,
    };
  }

  async overrideDecision(
    user: User,
    id: string,
    dto: AdminCreditHourDecisionDto,
  ) {
    if (
      dto.decision !== CreditHourSubmissionStatus.APPROVED &&
      dto.decision !== CreditHourSubmissionStatus.REJECTED
    ) {
      throw new BadRequestException('人工覆盖只能选择通过或不通过');
    }
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.creditHourSubmission.findFirst({
        where: { id, deletedAt: null },
      });
      if (!current) throw new NotFoundException('学时记录不存在');
      if (current.status === CreditHourSubmissionStatus.WITHDRAWN) {
        throw new ConflictException('已撤回记录必须先重新打开');
      }
      const now = new Date();
      const claimed = await transaction.creditHourSubmission.updateMany({
        where: {
          id,
          deletedAt: null,
          revision: dto.expectedRevision,
          status: { not: CreditHourSubmissionStatus.WITHDRAWN },
        },
        data: {
          status: dto.decision,
          decisionSource: CreditHourDecisionSource.ADMIN_OVERRIDE,
          decisionReason: dto.reason.trim(),
          decidedAt: now,
          revision: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        const latest = await transaction.creditHourSubmission.findUnique({
          where: { id },
          select: { revision: true },
        });
        throw revisionConflict(latest?.revision ?? current.revision);
      }
      await transaction.creditHourReviewJob.updateMany({
        where: {
          submissionId: id,
          reviewCycle: current.currentReviewCycle,
          status: {
            in: [
              CreditHourReviewJobStatus.PENDING,
              CreditHourReviewJobStatus.RETRY_PENDING,
              CreditHourReviewJobStatus.RUNNING,
            ],
          },
        },
        data: {
          status: CreditHourReviewJobStatus.CANCELLED,
          leaseOwnerToken: null,
          leasedUntil: null,
          completedAt: now,
        },
      });
      await transaction.creditHourDecisionEvent.create({
        data: {
          submissionId: id,
          reviewCycle: current.currentReviewCycle,
          contentRevision: 1,
          source: CreditHourDecisionSource.ADMIN_OVERRIDE,
          actorId: user.id,
          fromStatus: current.status,
          toStatus: dto.decision,
          reason: dto.reason.trim(),
        },
      });
      await this.audit.record(
        user.id,
        'credit-hour.decision.override',
        'CreditHourSubmission',
        id,
        { decision: dto.decision },
        transaction,
      );
      const updated = await transaction.creditHourSubmission.findUniqueOrThrow({
        where: { id },
        include: SUBMISSION_INCLUDE,
      });
      return this.serializeSubmission(updated, true, true);
    });
  }

  async reopen(user: User, id: string, dto: AdminCreditHourActionDto) {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.creditHourSubmission.findFirst({
        where: { id, deletedAt: null },
      });
      if (!current) throw new NotFoundException('学时记录不存在');
      const reopenable: CreditHourSubmissionStatus[] = [
        CreditHourSubmissionStatus.APPROVED,
        CreditHourSubmissionStatus.REJECTED,
        CreditHourSubmissionStatus.WITHDRAWN,
      ];
      if (!reopenable.includes(current.status)) {
        throw new ConflictException('当前记录已经处于待审核状态');
      }
      const evidenceCount = await transaction.creditHourEvidence.count({
        where: { revision: { submissionId: id } },
      });
      if (evidenceCount === 0) {
        throw new ConflictException('无凭证记录不能进入 AI 审核');
      }
      const nextCycle = current.currentReviewCycle + 1;
      const claimed = await transaction.creditHourSubmission.updateMany({
        where: {
          id,
          deletedAt: null,
          revision: dto.expectedRevision,
          status: { in: reopenable },
        },
        data: {
          status: CreditHourSubmissionStatus.PENDING_REVIEW,
          decisionSource: null,
          decisionReason: null,
          decidedAt: null,
          currentReviewCycle: nextCycle,
          revision: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        const latest = await transaction.creditHourSubmission.findUnique({
          where: { id },
          select: { revision: true },
        });
        throw revisionConflict(latest?.revision ?? current.revision);
      }
      await transaction.creditHourReviewJob.create({
        data: {
          submissionId: id,
          reviewCycle: nextCycle,
          contentRevision: 1,
          generation: current.generation,
        },
      });
      await transaction.creditHourDecisionEvent.create({
        data: {
          submissionId: id,
          reviewCycle: nextCycle,
          contentRevision: 1,
          actorId: user.id,
          fromStatus: current.status,
          toStatus: CreditHourSubmissionStatus.PENDING_REVIEW,
          reason: dto.reason.trim(),
        },
      });
      await this.audit.record(
        user.id,
        'credit-hour.reopen',
        'CreditHourSubmission',
        id,
        undefined,
        transaction,
      );
      const updated = await transaction.creditHourSubmission.findUniqueOrThrow({
        where: { id },
        include: SUBMISSION_INCLUDE,
      });
      return this.serializeSubmission(updated, true, true);
    });
  }

  async retry(user: User, id: string, dto: AdminCreditHourActionDto) {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.creditHourSubmission.findFirst({
        where: { id, deletedAt: null },
      });
      if (!current) throw new NotFoundException('学时记录不存在');
      if (current.revision !== dto.expectedRevision) {
        throw revisionConflict(current.revision);
      }
      if (current.status !== CreditHourSubmissionStatus.PENDING_REVIEW) {
        throw new ConflictException('只有待审核记录可以重试');
      }
      const updated = await transaction.creditHourReviewJob.updateMany({
        where: {
          submissionId: id,
          reviewCycle: current.currentReviewCycle,
          submission: {
            deletedAt: null,
            revision: dto.expectedRevision,
            status: CreditHourSubmissionStatus.PENDING_REVIEW,
          },
          status: {
            in: [
              CreditHourReviewJobStatus.FAILED,
              CreditHourReviewJobStatus.RETRY_PENDING,
            ],
          },
        },
        data: {
          status: CreditHourReviewJobStatus.PENDING,
          nextAttemptAt: null,
          errorCategory: null,
          errorMessage: null,
        },
      });
      if (updated.count !== 1) throw new ConflictException('当前任务不可重试');
      await this.audit.record(
        user.id,
        'credit-hour.ai-retry',
        'CreditHourSubmission',
        id,
        { reason: dto.reason.trim() },
        transaction,
      );
      return { id, queued: true };
    });
  }

  async deleteSubmission(user: User, id: string, dto: AdminCreditHourActionDto) {
    const operation = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.creditHourSubmission.findFirst({
        where: { id, deletedAt: null },
        include: {
          revisions: {
            select: {
              evidence: {
                select: {
                  id: true,
                  originalObjectKey: true,
                  displayObjectKey: true,
                },
              },
            },
          },
        },
      });
      if (!current) throw new NotFoundException('学时记录不存在');
      const manifest = current.revisions.flatMap((revision) =>
        revision.evidence.flatMap((evidence) => [
          ...(evidence.originalObjectKey
            ? [{ evidenceId: evidence.id, field: 'original', key: evidence.originalObjectKey }]
            : []),
          ...(evidence.displayObjectKey
            ? [{ evidenceId: evidence.id, field: 'display', key: evidence.displayObjectKey }]
            : []),
        ]),
      );
      const now = new Date();
      const claimed = await transaction.creditHourSubmission.updateMany({
        where: {
          id,
          deletedAt: null,
          revision: dto.expectedRevision,
        },
        data: {
          deletedAt: now,
          decisionReason: null,
          revision: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        const latest = await transaction.creditHourSubmission.findUnique({
          where: { id },
          select: { revision: true },
        });
        throw revisionConflict(latest?.revision ?? current.revision);
      }
      await transaction.creditHourReviewJob.updateMany({
        where: {
          submissionId: id,
          status: {
            in: [
              CreditHourReviewJobStatus.PENDING,
              CreditHourReviewJobStatus.RETRY_PENDING,
              CreditHourReviewJobStatus.RUNNING,
            ],
          },
        },
        data: {
          status: CreditHourReviewJobStatus.CANCELLED,
          leaseOwnerToken: null,
          leasedUntil: null,
          completedAt: now,
        },
      });
      await transaction.creditHourSubmissionRevision.updateMany({
        where: { submissionId: id },
        data: {
          activityName: '已删除记录',
          sourceDescription: '',
        },
      });
      const created = await transaction.creditHourCleanupOperation.create({
        data: {
          submissionId: id,
          createdById: user.id,
          reason: dto.reason.trim(),
          manifest,
          totalObjects: manifest.length,
        },
      });
      await this.audit.record(
        user.id,
        'credit-hour.delete',
        'CreditHourSubmission',
        id,
        { operationId: created.id, objectCount: manifest.length },
        transaction,
      );
      return created;
    });
    return this.recovery.executeCleanup(operation.id, true);
  }

  async runtime() {
    const [jobs, providerFiles, cleanup, uploads] = await Promise.all([
      this.prisma.creditHourReviewJob.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.creditHourProviderFile.groupBy({
        by: ['deleteStatus'],
        _count: { _all: true },
      }),
      this.prisma.creditHourCleanupOperation.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.creditHourUploadOperation.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);
    return { jobs, providerFiles, cleanup, uploads };
  }

  async cleanupOperation(id: string) {
    const operation = await this.prisma.creditHourCleanupOperation.findUnique({
      where: { id },
      select: {
        id: true,
        submissionId: true,
        status: true,
        totalObjects: true,
        deletedObjects: true,
        errorMessage: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!operation) throw new NotFoundException('清理操作不存在');
    return operation;
  }

  async resumeCleanup(user: User, id: string) {
    const operation = await this.prisma.creditHourCleanupOperation.findUnique({
      where: { id },
      select: { id: true, submissionId: true, status: true },
    });
    if (!operation) throw new NotFoundException('清理操作不存在');
    await this.audit.record(
      user.id,
      'credit-hour.cleanup.resume',
      'CreditHourSubmission',
      operation.submissionId,
      { operationId: id },
    );
    return this.recovery.executeCleanup(id, true);
  }

  async preflight() {
    const [submissions, evidence, jobs, bytes] = await Promise.all([
      this.prisma.creditHourSubmission.count({ where: { deletedAt: null } }),
      this.prisma.creditHourEvidence.count({
        where: { revision: { submission: { deletedAt: null } } },
      }),
      this.prisma.creditHourReviewJob.count({
        where: {
          status: {
            in: [
              CreditHourReviewJobStatus.PENDING,
              CreditHourReviewJobStatus.RETRY_PENDING,
              CreditHourReviewJobStatus.RUNNING,
            ],
          },
        },
      }),
      this.prisma.creditHourEvidence.aggregate({
        where: { revision: { submission: { deletedAt: null } } },
        _sum: { originalSize: true, displaySize: true },
      }),
    ]);
    return {
      submissions,
      evidence,
      activeJobs: jobs,
      originalBytes: bytes._sum.originalSize ?? 0,
      displayBytes: bytes._sum.displaySize ?? 0,
      executable: false,
      reason: '全部初始化需要 root-only 备份恢复证明，本地 API 不直接执行',
    };
  }

  private async listSubmissions(
    where: Prisma.CreditHourSubmissionWhereInput,
    query: CreditHourPageQuery,
    includePrivate: boolean,
    includeInternal = false,
  ) {
    const cursor = query.cursor ? decodeTimeIdCursor(query.cursor) : null;
    const rows = await this.prisma.creditHourSubmission.findMany({
      where: {
        ...where,
        ...(cursor
          ? {
              AND: [
                where,
                {
                  OR: [
                    { createdAt: { lt: cursor.timestamp } },
                    { createdAt: cursor.timestamp, id: { lt: cursor.id } },
                  ],
                },
              ],
            }
          : {}),
      },
      include: SUBMISSION_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.pageSize + 1,
    });
    const hasMore = rows.length > query.pageSize;
    const page = rows.slice(0, query.pageSize);
    const last = page.at(-1);
    return {
      items: page.map((item) =>
        this.serializeSubmission(item, includePrivate, includeInternal),
      ),
      nextCursor:
        hasMore && last ? encodeTimeIdCursor(last.createdAt, last.id) : null,
    };
  }

  private async activeUserTotals(type: CreditHourType | 'TOTAL') {
    const users = await this.prisma.user.findMany({
      where: { status: AccountStatus.ACTIVE },
      select: {
        id: true,
        displayName: true,
        creditHourSubmissions: {
          where: {
            status: CreditHourSubmissionStatus.APPROVED,
            deletedAt: null,
          },
          select: {
            type: true,
            revisions: {
              orderBy: { revision: 'desc' },
              take: 1,
              select: { halfHours: true },
            },
          },
        },
      },
    });
    const ordered = users
      .map((user) => {
        const totals = totalsFor(user.creditHourSubmissions);
        const selected =
          type === 'TOTAL'
            ? totals.QUALITY + totals.VOLUNTEER
            : totals[type];
        return { ...user, totals, selected };
      })
      .sort(
        (left, right) =>
          right.selected - left.selected || left.id.localeCompare(right.id),
      );
    let previous: number | null = null;
    let rank = 0;
    return ordered.map((user, index) => {
      if (user.selected !== previous) rank = index + 1;
      previous = user.selected;
      return { ...user, rank };
    });
  }

  private serializeSubmission(
    item: SubmissionWithDetail,
    includePrivate: boolean,
    includeInternal = false,
  ) {
    const revision = item.revisions[0];
    if (!revision) throw new Error('Credit-hour submission has no revision');
    return {
      id: item.id,
      user: item.user,
      type: item.type,
      status: item.status,
      revision: item.revision,
      activityName: revision.activityName,
      hours: hours(revision.halfHours),
      ...(includePrivate
        ? {
            sourceDescription: revision.sourceDescription,
            decisionSource: item.decisionSource,
            decisionReason: item.decisionReason,
            manualReview: serializeManualReview(item),
            reviewJob: item.reviewJobs[0]
              ? includeInternal
                ? item.reviewJobs[0]
                : {
                    id: item.reviewJobs[0].id,
                    reviewCycle: item.reviewJobs[0].reviewCycle,
                    status: item.reviewJobs[0].status,
                    attempts: item.reviewJobs[0].attempts,
                    completedAt: item.reviewJobs[0].completedAt,
                    updatedAt: item.reviewJobs[0].updatedAt,
                  }
              : null,
            evidence: revision.evidence.map((evidence) => ({
              ...evidence,
              displayUrl: `/api/v1/credit-hours/evidence/${evidence.id}/display`,
            })),
          }
        : {}),
      decidedAt: item.decidedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  private normalizeSubmission(
    idempotencyKey: string,
    dto: CreditHourSubmissionDto,
    files: Express.Multer.File[],
  ) {
    if (!idempotencyKey || idempotencyKey.length > 191) {
      throw new BadRequestException('Idempotency-Key 必须为 1-191 个字符');
    }
    const activityName = dto.activityName.trim();
    const sourceDescription = dto.sourceDescription.trim();
    const halfHours = halfHoursFor(dto.hours);
    if (!activityName || !sourceDescription) {
      throw new BadRequestException('活动名称和学时来源不能为空');
    }
    if (files.length < 1 || files.length > 5) {
      throw new BadRequestException('必须上传 1-5 张图片凭证');
    }
    if (files.reduce((sum, file) => sum + file.buffer.length, 0) > 50 * 1024 * 1024) {
      throw new BadRequestException('图片凭证总大小不能超过 50 MB');
    }
    return {
      type: dto.type,
      activityName,
      halfHours,
      sourceDescription,
      replacesSubmissionId: dto.replacesSubmissionId ?? null,
    };
  }

  private async inspectUpload(buffer: Buffer) {
    try {
      return await inspectImage(buffer);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'image-size-limit') {
        throw new BadRequestException('单张图片不能超过 10 MB');
      }
      throw new BadRequestException('凭证只支持可解码的 JPEG、PNG 或 WebP 图片');
    }
  }

  private idempotentResult(item: SubmissionWithDetail, requestHash: string) {
    if (item.requestHash !== requestHash) {
      throw new ConflictException('同一 Idempotency-Key 已用于不同提交内容');
    }
    return this.serializeSubmission(item, true);
  }

}

function totalsFor(
  rows: Array<{
    type: CreditHourType;
    revisions: Array<{ halfHours: number }>;
  }>,
) {
  const totals: Record<CreditHourType, number> = {
    QUALITY: 0,
    VOLUNTEER: 0,
  };
  for (const row of rows) totals[row.type] += row.revisions[0]?.halfHours ?? 0;
  return totals;
}

function hours(halfHours: number) {
  return halfHours / 2;
}

function halfHoursFor(value: number) {
  const halfHours = value * 2;
  if (
    !Number.isSafeInteger(halfHours) ||
    halfHours < CREDIT_HOUR_MIN_HOURS * 2 ||
    halfHours > CREDIT_HOUR_MAX_HOURS * 2
  ) {
    throw new BadRequestException(
      `学时只能为 ${CREDIT_HOUR_MIN_HOURS}-${CREDIT_HOUR_MAX_HOURS} 小时且必须以 0.5 小时递增`,
    );
  }
  return halfHours;
}

function hashSubmission(
  normalized: {
    type: CreditHourType;
    activityName: string;
    halfHours: number;
    sourceDescription: string;
    replacesSubmissionId: string | null;
  },
  evidence: Array<{ originalSha256: string }>,
) {
  return sha256(
    Buffer.from(
      JSON.stringify({
        ...normalized,
        evidence: evidence.map((item) => item.originalSha256),
      }),
      'utf8',
    ),
  );
}

function hashAdminSubmission(normalized: {
  actorId: string;
  userId: string;
  type: CreditHourType;
  activityName: string;
  halfHours: number;
  sourceDescription: string;
}) {
  return sha256(
    Buffer.from(
      JSON.stringify({ operation: 'ADMIN_CREATED', ...normalized }),
      'utf8',
    ),
  );
}

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function mimeForFormat(format: SupportedImageFormat) {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
}

function creditHourObjectKey(
  now: Date,
  variant: 'original' | 'display',
  id: string,
  extension: SupportedImageFormat | 'webp',
) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `credit-hours/${variant}/${year}/${month}/${id}.${extension}`;
}

function revisionConflict(revision: number) {
  return new ConflictException({
    message: '记录已发生变化，请刷新后重试',
    code: 'CREDIT_HOUR_REVISION_CONFLICT',
    revision,
  });
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function readLeaderboardCursor(value: string) {
  const parsed = decodeKeysetCursor(value);
  if (
    !Number.isSafeInteger(parsed.halfHours) ||
    (parsed.halfHours as number) < 0 ||
    typeof parsed.userId !== 'string' ||
    !parsed.userId ||
    parsed.userId.length > 191
  ) {
    throw new BadRequestException('排行游标无效或已损坏');
  }
  return {
    halfHours: parsed.halfHours as number,
    userId: parsed.userId,
  };
}
