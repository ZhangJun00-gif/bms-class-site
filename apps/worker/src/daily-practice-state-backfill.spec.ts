import {
  UserPracticeInitializationStatus,
  type Prisma,
} from '@prisma/client';
import {
  PracticeStateLeaseLostError,
  PracticeStateOrderingError,
  processNextPracticeStateBackfill,
} from './daily-practice-state-backfill';

function submittedAttempt(id: string, submittedAt: string) {
  return {
    id,
    userId: 'user-1',
    snapshot: [] as Prisma.JsonArray,
    results: [] as Prisma.JsonArray,
    submittedAt: new Date(submittedAt),
    dailyPracticePlanRevisionId: null,
  };
}

function buildPrisma(
  attempts: ReturnType<typeof submittedAttempt>[],
  options: {
    remaining?: number;
    transaction?: (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
    updateMany?: (args: Record<string, unknown>) => Promise<{ count: number }>;
  } = {},
) {
  const updateMany = jest.fn(
    options.updateMany ?? (async () => ({ count: 1 })),
  );
  const transactionClient = {
    userPracticeProfile: { updateMany },
  };
  const transaction = jest.fn(
    options.transaction ??
      (async (callback: (value: unknown) => Promise<unknown>) =>
        callback(transactionClient)),
  );
  const findMany = jest.fn(async (args: { distinct?: string[] }) =>
    args.distinct ? [{ userId: 'user-1' }] : attempts,
  );
  return {
    prisma: {
      quizAttempt: {
        findMany,
        count: jest.fn(async () => options.remaining ?? 0),
      },
      userPracticeProfile: {
        upsert: jest.fn(async () => ({})),
        findFirst: jest.fn(async () => null),
        findUniqueOrThrow: jest.fn(async () => ({
          initializedThroughAttemptAt: null,
        })),
        updateMany,
      },
      $transaction: transaction,
    },
    findMany,
    transaction,
    updateMany,
  };
}

function appliedResult(overrides: { deferred?: boolean } = {}) {
  return {
    applied: !overrides.deferred,
    deferred: overrides.deferred ?? false,
    stateRevision: 1,
    questionCount: 1,
    knowledgeStateCount: 1,
    chapterStateCount: 1,
  };
}

describe('daily practice state backfill', () => {
  it('processes a batch in submittedAt/id order and advances each checkpoint', async () => {
    const attempts = [
      submittedAttempt('attempt-a', '2026-07-01T00:00:00.000Z'),
      submittedAttempt('attempt-b', '2026-07-01T00:00:00.000Z'),
      submittedAttempt('attempt-c', '2026-07-02T00:00:00.000Z'),
    ];
    const mock = buildPrisma(attempts);
    const applyAttemptState = jest.fn(
      async (_transaction: unknown, _attempt: { id: string }) => appliedResult(),
    );

    await expect(
      processNextPracticeStateBackfill(mock.prisma as never, {
        now: new Date('2026-07-28T00:00:00.000Z'),
        applyAttemptState: applyAttemptState as never,
      }),
    ).resolves.toBe(true);

    expect(mock.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(applyAttemptState.mock.calls.map((call) => call[1]!.id)).toEqual([
      'attempt-a',
      'attempt-b',
      'attempt-c',
    ]);
    expect(
      mock.updateMany.mock.calls
        .map(
          ([call]) =>
            (call.data as { initializedThroughAttemptId?: string } | undefined)
              ?.initializedThroughAttemptId,
        )
        .filter(Boolean),
    ).toEqual(['attempt-a', 'attempt-b', 'attempt-c']);
    expect(mock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          initializationStatus: UserPracticeInitializationStatus.READY,
          leaseOwnerToken: null,
          leasedUntil: null,
        }),
      }),
    );
  });

  it('does not advance the checkpoint when state application is deferred', async () => {
    const mock = buildPrisma([
      submittedAttempt('attempt-b', '2026-07-02T00:00:00.000Z'),
    ]);
    const applyAttemptState = jest.fn(
      async (_transaction: unknown, _attempt: { id: string }) =>
        appliedResult({ deferred: true }),
    );

    await expect(
      processNextPracticeStateBackfill(mock.prisma as never, {
        applyAttemptState: applyAttemptState as never,
      }),
    ).rejects.toBeInstanceOf(PracticeStateOrderingError);
    expect(
      mock.updateMany.mock.calls.some(
        ([call]) =>
          (call.data as { initializedThroughAttemptId?: string } | undefined)
            ?.initializedThroughAttemptId === 'attempt-b',
      ),
    ).toBe(false);
    expect(mock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          initializationStatus: UserPracticeInitializationStatus.PENDING,
          leaseOwnerToken: null,
        }),
      }),
    );
  });

  it('replays the same attempt after a transaction failure', async () => {
    let transactionCount = 0;
    const mock = buildPrisma(
      [submittedAttempt('attempt-a', '2026-07-01T00:00:00.000Z')],
      {
        transaction: async (callback) => {
          transactionCount += 1;
          const value = await callback({
            userPracticeProfile: { updateMany: mock.updateMany },
          });
          if (transactionCount === 1) throw new Error('transaction rolled back');
          return value;
        },
      },
    );
    const applyAttemptState = jest.fn(
      async (_transaction: unknown, _attempt: { id: string }) => appliedResult(),
    );

    await expect(
      processNextPracticeStateBackfill(mock.prisma as never, {
        applyAttemptState: applyAttemptState as never,
      }),
    ).rejects.toThrow('transaction rolled back');
    await expect(
      processNextPracticeStateBackfill(mock.prisma as never, {
        applyAttemptState: applyAttemptState as never,
      }),
    ).resolves.toBe(true);
    expect(applyAttemptState).toHaveBeenCalledTimes(2);
  });

  it('refuses READY finalization after losing the profile lease', async () => {
    const mock = buildPrisma(
      [submittedAttempt('attempt-a', '2026-07-01T00:00:00.000Z')],
      {
        updateMany: async (args) => {
          const data = args.data as
            | { initializationStatus?: UserPracticeInitializationStatus }
            | undefined;
          return {
            count:
              data?.initializationStatus ===
              UserPracticeInitializationStatus.READY
                ? 0
                : 1,
          };
        },
      },
    );

    await expect(
      processNextPracticeStateBackfill(mock.prisma as never, {
        applyAttemptState: (async () => appliedResult()) as never,
      }),
    ).rejects.toBeInstanceOf(PracticeStateLeaseLostError);
  });

  it('releases a partial batch for immediate continuation while excluding concurrent owners', async () => {
    const pending = ['attempt-a', 'attempt-b', 'attempt-c'].map((id) =>
      submittedAttempt(id, '2026-07-01T00:00:00.000Z'),
    );
    const profile = {
      initializationStatus: UserPracticeInitializationStatus.PENDING,
      leaseOwnerToken: null as string | null,
      leasedUntil: null as Date | null,
      initializedThroughAttemptId: null as string | null,
      initializedThroughAttemptAt: null as Date | null,
    };
    type ProfileWhere = {
      leaseOwnerToken?: string;
      initializationStatus?: UserPracticeInitializationStatus | { not: UserPracticeInitializationStatus };
      OR?: Array<{ leasedUntil: null | { lt: Date } }>;
    };
    const matches = (where: ProfileWhere) => {
      if (where.leaseOwnerToken && where.leaseOwnerToken !== profile.leaseOwnerToken) return false;
      if (typeof where.initializationStatus === 'string' && where.initializationStatus !== profile.initializationStatus) return false;
      return !where.OR || where.OR.some((condition) =>
        condition.leasedUntil === null
          ? profile.leasedUntil === null
          : profile.leasedUntil !== null && profile.leasedUntil < condition.leasedUntil.lt,
      );
    };
    const updateMany = jest.fn(async ({ where, data }: { where: ProfileWhere; data: Partial<typeof profile> }) => {
      if (!matches(where)) return { count: 0 };
      Object.assign(profile, data);
      return { count: 1 };
    });
    const prisma = {
      userPracticeProfile: {
        upsert: async () => ({}),
        findUniqueOrThrow: async () => ({ ...profile }),
        findFirst: async ({ where }: { where: ProfileWhere }) => matches(where) ? { userId: 'user-1' } : null,
        updateMany,
      },
      quizAttempt: {
        findMany: async (args: { distinct?: string[]; take: number }) => args.distinct
          ? (pending.length && (!profile.leasedUntil || profile.leasedUntil < new Date()) ? [{ userId: 'user-1' }] : [])
          : pending.slice(0, args.take),
        count: async () => pending.length,
      },
      $transaction: async (action: (transaction: unknown) => Promise<unknown>) =>
        action({ userPracticeProfile: { updateMany } }),
    };
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    const firstFinishes = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const applied: string[] = [];
    const applyAttemptState = async (_transaction: unknown, attempt: { id: string }) => {
      if (attempt.id === 'attempt-a') {
        signalFirst();
        await firstFinishes;
      }
      applied.push(attempt.id);
      pending.splice(pending.findIndex((item) => item.id === attempt.id), 1);
      return appliedResult();
    };
    const options = { batchSize: 2, applyAttemptState: applyAttemptState as never };
    const first = processNextPracticeStateBackfill(prisma as never, options);
    await firstStarted;
    try {
      await expect(processNextPracticeStateBackfill(prisma as never, options)).resolves.toBe(false);
    } finally {
      releaseFirst();
      await first;
    }
    expect(profile).toMatchObject({
      initializationStatus: UserPracticeInitializationStatus.PENDING,
      leaseOwnerToken: null,
      leasedUntil: null,
      initializedThroughAttemptId: 'attempt-b',
    });
    await expect(processNextPracticeStateBackfill(prisma as never, options)).resolves.toBe(true);
    expect(applied).toEqual(['attempt-a', 'attempt-b', 'attempt-c']);
    expect(profile).toMatchObject({
      initializationStatus: UserPracticeInitializationStatus.READY,
      leaseOwnerToken: null,
      leasedUntil: null,
      initializedThroughAttemptId: 'attempt-c',
    });
  });

  it('does not release a partial batch after its ownership changes', async () => {
    const mock = buildPrisma(
      [submittedAttempt('attempt-a', '2026-07-01T00:00:00.000Z')],
      {
        remaining: 1,
        updateMany: async (args) => {
          const data = args.data as { initializationStatus?: UserPracticeInitializationStatus };
          return { count: data.initializationStatus === UserPracticeInitializationStatus.PENDING ? 0 : 1 };
        },
      },
    );
    await expect(
      processNextPracticeStateBackfill(mock.prisma as never, {
        applyAttemptState: (async () => appliedResult()) as never,
      }),
    ).rejects.toBeInstanceOf(PracticeStateLeaseLostError);
    expect(mock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        initializationStatus: UserPracticeInitializationStatus.PROCESSING,
        leaseOwnerToken: expect.any(String),
      }),
      data: {
        initializationStatus: UserPracticeInitializationStatus.PENDING,
        leaseOwnerToken: null,
        leasedUntil: null,
      },
    }));
  });
});
