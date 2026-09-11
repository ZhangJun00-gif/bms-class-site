import { createHash } from 'node:crypto';
import {
  AiClientError,
  estimateAiRequestTokens,
  readAiRuntimeConfig,
  type AiCompletion,
  type AiRequest,
} from '@bmc3/ai-core';
import {
  AiInvocationStatus,
  AiTaskType,
  AiUsageSource,
  Prisma,
  type AiTaskStrategy,
  type PrismaClient,
} from '@prisma/client';

export interface InvocationReservation {
  id: string;
  usageDate: Date;
  usageScope: string;
  taskType: AiTaskType;
  reservedTokens: number;
  startedAt: number;
}

export interface ReserveInvocationInput {
  taskType: AiTaskType;
  request: AiRequest;
  model: string;
  correlationType: string;
  correlationId: string;
  requestedById?: string | null;
  usageDate: Date;
  usageScope: string;
  idempotencyKey: string;
  attempt: number;
  concurrencyLimit: number;
  dailyCallLimit: number;
  dailyTokenLimit: number;
  pricingVersion?: string;
  inputHash?: string;
}

export interface RecoverExpiredInput {
  taskType?: AiTaskType;
  now?: Date;
  take?: number;
}

export class AiInvocationIdempotencyError extends Error {
  constructor(
    readonly invocationId: string,
    readonly invocationStatus: AiInvocationStatus,
  ) {
    super(`AI invocation idempotency key is already ${invocationStatus}`);
    this.name = 'AiInvocationIdempotencyError';
  }
}

export async function reserveAiInvocation(
  prisma: PrismaClient,
  input: ReserveInvocationInput,
): Promise<InvocationReservation> {
  assertReservationInput(input);
  const reservedTokens = estimateAiRequestTokens(input.request);
  const invocation = await prisma.$transaction(
    async (transaction) => {
      await recoverExpiredAiInvocations(transaction, {
        taskType: input.taskType,
        now: new Date(),
      });
      const duplicate = await transaction.aiInvocation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, status: true },
      });
      if (duplicate) {
        throw new AiInvocationIdempotencyError(duplicate.id, duplicate.status);
      }
      await transaction.aiDailyUsage.upsert({
        where: {
          usageDate_scope_taskType: {
            usageDate: input.usageDate,
            scope: input.usageScope,
            taskType: input.taskType,
          },
        },
        create: {
          usageDate: input.usageDate,
          scope: input.usageScope,
          taskType: input.taskType,
        },
        update: {},
      });
      await transaction.$queryRaw(
        Prisma.sql`
          SELECT usageDate FROM AiDailyUsage
          WHERE usageDate = ${input.usageDate}
            AND scope = ${input.usageScope}
            AND taskType = ${input.taskType}
          FOR UPDATE
        `,
      );
      const usage = await transaction.aiDailyUsage.findUniqueOrThrow({
        where: {
          usageDate_scope_taskType: {
            usageDate: input.usageDate,
            scope: input.usageScope,
            taskType: input.taskType,
          },
        },
      });
      if (usage.activeCalls >= input.concurrencyLimit) {
        throw new AiClientError('AI 调用并发已满', 'RATE_LIMIT', true, 429);
      }
      if (usage.calls >= input.dailyCallLimit) {
        throw new AiClientError('AI 调用日额度已用完', 'RATE_LIMIT', false, 429);
      }
      if (
        usage.inputTokens + usage.outputTokens + usage.reservedTokens +
          BigInt(reservedTokens) >
        BigInt(input.dailyTokenLimit)
      ) {
        throw new AiClientError('AI 调用日 token 额度不足', 'RATE_LIMIT', false, 429);
      }
      const now = new Date();
      const created = await transaction.aiInvocation.create({
        data: {
          taskType: input.taskType,
          strategy: input.request.strategy,
          provider: readAiRuntimeConfig(process.env).provider,
          model: input.model,
          promptVersion: input.request.promptVersion,
          correlationType: input.correlationType,
          correlationId: input.correlationId,
          requestedById: input.requestedById ?? null,
          usageDate: input.usageDate,
          usageScope: input.usageScope,
          idempotencyKey: input.idempotencyKey,
          status: AiInvocationStatus.RUNNING,
          attempt: input.attempt,
          inputHash: input.inputHash ?? hashRequest(input.request),
          reservedTokens,
          pricingVersion:
            input.pricingVersion ?? process.env.AI_PRICING_VERSION ?? 'unpriced-v1',
          startedAt: now,
          leasedUntil: new Date(now.getTime() + input.request.timeoutMs + 30_000),
        },
      });
      await transaction.aiDailyUsage.update({
        where: {
          usageDate_scope_taskType: {
            usageDate: input.usageDate,
            scope: input.usageScope,
            taskType: input.taskType,
          },
        },
        data: {
          calls: { increment: 1 },
          activeCalls: { increment: 1 },
          reservedTokens: { increment: reservedTokens },
        },
      });
      return created;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  return {
    id: invocation.id,
    usageDate: input.usageDate,
    usageScope: input.usageScope,
    taskType: input.taskType,
    reservedTokens,
    startedAt: Date.now(),
  };
}

