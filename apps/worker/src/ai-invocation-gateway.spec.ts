import { AiInvocationStatus, AiTaskType } from '@prisma/client';
import {
  cancelAiInvocationBeforeDispatch,
  recoverExpiredAiInvocations,
  safeAiErrorMessage,
} from './ai-invocation-gateway';

describe('AI invocation gateway', () => {
  it('returns quota only for expired invocations won by CAS', async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const executeRaw = jest.fn().mockResolvedValue(1);
    const usageDate = new Date('2026-07-28T00:00:00.000Z');
    const transaction = {
      aiInvocation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'won',
            taskType: AiTaskType.DAILY_PLAN,
            usageDate,
            usageScope: 'PRACTICE:2026-07-28',
            reservedTokens: 1_000,
            createdAt: usageDate,
          },
          {
            id: 'lost',
            taskType: AiTaskType.DAILY_PLAN,
            usageDate,
            usageScope: 'PRACTICE:2026-07-28',
            reservedTokens: 2_000,
            createdAt: usageDate,
          },
        ]),
        updateMany,
      },
      $executeRaw: executeRaw,
    };

    await expect(
      recoverExpiredAiInvocations(transaction as never, {
        taskType: AiTaskType.DAILY_PLAN,
        now: new Date('2026-07-28T00:10:00.000Z'),
      }),
    ).resolves.toBe(1);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AiInvocationStatus.EXPIRED,
          reservedTokens: 0,
        }),
      }),
    );
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('redacts credentials from bounded ledger messages', () => {
    expect(
      safeAiErrorMessage(
        new Error('Bearer secret-token api_key=very-secret token: another-secret'),
      ),
    ).toBe('Bearer [redacted] api_key= [redacted] token: [redacted]');
  });

  it('returns the call and token reservation when paused before provider dispatch', async () => {
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const executeRaw = jest.fn(async (_query: unknown) => 1);
    const transaction = {
      aiInvocation: { updateMany },
      $executeRaw: executeRaw,
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (value: unknown) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const usageDate = new Date('2026-07-28T00:00:00.000Z');

    await cancelAiInvocationBeforeDispatch(
      prisma as never,
      {
        id: 'invocation-1',
        usageDate,
        usageScope: 'PRACTICE:2026-07-28',
        taskType: AiTaskType.DAILY_PLAN,
        reservedTokens: 1_000,
        startedAt: Date.now(),
      },
      'SERVICE_PAUSED',
    );

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AiInvocationStatus.CANCELLED,
          errorCategory: 'SERVICE_PAUSED',
          reservedTokens: 0,
        }),
      }),
    );
    const sql = executeRaw.mock.calls[0]?.[0] as
      | { strings?: readonly string[] }
      | undefined;
    expect(sql?.strings?.join(' ')).toContain(
      'calls = GREATEST(calls - 1, 0)',
    );
  });
});
