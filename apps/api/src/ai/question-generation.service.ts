import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  AiQuestionGenerationStatus,
  Prisma,
  Role,
  type User,
} from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  generationError,
  type QuestionGenerationInput,
  QuestionGenerationSourceService,
} from './question-generation-source.service';

const ACTIVE_GENERATION_STATUSES = [
  AiQuestionGenerationStatus.PENDING,
  AiQuestionGenerationStatus.PROCESSING,
] as const;

@Injectable()
export class QuestionGenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: QuestionGenerationSourceService,
    private readonly audit: AuditService,
  ) {}

  async preview(input: QuestionGenerationInput) {
    const result = await this.sources.preflight(input);
    return result.summary;
  }

  async create(
    user: User,
    idempotencyKey: string,
    input: QuestionGenerationInput,
  ) {
    const key = normalizeIdempotencyKey(idempotencyKey);
    const preflight = await this.sources.preflight(input);
    const requestHash = generationRequestHash(preflight);
    const existing = await this.prisma.aiQuestionGenerationJob.findUnique({
      where: {
        createdById_idempotencyKey: {
          createdById: user.id,
          idempotencyKey: key,
        },
      },
      include: jobInclude,
    });
    if (existing) {
      assertMatchingRequest(existing.requestHash, requestHash);
      return serializeJob(existing);
    }
    try {
      const job = await this.prisma.$transaction(
        async (transaction) => {
          const raced = await transaction.aiQuestionGenerationJob.findUnique({
            where: {
              createdById_idempotencyKey: {
                createdById: user.id,
                idempotencyKey: key,
              },
            },
            include: jobInclude,
          });
          if (raced) {
            assertMatchingRequest(raced.requestHash, requestHash);
            return raced;
          }
          const [userActive, globalActive] = await Promise.all([
            transaction.aiQuestionGenerationJob.count({
              where: {
                createdById: user.id,
                status: { in: [...ACTIVE_GENERATION_STATUSES] },
              },
            }),
            transaction.aiQuestionGenerationJob.count({
              where: { status: { in: [...ACTIVE_GENERATION_STATUSES] } },
            }),
          ]);
          if (userActive >= generationLimit('AI_QUESTION_GENERATION_ACTIVE_PER_USER', 2)) {
            generationError(
              'AI_GENERATION_CONCURRENCY_LIMIT',
              '每位用户最多同时保留两个未结束的生成任务',
            );
          }
          if (globalActive >= generationLimit('AI_QUESTION_GENERATION_ACTIVE_GLOBAL', 10)) {
            generationError(
              'AI_GENERATION_CONCURRENCY_LIMIT',
              '全局生成任务队列已满，请稍后重试',
            );
          }
          const created = await transaction.aiQuestionGenerationJob.create({
            data: {
              createdById: user.id,
              subjectId: preflight.input.subjectId,
              gradingType: preflight.input.gradingType,
              typeLabel: preflight.input.typeLabel,
              complexity: preflight.input.complexity,
              requestedCount: preflight.input.requestedCount,
              idempotencyKey: key,
              requestHash,
              promptVersion: preflight.summary.promptVersion,
              configSnapshot: preflight.summary as unknown as Prisma.InputJsonValue,
              chapters: {
                create: preflight.input.chapterIds.map((chapterId) => ({
                  chapterId,
                })),
              },
              sources: {
                create: preflight.sources.map((source) => ({
                  ordinal: source.ordinal,
                  knowledgeNodeId: source.knowledgeNodeId,
                  libraryId: source.libraryId,
                  documentId: source.documentId,
                  documentVersionId: source.documentVersionId,
                  libraryChapterId: source.libraryChapterId,
                  nodeTitle: source.nodeTitle,
                  nodeTitleMarkdown: source.nodeTitleMarkdown,
                  breadcrumb: source.breadcrumb,
                  nodePath: source.nodePath,
                  contentHash: source.contentHash,
                  chunkManifest:
                    source.chunkManifest as unknown as Prisma.InputJsonValue,
                  evidenceContent: source.evidenceContent,
                })),
              },
            },
            include: jobInclude,
          });
          await this.audit.record(
            user.id,
            'ai.question-generation.create',
            'AiQuestionGenerationJob',
            created.id,
            {
              subjectId: created.subjectId,
              requestedCount: created.requestedCount,
              complexity: created.complexity,
              sourceRevision: preflight.summary.sourceRevision,
            },
            transaction,
          );
          return created;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000,
        },
      );
      return serializeJob(job);
    } catch (error) {
      if (isUniqueConflict(error)) {
        const raced = await this.prisma.aiQuestionGenerationJob.findUnique({
          where: {
            createdById_idempotencyKey: {
              createdById: user.id,
              idempotencyKey: key,
            },
          },
          include: jobInclude,
        });
        if (raced) {
          assertMatchingRequest(raced.requestHash, requestHash);
          return serializeJob(raced);
        }
      }
      throw error;
    }
  }

  async list(query: {
    status?: AiQuestionGenerationStatus;
    subjectId?: string;
    createdById?: string;
    page: number;
    pageSize: number;
  }) {
    const where: Prisma.AiQuestionGenerationJobWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.createdById ? { createdById: query.createdById } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.aiQuestionGenerationJob.findMany({
        where,
        include: jobInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.aiQuestionGenerationJob.count({ where }),
    ]);
    return {
      items: items.map(serializeJob),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: string) {
    const job = await this.prisma.aiQuestionGenerationJob.findUnique({
      where: { id },
      include: jobDetailInclude,
    });
    if (!job) throw new NotFoundException('AI 出题任务不存在');
    const invocations = await this.prisma.aiInvocation.findMany({
      where: {
        correlationType: 'AiQuestionGenerationJob',
        correlationId: id,
      },
      select: {
        id: true,
        strategy: true,
        provider: true,
        model: true,
        status: true,
        attempt: true,
        inputTokens: true,
        outputTokens: true,
        usageSource: true,
        estimatedCostMicros: true,
        latencyMs: true,
        errorCategory: true,
        createdAt: true,
        completedAt: true,
      },
      orderBy: { attempt: 'asc' },
    });
    return {
      ...serializeJob(job),
      sources: job.sources.map((source) => ({
        id: source.id,
        ordinal: source.ordinal,
        knowledgeNodeId: source.knowledgeNodeId,
        libraryId: source.libraryId,
        documentId: source.documentId,
        documentVersionId: source.documentVersionId,
        libraryChapterId: source.libraryChapterId,
        nodeTitle: source.nodeTitle,
        nodeTitleMarkdown: source.nodeTitleMarkdown,
        breadcrumb: source.breadcrumb,
        contentHash: source.contentHash,
      })),
      invocations: invocations.map((invocation) => ({
        ...invocation,
        estimatedCostMicros: invocation.estimatedCostMicros.toString(),
      })),
    };
  }

  async cancel(user: User, id: string) {
    const job = await this.prisma.aiQuestionGenerationJob.findUnique({
      where: { id },
      select: { id: true, createdById: true, status: true },
    });
    if (!job) throw new NotFoundException('AI 出题任务不存在');
    if (job.createdById !== user.id && user.role !== Role.ADMIN) {
      throw new ForbiddenException('只能取消自己创建的任务');
    }
    if (!ACTIVE_GENERATION_STATUSES.includes(job.status as never)) {
      return { id, status: job.status, cancelRequested: false };
    }
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.aiQuestionGenerationJob.updateMany({
        where: { id, status: job.status },
        data: {
          cancelRequestedAt: now,
          ...(job.status === AiQuestionGenerationStatus.PENDING
            ? {
                status: AiQuestionGenerationStatus.CANCELLED,
                stage: 'CANCELLED',
                leaseOwnerToken: null,
                leasedUntil: null,
                completedAt: now,
                errorCategory: 'AI_GENERATION_CANCELLED',
                errorMessage: '任务已由用户取消',
              }
            : {}),
        },
      });
      if (!updated.count) {
        throw new ConflictException({
          statusCode: 409,
          code: 'AI_GENERATION_STATUS_CHANGED',
          message: '任务状态已变化，请刷新后重试',
        });
      }
      await this.audit.record(
        user.id,
        'ai.question-generation.cancel',
        'AiQuestionGenerationJob',
        id,
        undefined,
        transaction,
      );
    });
    return {
      id,
      status:
        job.status === AiQuestionGenerationStatus.PENDING
          ? AiQuestionGenerationStatus.CANCELLED
          : job.status,
      cancelRequested: true,
    };
  }
}

