import {
  BadRequestException, ConflictException, ForbiddenException, Injectable,
} from '@nestjs/common';
import { AccountStatus, CreditHourType, Prisma, Role, type User } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { AdminCreditHourBatchCreateDto } from './credit-hour-batch.dto';
import { CREDIT_HOUR_MAX_HOURS, CREDIT_HOUR_MIN_HOURS } from './credit-hours.dto';

const batchInclude = {
  submissions: {
    orderBy: { userId: 'asc' as const },
    select: {
      id: true, userId: true,
      revisions: { where: { revision: 1 }, select: { halfHours: true }, take: 1 },
    },
  },
} satisfies Prisma.CreditHourSubmissionBatchInclude;

type Batch = Prisma.CreditHourSubmissionBatchGetPayload<{ include: typeof batchInclude }>;

@Injectable()
export class CreditHourBatchService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async create(actor: User, idempotencyKey: string, dto: AdminCreditHourBatchCreateDto) {
    if (actor.role !== Role.ADMIN || actor.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException('仅正常状态的管理员可批量录入学时');
    }
    if (!idempotencyKey?.trim() || idempotencyKey.length > 191) {
      throw new BadRequestException('Idempotency-Key 必须为 1-191 个字符');
    }
    const activityName = dto.activityName?.trim();
    const sourceDescription = dto.description?.trim();
    if (!activityName || activityName.length > 160 || !sourceDescription || sourceDescription.length > 2_000) {
      throw new BadRequestException('请填写有效的活动名称和录入理由');
    }
    if (!Object.values(CreditHourType).includes(dto.type)) throw new BadRequestException('学时类型无效');
    if (!Array.isArray(dto.entries) || !dto.entries.length || dto.entries.length > 100) {
      throw new BadRequestException('每批须选择 1-100 名成员');
    }
    const entries = dto.entries.map(({ userId, hours }) => {
      if (!userId?.trim() || userId.length > 191) throw new BadRequestException('成员无效');
      if (userId === actor.id) throw new ForbiddenException('管理员不能通过此入口为自己录入学时');
      const halfHours = hours * 2;
      if (!Number.isSafeInteger(halfHours) || halfHours < CREDIT_HOUR_MIN_HOURS * 2 || halfHours > CREDIT_HOUR_MAX_HOURS * 2) {
        throw new BadRequestException('学时须为 0.5-1000 小时且以 0.5 小时递增');
      }
      return { userId, halfHours };
    }).sort((a, b) => a.userId.localeCompare(b.userId, 'en'));
    if (new Set(entries.map(({ userId }) => userId)).size !== entries.length) {
      throw new BadRequestException('同一批次不能重复选择成员');
    }
    const requestHash = createHash('sha256').update(JSON.stringify({
      actorId: actor.id, type: dto.type, activityName, sourceDescription, entries,
    })).digest('hex');
    const where = { actorId_idempotencyKey: { actorId: actor.id, idempotencyKey } };
    const existing = await this.prisma.creditHourSubmissionBatch.findUnique({ where, include: batchInclude });
    if (existing) return this.result(existing, requestHash);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const batch = await this.prisma.$transaction(async (transaction) => {
          // Lock accounts in a stable order so status changes cannot race the grant.
          const ids = [...entries.map(({ userId }) => userId), actor.id].sort();
          await transaction.$queryRaw(Prisma.sql`
            SELECT id FROM User WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE
          `);
          const users = await transaction.user.findMany({
            where: { id: { in: ids } }, select: { id: true, status: true, role: true },
          });
          const currentActor = users.find(({ id }) => id === actor.id);
          if (currentActor?.status !== AccountStatus.ACTIVE || currentActor.role !== Role.ADMIN) {
            throw new ForbiddenException('管理员权限已改变，请刷新后重试');
          }
          const eligibleIds = new Set(users.filter(({ status }) => status === AccountStatus.ACTIVE).map(({ id }) => id));
          if (entries.some(({ userId }) => !eligibleIds.has(userId))) {
            throw new BadRequestException('所选成员中有不存在或非正常状态账号，整批尚未录入');
          }
          const created = await transaction.creditHourSubmissionBatch.create({
            data: { actorId: actor.id, idempotencyKey, requestHash },
          });
          const decidedAt = new Date();
          for (const entry of entries) {
            const childHash = createHash('sha256').update(`${requestHash}:${entry.userId}`).digest('hex');
            const submission = await transaction.creditHourSubmission.create({
              data: {
                userId: entry.userId, type: dto.type, status: 'APPROVED', batchId: created.id,
                idempotencyKey: `batch:${created.id}`, requestHash: childHash,
                decisionSource: 'ADMIN_CREATED', decidedAt,
                decisionReason: '管理员批量录入，无需 AI 审核',
                revisions: { create: {
                  revision: 1, activityName, halfHours: entry.halfHours,
                  sourceDescription, requestHash: childHash,
                } },
                decisionEvents: { create: {
                  reviewCycle: 1, contentRevision: 1, source: 'ADMIN_CREATED',
                  actorId: actor.id, fromStatus: 'PENDING_REVIEW', toStatus: 'APPROVED',
                  reason: '管理员批量录入，无需 AI 审核',
                } },
              },
              select: { id: true },
            });
            await this.audit.record(actor.id, 'credit-hour.admin-create', 'CreditHourSubmission', submission.id, {
              batchId: created.id, targetUserId: entry.userId, type: dto.type, halfHours: entry.halfHours,
            }, transaction);
          }
          await this.audit.record(actor.id, 'credit-hour.admin-batch-create', 'CreditHourSubmissionBatch', created.id, {
            count: entries.length, type: dto.type,
            totalHalfHours: entries.reduce((sum, entry) => sum + entry.halfHours, 0),
          }, transaction);
          return transaction.creditHourSubmissionBatch.findUniqueOrThrow({
            where: { id: created.id }, include: batchInclude,
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
        return this.result(batch, requestHash);
      } catch (error) {
        const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
        if (code === 'P2002' || code === 'P2034') {
          const winner = await this.prisma.creditHourSubmissionBatch.findUnique({ where, include: batchInclude });
          if (winner) return this.result(winner, requestHash);
          if (code === 'P2034' && attempt < 2) continue;
          throw new ConflictException('批次发生并发冲突，请保留原内容重试');
        }
        throw error;
      }
    }
    throw new ConflictException('批次发生并发冲突，请保留原内容重试');
  }

  private result(batch: Batch, requestHash: string) {
    if (batch.requestHash !== requestHash) throw new ConflictException('此幂等键已用于不同的批量录入内容');
    return {
      id: batch.id, count: batch.submissions.length,
      items: batch.submissions.map((item) => {
        const initialRevision = item.revisions[0];
        if (!initialRevision) throw new ConflictException('批次记录缺少初始版本，请联系管理员核对');
        return { id: item.id, userId: item.userId, hours: initialRevision.halfHours / 2 };
      }),
    };
  }
}