export async function finishAiInvocationSuccess(
  prisma: PrismaClient,
  reservation: InvocationReservation,
  completion: AiCompletion,
) {
  await finishAiInvocation(prisma, reservation, {
    status: AiInvocationStatus.SUCCEEDED,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    usageSource:
      completion.usage.source === 'PROVIDER'
        ? AiUsageSource.PROVIDER
        : AiUsageSource.ESTIMATED,
    providerRequestId: completion.providerRequestId,
    outputHash: sha256(completion.content),
    latencyMs: completion.latencyMs,
  });
}

export async function finishAiInvocationFailure(
  prisma: PrismaClient,
  reservation: InvocationReservation,
  error: unknown,
) {
  await finishAiInvocation(prisma, reservation, {
    status: isAbortError(error)
      ? AiInvocationStatus.CANCELLED
      : AiInvocationStatus.FAILED,
    errorCategory:
      error instanceof AiClientError ? error.category : 'UPSTREAM_UNAVAILABLE',
    errorMessage: safeAiErrorMessage(error).slice(0, 500),
    latencyMs: Date.now() - reservation.startedAt,
    failed: true,
  });
}

export async function cancelAiInvocationBeforeDispatch(
  prisma: PrismaClient,
  reservation: InvocationReservation,
  reason = 'SERVICE_PAUSED',
) {
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.aiInvocation.updateMany({
      where: { id: reservation.id, status: AiInvocationStatus.RUNNING },
      data: {
        status: AiInvocationStatus.CANCELLED,
        errorCategory: reason.slice(0, 80),
        errorMessage: '调用在发送给模型供应商前取消',
        reservedTokens: 0,
        leasedUntil: null,
        completedAt: new Date(),
      },
    });
    if (updated.count !== 1) return;
    await transaction.$executeRaw(
      Prisma.sql`
        UPDATE AiDailyUsage
        SET calls = GREATEST(calls - 1, 0),
            activeCalls = GREATEST(activeCalls - 1, 0),
            reservedTokens = GREATEST(reservedTokens - ${reservation.reservedTokens}, 0)
        WHERE usageDate = ${reservation.usageDate}
          AND scope = ${reservation.usageScope}
          AND taskType = ${reservation.taskType}
      `,
    );
  });
}

export async function recoverExpiredAiInvocations(
  transaction: Prisma.TransactionClient,
  input: RecoverExpiredInput = {},
) {
  const now = input.now ?? new Date();
  const expired = await transaction.aiInvocation.findMany({
    where: {
      ...(input.taskType ? { taskType: input.taskType } : {}),
      status: { in: [AiInvocationStatus.RESERVED, AiInvocationStatus.RUNNING] },
      leasedUntil: { lt: now },
    },
    select: {
      id: true,
      taskType: true,
      usageDate: true,
      usageScope: true,
      reservedTokens: true,
      createdAt: true,
    },
    take: input.take ?? 100,
  });
  let recovered = 0;
  for (const item of expired) {
    const updated = await transaction.aiInvocation.updateMany({
      where: {
        id: item.id,
        status: { in: [AiInvocationStatus.RESERVED, AiInvocationStatus.RUNNING] },
        leasedUntil: { lt: now },
      },
      data: {
        status: AiInvocationStatus.EXPIRED,
        leasedUntil: null,
        reservedTokens: 0,
        completedAt: now,
        errorCategory: 'LEASE_EXPIRED',
        errorMessage: '调用租约过期，额度已回收',
      },
    });
    if (updated.count !== 1) continue;
    recovered += 1;
    const usageDate = item.usageDate ?? shanghaiUsageDate(item.createdAt);
    const usageScope = item.usageScope ?? 'GLOBAL';
    await transaction.$executeRaw(
      Prisma.sql`
        UPDATE AiDailyUsage
        SET activeCalls = GREATEST(activeCalls - 1, 0),
            reservedTokens = GREATEST(reservedTokens - ${item.reservedTokens}, 0),
            failures = failures + 1
        WHERE usageDate = ${usageDate}
          AND scope = ${usageScope}
          AND taskType = ${item.taskType}
      `,
    );
  }
  return recovered;
}