function generationRequestHash(
  preflight: Awaited<ReturnType<QuestionGenerationSourceService['preflight']>>,
) {
  const canonical = {
    input: {
      ...preflight.input,
      chapterIds: [...preflight.input.chapterIds].sort(),
      knowledgeNodeIds: [...preflight.input.knowledgeNodeIds].sort(),
    },
    promptVersion: preflight.summary.promptVersion,
    configSnapshot: {
      strategy: preflight.summary.strategy,
      model: preflight.summary.model,
      maxOutputTokens: preflight.summary.maxOutputTokens,
    },
    sources: preflight.sources
      .map((source) => ({
        knowledgeNodeId: source.knowledgeNodeId,
        libraryId: source.libraryId,
        documentId: source.documentId,
        documentVersionId: source.documentVersionId,
        libraryChapterId: source.libraryChapterId,
        contentHash: source.contentHash,
      }))
      .sort((left, right) => {
        const leftKey = stableJson(left);
        const rightKey = stableJson(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  };
  return createHash('sha256')
    .update(stableJson(canonical), 'utf8')
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function assertMatchingRequest(
  storedHash: string | null,
  requestHash: string,
) {
  if (storedHash === requestHash) return;
  throw new ConflictException({
    statusCode: 409,
    code: 'AI_GENERATION_IDEMPOTENCY_CONFLICT',
    message:
      storedHash === null
        ? '该幂等键属于旧任务，无法验证请求一致性，请使用新的幂等键'
        : '同一幂等键不能用于不同的出题请求',
  });
}

const jobInclude = {
  subject: { select: { id: true, name: true, slug: true } },
  createdBy: { select: { id: true, displayName: true } },
  chapters: {
    select: { chapter: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  _count: { select: { sources: true, items: true } },
} satisfies Prisma.AiQuestionGenerationJobInclude;

const jobDetailInclude = {
  ...jobInclude,
  sources: { orderBy: { ordinal: 'asc' as const } },
  items: {
    select: { ordinal: true, questionId: true, fingerprint: true },
    orderBy: { ordinal: 'asc' as const },
  },
} satisfies Prisma.AiQuestionGenerationJobInclude;

type JobSummary = Prisma.AiQuestionGenerationJobGetPayload<{
  include: typeof jobInclude;
}>;

function serializeJob(job: JobSummary) {
  return {
    id: job.id,
    subject: job.subject,
    createdBy: job.createdBy,
    gradingType: job.gradingType,
    typeLabel: job.typeLabel,
    complexity: job.complexity,
    requestedCount: job.requestedCount,
    status: job.status,
    stage: job.stage,
    promptVersion: job.promptVersion,
    configSnapshot: job.configSnapshot,
    attempts: job.attempts,
    nextAttemptAt: job.nextAttemptAt,
    cancelRequestedAt: job.cancelRequestedAt,
    errorCategory: job.errorCategory,
    errorMessage: job.errorMessage,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    chapterIds: job.chapters.map(({ chapter }) => chapter.id),
    chapters: job.chapters.map(({ chapter }) => chapter),
    sourceCount: job._count.sources,
    itemCount: job._count.items,
    ...('items' in job ? { items: job.items } : {}),
  };
}

function normalizeIdempotencyKey(value: string) {
  const key = value?.trim();
  if (!key || key.length > 191) {
    generationError(
      'AI_GENERATION_SCOPE_INVALID',
      'Idempotency-Key 必须是 1-191 个字符',
    );
  }
  return key;
}

function generationLimit(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    generationError(
      'AI_GENERATION_SCOPE_INVALID',
      `${name} 必须是 1-100 的整数`,
    );
  }
  return value;
}

function isUniqueConflict(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}