async function finishAiInvocation(
  prisma: PrismaClient,
  reservation: InvocationReservation,
  result: {
    status: AiInvocationStatus;
    inputTokens?: number;
    outputTokens?: number;
    usageSource?: AiUsageSource;
    providerRequestId?: string;
    outputHash?: string;
    latencyMs?: number;
    errorCategory?: string;
    errorMessage?: string;
    failed?: boolean;
  },
) {
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.aiInvocation.updateMany({
      where: { id: reservation.id, status: AiInvocationStatus.RUNNING },
      data: {
        status: result.status,
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        usageSource: result.usageSource ?? AiUsageSource.ESTIMATED,
        providerRequestId: result.providerRequestId,
        outputHash: result.outputHash,
        latencyMs: result.latencyMs,
        errorCategory: result.errorCategory,
        errorMessage: result.errorMessage,
        reservedTokens: 0,
        leasedUntil: null,
        completedAt: new Date(),
      },
    });
    if (updated.count !== 1) return;
    await transaction.$executeRaw(
      Prisma.sql`
        UPDATE AiDailyUsage
        SET activeCalls = GREATEST(activeCalls - 1, 0),
            reservedTokens = GREATEST(reservedTokens - ${reservation.reservedTokens}, 0),
            inputTokens = inputTokens + ${result.inputTokens ?? 0},
            outputTokens = outputTokens + ${result.outputTokens ?? 0},
            failures = failures + ${result.failed ? 1 : 0}
        WHERE usageDate = ${reservation.usageDate}
          AND scope = ${reservation.usageScope}
          AND taskType = ${reservation.taskType}
      `,
    );
  });
}

export function shanghaiUsageDate(value: Date | number = new Date()) {
  const milliseconds = value instanceof Date ? value.getTime() : value;
  const date = new Date(milliseconds + 8 * 60 * 60_000)
    .toISOString()
    .slice(0, 10);
  return new Date(`${date}T00:00:00.000Z`);
}

export function safeAiErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|secret|token)\s*[:=])\s*\S+/giu, '$1 [redacted]');
}

function hashRequest(request: AiRequest) {
  return sha256(
    JSON.stringify({
      promptVersion: request.promptVersion,
      strategy: request.strategy,
      messages: request.messages,
      maxOutputTokens: request.maxOutputTokens,
    }),
  );
}

function assertReservationInput(input: ReserveInvocationInput) {
  for (const [name, value, minimum] of [
    ['attempt', input.attempt, 1],
    ['concurrencyLimit', input.concurrencyLimit, 1],
    ['dailyCallLimit', input.dailyCallLimit, 1],
    ['dailyTokenLimit', input.dailyTokenLimit, 1],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  if (
    !input.idempotencyKey ||
    input.idempotencyKey.length > 191 ||
    !input.usageScope ||
    input.usageScope.length > 100 ||
    !Number.isFinite(input.usageDate.getTime())
  ) {
    throw new RangeError('AI invocation correlation or usage scope is invalid');
  }
  if (input.inputHash !== undefined && !/^[a-f0-9]{64}$/u.test(input.inputHash)) {
    throw new RangeError('AI invocation inputHash must be SHA-256');
  }
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isAbortError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

export type InvocationStrategy = AiTaskStrategy;
