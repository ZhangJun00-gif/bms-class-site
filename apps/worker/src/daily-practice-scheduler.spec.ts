import {
  DailyPracticeCycleStatus,
  DailyPracticeDayStatus,
  Prisma,
  QuizQuestionOrigin,
  QuizQuestionReviewStatus,
} from '@prisma/client';
import {
  freezeCycleInputs,
  finalizePastDailyPracticeSuggestions,
  processDailyPracticeSchedulerTick,
  processRequestedCycleRefreeze,
  refreshInvalidatedFixedQuestions,
  reconcileDailyPracticeCycle,
  sha256,
  shiftScheduleToResumeWindow,
} from './daily-practice-scheduler';
import { abortActiveDayGeneration } from './daily-practice-active-days';

jest.mock('./daily-practice-active-days', () => ({
  abortActiveDayGeneration: jest.fn(),
}));

describe('daily practice scheduler', () => {
  it('creates no cycle or day while the service is disabled', async () => {
    const prisma = {
      dailyPracticeSuggestion: { findMany: jest.fn(async () => []) },
      dailyPracticeSettings: {
        findUnique: jest.fn(async () => ({
          enabled: false,
          revision: 3,
          reason: '假期暂停',
        })),
      },
      dailyPracticeServicePause: { findFirst: jest.fn(async () => null) },
      dailyPracticeCycle: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(),
      },
      dailyPracticeDay: { createMany: jest.fn() },
    };

    await expect(
      processDailyPracticeSchedulerTick(
        prisma as never,
        new Date('2026-07-28T20:00:00.000Z'),
      ),
    ).resolves.toBe(false);
    expect(prisma.dailyPracticeCycle.create).not.toHaveBeenCalled();
    expect(prisma.dailyPracticeDay.createMany).not.toHaveBeenCalled();
  });

  it('pauses an existing cycle without creating new plans', async () => {
    const transaction = jest.fn(async () => []);
    const prisma = {
      dailyPracticeSuggestion: { findMany: jest.fn(async () => []) },
      dailyPracticeSettings: {
        findUnique: jest.fn(async () => ({ enabled: true, revision: 4, reason: null })),
      },
      dailyPracticeServicePause: {
        findFirst: jest.fn(async () => ({ reason: '假期', endsAt: new Date('2026-08-01') })),
      },
      dailyPracticeCycle: {
        findUnique: jest.fn(async () => ({ id: 'cycle-1' })),
        updateMany: jest.fn(() => ({ kind: 'cycle-update' })),
        create: jest.fn(),
      },
      dailyPracticeDay: {
        updateMany: jest.fn(() => ({ kind: 'day-update' })),
        createMany: jest.fn(),
      },
      $transaction: transaction,
    };
    await expect(
      processDailyPracticeSchedulerTick(prisma as never, new Date('2026-07-28T08:00:00Z')),
    ).resolves.toBe(true);
    expect(prisma.dailyPracticeCycle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: DailyPracticeCycleStatus.PAUSED } }),
    );
    expect(prisma.dailyPracticeDay.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: DailyPracticeDayStatus.PENDING }),
      }),
    );
    expect(prisma.dailyPracticeDay.createMany).not.toHaveBeenCalled();
  });

  it('freezes one fixed set and excludes every invalid fixed question uniformly', async () => {
    const prompt = '统一固定题';
    const progress = (id: string, version: number, path: string) => ({
      id,
      subjectId: 'subject-1',
      version,
      scopeHash: `${version}`.repeat(64).slice(0, 64),
      effectivePracticeDate: new Date('2026-07-28'),
      publishedAt: new Date('2026-07-27'),
      nodes: [
        {
          libraryId: 'library-1',
          documentId: 'document-1',
          nodePathHash: path.repeat(64).slice(0, 64),
          currentKnowledgeNodeId: `node-${version}`,
          titleSnapshot: `知识点 ${version}`,
          breadcrumbSnapshot: `章节 > 知识点 ${version}`,
          firstTaughtDate: new Date('2026-07-01'),
        },
      ],
    });
    const question = (
      id: string,
      origin: QuizQuestionOrigin,
      options: { subjectActive?: boolean; chapterActive?: boolean } = {},
    ) => ({
      id,
      enabled: true,
      reviewStatus: QuizQuestionReviewStatus.APPROVED,
      reviewRevision: 2,
      sourceRevision: 3,
      origin,
      prompt,
      type: 'SINGLE' as const,
      typeLabel: '单选题',
      subjectId: 'subject-1',
      subject: { name: '生理学', active: options.subjectActive ?? true },
      chapters: [
        {
          chapterId: 'chapter-1',
          chapter: { active: options.chapterActive ?? true },
        },
      ],
    });
    const prisma = {
      teachingProgress: {
        findMany: jest.fn(async () => [
          progress('new-progress', 2, 'b'),
          progress('old-progress', 1, 'a'),
        ]),
      },
      knowledgeDocument: {
        findMany: jest.fn(async () => [
          {
            id: 'document-1',
            libraryId: 'library-1',
            subjectId: 'subject-1',
            activeVersion: {
              nodes: [
                {
                  id: 'node-current',
                  pathHash: 'b'.repeat(64),
                  title: '当前知识点',
                  breadcrumb: '当前章节 > 当前知识点',
                  libraryChapter: { libraryId: 'library-1' },
                },
              ],
            },
          },
        ]),
      },
      subject: {
        findMany: jest.fn(async () => [{ id: 'subject-1', name: '生理学' }]),
      },
      quizQuestion: {
        findMany: jest.fn(async () => [
          {
            id: 'candidate-legacy-source',
            subjectId: 'subject-1',
            type: 'SINGLE',
            sourceRevision: 3,
            knowledgeSources: [
              {
                documentId: 'document-1',
                nodePathHash: null,
                sourceRevision: 3,
                knowledgeNode: { pathHash: 'b'.repeat(64) },
              },
            ],
          },
        ]),
      },
      dailyPracticeFixedAssignment: {
        findFirst: jest.fn(async () => ({
          id: 'assignment-1',
          questions: [
            {
              ordinal: 1,
              questionReviewRevision: 2,
              promptHash: sha256(prompt),
              question: question('fixed-valid', QuizQuestionOrigin.MANUAL),
            },
            {
              ordinal: 2,
              questionReviewRevision: 2,
              promptHash: sha256(prompt),
              question: question('fixed-ai', QuizQuestionOrigin.AI_GENERATED),
            },
            {
              ordinal: 3,
              questionReviewRevision: 2,
              promptHash: sha256(prompt),
              question: question('fixed-inactive-subject', QuizQuestionOrigin.CSV, {
                subjectActive: false,
              }),
            },
            {
              ordinal: 4,
              questionReviewRevision: 2,
              promptHash: sha256(prompt),
              question: question('fixed-inactive-chapter', QuizQuestionOrigin.MANUAL, {
                chapterActive: false,
              }),
            },
          ],
        })),
      },
    };

    const frozen = await freezeCycleInputs(prisma as never, '2026-07-28');
    expect(frozen.progressSnapshot).toHaveLength(1);
    expect(frozen.progressSnapshot[0]?.progressId).toBe('new-progress');
    expect(frozen.progressSnapshot[0]?.currentKnowledgeNodeId).toBe('node-current');
    expect(frozen.progressSnapshot[0]?.title).toBe('当前知识点');
    expect(frozen.unresolvedProgressNodeCount).toBe(0);
    expect(frozen.fixedQuestionSnapshot.map((item) => item.questionId)).toEqual([
      'fixed-valid',
    ]);
    expect(frozen.invalidFixedQuestionIds).toEqual([
      'fixed-ai',
      'fixed-inactive-subject',
      'fixed-inactive-chapter',
    ]);
    expect(frozen.fixedQuestionSnapshot[0]?.ordinal).toBe(1);
    expect(frozen.frozenFixedAssignmentHash).toHaveLength(64);
    expect(frozen.candidateQuestionCount).toBe(1);
    expect(frozen.candidateSetHash).toHaveLength(64);
    expect(frozen.candidateTypeCounts).toEqual({ SINGLE: 1 });
    expect(frozen.gapSummary).toEqual([
      {
        subjectId: 'subject-1',
        subject: '生理学',
        nodeCount: 1,
        eligibleQuestionCount: 1,
      },
    ]);
    expect(prisma.knowledgeDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: 'MARKDOWN',
          library: expect.objectContaining({ scope: 'SHARED' }),
          activeVersion: {
            is: expect.objectContaining({ renderStatus: 'READY' }),
          },
        }),
      }),
    );
  });

  it('drops progress nodes that cannot be resolved in the current active version', async () => {
    const prisma = {
      teachingProgress: {
        findMany: jest.fn(async () => [
          {
            id: 'progress-1',
            subjectId: 'subject-1',
            version: 1,
            scopeHash: 'a'.repeat(64),
            effectivePracticeDate: new Date('2026-07-28'),
            publishedAt: new Date('2026-07-27'),
            nodes: [
              {
                libraryId: 'library-1',
                documentId: 'document-1',
                nodePathHash: 'b'.repeat(64),
                currentKnowledgeNodeId: 'retired-node',
                titleSnapshot: '旧标题',
                breadcrumbSnapshot: '旧路径',
                firstTaughtDate: new Date('2026-07-01'),
              },
            ],
          },
        ]),
      },
      knowledgeDocument: { findMany: jest.fn(async () => []) },
      subject: {
        findMany: jest.fn(async () => [{ id: 'subject-1', name: '生理学' }]),
      },
      dailyPracticeFixedAssignment: { findFirst: jest.fn(async () => null) },
    };

    const frozen = await freezeCycleInputs(prisma as never, '2026-07-28');
    expect(frozen.progressSnapshot).toEqual([]);
    expect(frozen.unresolvedProgressNodeCount).toBe(1);
    expect(frozen.candidateQuestionCount).toBe(0);
    expect(frozen.gapSummary).toEqual([
      {
        subjectId: 'subject-1',
        subject: '生理学',
        nodeCount: 1,
        eligibleQuestionCount: 0,
      },
    ]);
  });

  it('preserves deterministic offsets when moving a paused schedule to a new window', () => {
    const original = new Date('2026-07-27T20:00:00.000Z');
    const resumed = new Date('2026-07-28T08:00:00.000Z');
    const shifted = shiftScheduleToResumeWindow(
      [
        { userId: 'u1', scheduledAt: new Date(original.getTime() + 1_000) },
        { userId: 'u2', scheduledAt: new Date(original.getTime() + 20_000) },
      ],
      original,
      resumed,
    );
    expect(shifted.map((item) => item.scheduledAt.getTime())).toEqual([
      resumed.getTime() + 1_000,
      resumed.getTime() + 20_000,
    ]);
  });

  it('rebuilds one uniform fixed snapshot for every unstarted day', async () => {
    const frozen = ['fixed-valid', 'fixed-disabled'].map((questionId, index) => ({
      questionId,
      ordinal: index + 1,
      questionReviewRevision: 2,
      sourceRevision: 3,
      promptHash: sha256(`Prompt ${questionId}`),
      gradingType: 'SINGLE' as const,
      typeLabel: '单选题',
      promptExcerpt: `Prompt ${questionId}`,
      subjectId: 'subject-1',
      subjectName: '生理学',
      chapterIds: ['chapter-1'],
    }));
    const dayUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });
    const transaction = {
      $queryRaw: jest.fn(async () => [{ id: 'cycle-1' }]),
      dailyPracticeCycle: {
        findUnique: jest.fn(async () => ({
          id: 'cycle-1',
          status: DailyPracticeCycleStatus.READY,
          poolStats: {
            frozenFixedQuestions: frozen,
            invalidFixedQuestionIds: [],
          },
          counts: {
            activeUsers: 4,
            terminalUsers: 4,
            finalizedAt: '2026-07-28T20:30:00.000Z',
          },
        })),
        update: jest.fn(async () => ({ id: 'cycle-1' })),
      },
      quizQuestion: {
        findMany: jest.fn(async () =>
          frozen.map((question) => ({
            id: question.questionId,
            enabled: question.questionId === 'fixed-valid',
            origin: QuizQuestionOrigin.MANUAL,
            reviewStatus: QuizQuestionReviewStatus.APPROVED,
            reviewRevision: 2,
            sourceRevision: 3,
            prompt: `Prompt ${question.questionId}`,
            subject: { active: true },
            chapters: [{ chapter: { active: true } }],
          })),
        ),
      },
      dailyPracticePlanRevision: {
        updateMany: jest.fn(async () => ({ count: 2 })),
      },
      dailyPracticeDay: { updateMany: dayUpdateMany },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };

    await expect(
      refreshInvalidatedFixedQuestions(prisma as never, 'cycle-1'),
    ).resolves.toBe(true);

    expect(transaction.dailyPracticePlanRevision.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ generatedAt: null }),
        data: expect.objectContaining({
          degradedReason: 'FIXED_QUESTION_INVALIDATED',
        }),
      }),
    );
    expect(dayUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ startedAt: null, completedAt: null }),
        data: expect.objectContaining({
          status: DailyPracticeDayStatus.STALE,
          fixedQuestionSnapshot: [
            expect.objectContaining({
              questionId: 'fixed-valid',
              ordinal: 1,
            }),
          ],
        }),
      }),
    );
    expect(dayUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: DailyPracticeDayStatus.PAUSED,
        }),
        data: expect.not.objectContaining({ status: expect.anything() }),
      }),
    );
    expect(transaction.dailyPracticeCycle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DailyPracticeCycleStatus.GENERATING,
          poolStats: expect.objectContaining({
            invalidFixedQuestionIds: ['fixed-disabled'],
          }),
          counts: { activeUsers: 4 },
        }),
      }),
    );
  });

  it('recomputes the practice date after locking settings before cycle freeze', async () => {
    const beforeBoundary = new Date('2026-07-28T19:59:59.999Z');
    const afterBoundary = new Date('2026-07-28T20:00:00.000Z');
    const instants = [beforeBoundary, afterBoundary];
    const clock = jest.fn(() => new Date((instants.shift() ?? afterBoundary).getTime()));
    let cycle: Record<string, unknown> | null = null;
    const prisma: Record<string, any> = {
      dailyPracticeSuggestion: { findMany: jest.fn(async () => []) },
      dailyPracticeSettings: {
        findUnique: jest.fn(async () => ({ enabled: true, revision: 7, reason: null })),
      },
      dailyPracticeServicePause: { findFirst: jest.fn(async () => null) },
      dailyPracticeCycle: {
        findUnique: jest.fn(async ({ where }: { where: { practiceDate: Date } }) =>
          cycle &&
          (cycle.practiceDate as Date).getTime() === where.practiceDate.getTime()
            ? cycle
            : null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          cycle = {
            id: 'cycle-1',
            ...data,
            poolStats: data.poolStats,
            leaseOwnerToken: null,
            leasedUntil: null,
            lastErrorCategory: null,
          };
          return cycle;
        }),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      teachingProgress: { findMany: jest.fn(async () => []) },
      knowledgeDocument: { findMany: jest.fn(async () => []) },
      dailyPracticeFixedAssignment: { findFirst: jest.fn(async () => null) },
      user: { findMany: jest.fn(async () => []) },
      userPracticeProfile: {
        createMany: jest.fn(async () => ({ count: 0 })),
        findMany: jest.fn(async () => []),
      },
      dailyPracticeDay: {
        createMany: jest.fn(async () => ({ count: 0 })),
        updateMany: jest.fn(async () => ({ count: 0 })),
        count: jest.fn(async () => 0),
      },
      $queryRaw: jest.fn(async () => [{ singletonId: 1 }]),
    };
    prisma.$transaction = jest.fn(async (input: unknown) =>
      typeof input === 'function'
        ? (input as (value: unknown) => Promise<unknown>)(prisma)
        : Promise.all(input as Promise<unknown>[]),
    );

    await expect(
      processDailyPracticeSchedulerTick(prisma as never, clock),
    ).resolves.toBe(true);
    expect(prisma.dailyPracticeCycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          practiceDate: new Date('2026-07-29T00:00:00.000Z'),
          candidateCutoffAt: afterBoundary,
        }),
      }),
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.teachingProgress.findMany.mock.invocationCallOrder[0]!,
    );
    expect(prisma.teachingProgress.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.dailyPracticeCycle.create.mock.invocationCallOrder[0]!,
    );
  });

  it('reschedules paused days from the resume instant instead of releasing them at once', async () => {
    const resumedAt = new Date('2026-07-28T08:00:00.000Z');
    const cycle = {
      id: 'cycle-1',
      practiceDate: new Date('2026-07-28T00:00:00.000Z'),
      baselineAt: new Date('2026-07-27T20:00:00.000Z'),
      deadlineAt: new Date('2026-07-27T20:30:00.000Z'),
      candidateCutoffAt: new Date('2026-07-27T20:00:00.000Z'),
      status: DailyPracticeCycleStatus.PAUSED,
      settingsRevision: 1,
      progressSetHash: 'a'.repeat(64),
      progressSnapshot: [],
      fixedAssignmentId: null,
      frozenFixedAssignmentHash: 'b'.repeat(64),
      poolStats: { frozenFixedQuestions: [] },
      counts: {},
      leaseOwnerToken: null,
      leasedUntil: null,
      lastErrorCategory: null,
      lastErrorMessage: null,
    };
    const dayUpdate = jest.fn(async (_args: Record<string, any>) => ({ count: 1 }));
    const prisma: Record<string, any> = {
      dailyPracticeSuggestion: { findMany: jest.fn(async () => []) },
      dailyPracticeSettings: {
        findUnique: jest.fn(async () => ({ enabled: true, revision: 1, reason: null })),
      },
      dailyPracticeServicePause: { findFirst: jest.fn(async () => null) },
      dailyPracticeCycle: {
        findUnique: jest.fn(async () => cycle),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      user: {
        findMany: jest.fn(async () => [{ id: 'user-1' }, { id: 'user-2' }]),
      },
      userPracticeProfile: {
        createMany: jest.fn(async () => ({ count: 0 })),
        findMany: jest.fn(async () => [
          { userId: 'user-1', stateRevision: 1 },
          { userId: 'user-2', stateRevision: 2 },
        ]),
      },
      dailyPracticeDay: {
        createMany: jest.fn(async () => ({ count: 0 })),
        updateMany: dayUpdate,
        count: jest.fn(async () => 2),
      },
    };
    prisma.$transaction = jest.fn(async (input: Promise<unknown>[]) =>
      Promise.all(input),
    );

    await expect(
      processDailyPracticeSchedulerTick(prisma as never, resumedAt),
    ).resolves.toBe(true);
    const resumedUpdates = dayUpdate.mock.calls
      .map(([call]) => call!)
      .filter((call) => call.data?.status === DailyPracticeDayStatus.PENDING);
    expect(resumedUpdates).toHaveLength(2);
    for (const call of resumedUpdates) {
      expect(call.data.scheduledAt.getTime()).toBeGreaterThanOrEqual(
        resumedAt.getTime(),
      );
      expect(call.data.deadlineAt).toEqual(
        new Date(resumedAt.getTime() + 30 * 60_000),
      );
    }
    expect(
      new Set(resumedUpdates.map((call) => call.data.scheduledAt.getTime())).size,
    ).toBe(2);
    expect(dayUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cycleId: 'cycle-1',
          status: DailyPracticeDayStatus.PAUSED,
        },
        data: expect.objectContaining({
          status: DailyPracticeDayStatus.FAILED,
          lastErrorCategory: 'NOT_ELIGIBLE_DURING_RESUME',
        }),
      }),
    );
  });

  it('creates and reads user practice profiles in batches of at most 500', async () => {
    const users = Array.from({ length: 501 }, (_, index) => ({
      id: `user-${String(index).padStart(3, '0')}`,
    }));
    const cycle = {
      id: 'cycle-batched',
      practiceDate: new Date('2026-07-28T00:00:00.000Z'),
      baselineAt: new Date('2026-07-27T20:00:00.000Z'),
      deadlineAt: new Date('2026-07-27T20:30:00.000Z'),
      status: DailyPracticeCycleStatus.BUILDING,
      progressSetHash: 'a'.repeat(64),
      poolStats: { frozenFixedQuestions: [] },
      counts: {},
      leaseOwnerToken: null,
      leasedUntil: null,
    };
    const profileCreateMany = jest.fn(
      async (_args: { data: Array<{ userId: string }> }) => ({ count: 0 }),
    );
    const profileFindMany = jest.fn(
      async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.map((userId) => ({ userId, stateRevision: 1 })),
    );
    const prisma: Record<string, any> = {
      dailyPracticeSuggestion: { findMany: jest.fn(async () => []) },
      dailyPracticeSettings: {
        findUnique: jest.fn(async () => ({ enabled: true, revision: 1, reason: null })),
      },
      dailyPracticeServicePause: { findFirst: jest.fn(async () => null) },
      dailyPracticeCycle: {
        findUnique: jest.fn(async () => cycle),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      user: { findMany: jest.fn(async () => users) },
      userPracticeProfile: {
        createMany: profileCreateMany,
        findMany: profileFindMany,
      },
      dailyPracticeDay: {
        createMany: jest.fn(async () => ({ count: 0 })),
        count: jest.fn(async () => users.length),
      },
    };
    prisma.$transaction = jest.fn(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    );

    await expect(
      processDailyPracticeSchedulerTick(
        prisma as never,
        new Date('2026-07-27T20:00:00.000Z'),
      ),
    ).resolves.toBe(true);

    expect(profileCreateMany).toHaveBeenCalledTimes(2);
    expect(profileFindMany).toHaveBeenCalledTimes(2);
    for (const [call] of profileCreateMany.mock.calls) {
      expect(call.data.length).toBeLessThanOrEqual(500);
    }
    for (const [call] of profileFindMany.mock.calls) {
      expect(call.where.userId.in.length).toBeLessThanOrEqual(500);
    }
  });

  it('does not rescan all users after a cycle has entered generation', async () => {
    const userFindMany = jest.fn();
    const prisma = {
      dailyPracticeSuggestion: { findMany: jest.fn(async () => []) },
      dailyPracticeSettings: {
        findUnique: jest.fn(async () => ({ enabled: true, revision: 1, reason: null })),
      },
      dailyPracticeServicePause: { findFirst: jest.fn(async () => null) },
      dailyPracticeCycle: {
        findUnique: jest.fn(async () => ({
          id: 'cycle-1',
          status: DailyPracticeCycleStatus.GENERATING,
        })),
        updateMany: jest.fn(),
      },
      dailyPracticeDay: {
        groupBy: jest.fn(async () => [
          {
            status: DailyPracticeDayStatus.PENDING,
            _count: { _all: 2 },
          },
        ]),
      },
      user: { findMany: userFindMany },
    };
    await expect(
      processDailyPracticeSchedulerTick(
        prisma as never,
        new Date('2026-07-28T08:00:00.000Z'),
      ),
    ).resolves.toBe(false);
    expect(userFindMany).not.toHaveBeenCalled();
    expect(prisma.dailyPracticeCycle.updateMany).not.toHaveBeenCalled();
  });

  it('finalizes a cycle from aggregate day states without rescanning users', async () => {
    const prisma = {
      dailyPracticeDay: {
        groupBy: jest.fn(async () => [
          { status: DailyPracticeDayStatus.READY, _count: { _all: 2 } },
          {
            status: DailyPracticeDayStatus.DEGRADED_READY,
            _count: { _all: 1 },
          },
        ]),
      },
      dailyPracticeCycle: {
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const finalizedAt = new Date('2026-07-28T20:30:00.000Z');

    await expect(
      reconcileDailyPracticeCycle(
        prisma as never,
        'cycle-1',
        { activeUsers: 3 },
        finalizedAt,
      ),
    ).resolves.toBe(true);
    expect(prisma.dailyPracticeCycle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DailyPracticeCycleStatus.DEGRADED,
          counts: expect.objectContaining({
            totalUsers: 3,
            terminalUsers: 3,
            finalizedAt: finalizedAt.toISOString(),
          }),
        }),
      }),
    );
  });

  it('keeps a cycle open while stale plans are waiting for rebuild', async () => {
    const prisma = {
      dailyPracticeDay: {
        groupBy: jest.fn(async () => [
          { status: DailyPracticeDayStatus.STALE, _count: { _all: 1 } },
          { status: DailyPracticeDayStatus.READY, _count: { _all: 2 } },
        ]),
      },
      dailyPracticeCycle: { updateMany: jest.fn() },
    };

    await expect(
      reconcileDailyPracticeCycle(prisma as never, 'cycle-1', {}, new Date()),
    ).resolves.toBe(false);
    expect(prisma.dailyPracticeCycle.updateMany).not.toHaveBeenCalled();
  });

  it('expires past suggestions without a cycle and never rolls them forward', async () => {
    const updateMany = jest.fn(
      async ({ data }: { data: { status: string } }) => ({
        count: data.status === 'EXPIRED_SERVICE_PAUSED' ? 2 : 1,
      }),
    );
    const prisma = {
      dailyPracticeSuggestion: {
        findMany: jest.fn(async () => [
          {
            id: 'suggestion-paused-1',
            targetPracticeDate: new Date('2026-07-27T00:00:00.000Z'),
          },
          {
            id: 'suggestion-paused-2',
            targetPracticeDate: new Date('2026-07-27T00:00:00.000Z'),
          },
          {
            id: 'suggestion-cycle',
            targetPracticeDate: new Date('2026-07-28T00:00:00.000Z'),
          },
        ]),
        updateMany,
      },
      dailyPracticeCycle: {
        findMany: jest.fn(async () => [
          { practiceDate: new Date('2026-07-28T00:00:00.000Z') },
        ]),
      },
      $transaction: jest.fn(async (operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };

    await expect(
      finalizePastDailyPracticeSuggestions(
        prisma as never,
        new Date('2026-07-29T00:00:00.000Z'),
      ),
    ).resolves.toBe(3);
    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: {
            in: ['suggestion-paused-1', 'suggestion-paused-2'],
          },
        }),
        data: { status: 'EXPIRED_SERVICE_PAUSED' },
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['suggestion-cycle'] },
        }),
        data: { status: 'NOT_APPLIED' },
      }),
    );
  });

  it('remaps a progress node to the single replacement document in the same library', async () => {
    const prisma = {
      teachingProgress: {
        findMany: jest.fn(async () => [
          {
            id: 'progress-1',
            subjectId: 'subject-1',
            version: 1,
            scopeHash: 'a'.repeat(64),
            effectivePracticeDate: new Date('2026-07-28'),
            publishedAt: new Date('2026-07-27'),
            nodes: [
              {
                libraryId: 'library-1',
                documentId: 'document-old',
                nodePathHash: 'b'.repeat(64),
                currentKnowledgeNodeId: 'retired-node',
                titleSnapshot: '旧标题',
                breadcrumbSnapshot: '旧路径',
                firstTaughtDate: new Date('2026-07-01'),
              },
            ],
          },
        ]),
      },
      knowledgeDocument: {
        findMany: jest.fn(
          async (args: { where: { id?: { in: string[] } } }) =>
            args.where.id
              ? []
              : [
                  {
                    id: 'document-new',
                    libraryId: 'library-1',
                    subjectId: 'subject-1',
                    activeVersion: {
                      nodes: [
                        {
                          id: 'node-new',
                          pathHash: 'b'.repeat(64),
                          title: '替换文档知识点',
                          breadcrumb: '章节 > 替换文档知识点',
                          libraryChapter: { libraryId: 'library-1' },
                        },
                      ],
                    },
                  },
                ],
        ),
      },
      subject: {
        findMany: jest.fn(async () => [{ id: 'subject-1', name: '生理学' }]),
      },
      quizQuestion: { findMany: jest.fn(async () => []) },
      dailyPracticeFixedAssignment: { findFirst: jest.fn(async () => null) },
    };

    const frozen = await freezeCycleInputs(prisma as never, '2026-07-28');
    expect(frozen.progressSnapshot).toHaveLength(1);
    expect(frozen.progressSnapshot[0]?.documentId).toBe('document-new');
    expect(frozen.progressSnapshot[0]?.nodePathHash).toBe('b'.repeat(64));
    expect(frozen.progressSnapshot[0]?.currentKnowledgeNodeId).toBe('node-new');
    expect(frozen.progressSnapshot[0]?.title).toBe('替换文档知识点');
    expect(frozen.progressSnapshot[0]?.breadcrumb).toBe('章节 > 替换文档知识点');
    expect(frozen.progressSnapshot[0]?.remappedFromDocumentId).toBe(
      'document-old',
    );
    expect(frozen.unresolvedProgressNodeCount).toBe(0);
    expect(frozen.remappedProgressNodeCount).toBe(1);
    expect(prisma.knowledgeDocument.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.knowledgeDocument.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          libraryId: { in: ['library-1'] },
          subjectId: { in: ['subject-1'] },
          kind: 'MARKDOWN',
          library: expect.objectContaining({ scope: 'SHARED' }),
          activeVersion: {
            is: expect.objectContaining({ renderStatus: 'READY' }),
          },
        }),
      }),
    );
  });

  it('keeps a progress node unresolved when two replacement documents match', async () => {
    const replacement = (id: string, nodeId: string) => ({
      id,
      libraryId: 'library-1',
      subjectId: 'subject-1',
      activeVersion: {
        nodes: [
          {
            id: nodeId,
            pathHash: 'b'.repeat(64),
            title: '替换文档知识点',
            breadcrumb: '章节 > 替换文档知识点',
            libraryChapter: { libraryId: 'library-1' },
          },
        ],
      },
    });
    const prisma = {
      teachingProgress: {
        findMany: jest.fn(async () => [
          {
            id: 'progress-1',
            subjectId: 'subject-1',
            version: 1,
            scopeHash: 'a'.repeat(64),
            effectivePracticeDate: new Date('2026-07-28'),
            publishedAt: new Date('2026-07-27'),
            nodes: [
              {
                libraryId: 'library-1',
                documentId: 'document-old',
                nodePathHash: 'b'.repeat(64),
                currentKnowledgeNodeId: 'retired-node',
                titleSnapshot: '旧标题',
                breadcrumbSnapshot: '旧路径',
                firstTaughtDate: new Date('2026-07-01'),
              },
            ],
          },
        ]),
      },
      knowledgeDocument: {
        findMany: jest.fn(
          async (args: { where: { id?: { in: string[] } } }) =>
            args.where.id
              ? []
              : [
                  replacement('document-new-a', 'node-new-a'),
                  replacement('document-new-b', 'node-new-b'),
                ],
        ),
      },
      subject: {
        findMany: jest.fn(async () => [{ id: 'subject-1', name: '生理学' }]),
      },
      quizQuestion: { findMany: jest.fn(async () => []) },
      dailyPracticeFixedAssignment: { findFirst: jest.fn(async () => null) },
    };

    const frozen = await freezeCycleInputs(prisma as never, '2026-07-28');
    expect(frozen.progressSnapshot).toEqual([]);
    expect(frozen.unresolvedProgressNodeCount).toBe(1);
    expect(frozen.remappedProgressNodeCount).toBe(0);
  });

  it('resolves against a healthy original document without any remap', async () => {
    const prisma = {
      teachingProgress: {
        findMany: jest.fn(async () => [
          {
            id: 'progress-1',
            subjectId: 'subject-1',
            version: 1,
            scopeHash: 'a'.repeat(64),
            effectivePracticeDate: new Date('2026-07-28'),
            publishedAt: new Date('2026-07-27'),
            nodes: [
              {
                libraryId: 'library-1',
                documentId: 'document-1',
                nodePathHash: 'b'.repeat(64),
                currentKnowledgeNodeId: 'node-stale-snapshot',
                titleSnapshot: '旧标题',
                breadcrumbSnapshot: '旧路径',
                firstTaughtDate: new Date('2026-07-01'),
              },
            ],
          },
        ]),
      },
      knowledgeDocument: {
        findMany: jest.fn(async () => [
          {
            id: 'document-1',
            libraryId: 'library-1',
            subjectId: 'subject-1',
            activeVersion: {
              nodes: [
                {
                  id: 'node-current',
                  pathHash: 'b'.repeat(64),
                  title: '当前知识点',
                  breadcrumb: '当前章节 > 当前知识点',
                  libraryChapter: { libraryId: 'library-1' },
                },
              ],
            },
          },
        ]),
      },
      subject: {
        findMany: jest.fn(async () => [{ id: 'subject-1', name: '生理学' }]),
      },
      quizQuestion: { findMany: jest.fn(async () => []) },
      dailyPracticeFixedAssignment: { findFirst: jest.fn(async () => null) },
    };

    const frozen = await freezeCycleInputs(prisma as never, '2026-07-28');
    expect(frozen.progressSnapshot).toHaveLength(1);
    expect(frozen.progressSnapshot[0]?.documentId).toBe('document-1');
    expect(frozen.progressSnapshot[0]?.currentKnowledgeNodeId).toBe(
      'node-current',
    );
    expect(frozen.progressSnapshot[0]).not.toHaveProperty(
      'remappedFromDocumentId',
    );
    expect(frozen.unresolvedProgressNodeCount).toBe(0);
    expect(frozen.remappedProgressNodeCount).toBe(0);
    expect(prisma.knowledgeDocument.findMany).toHaveBeenCalledTimes(1);
  });

  it('refreezes a requested cycle and rebuilds every unstarted day uniformly', async () => {
    const prompt = '统一固定题';
    const dayUpdateMany = jest
      .fn(async (_args: Record<string, any>) => ({ count: 0 }))
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });
    const transaction = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ singletonId: 1 }])
        .mockResolvedValueOnce([{ id: 'cycle-1' }]),
      dailyPracticeCycle: {
        findUnique: jest.fn(async () => ({
          id: 'cycle-1',
          status: DailyPracticeCycleStatus.READY,
          poolStats: {
            frozenFixedQuestions: [],
            invalidFixedQuestionIds: [],
          },
          counts: {
            activeUsers: 5,
            totalUsers: 5,
            terminalUsers: 5,
            statusCounts: { READY: 5 },
            finalizedAt: '2026-07-28T20:30:00.000Z',
          },
          practiceDate: new Date('2026-07-28T00:00:00.000Z'),
          refreezeRequestedAt: new Date('2026-07-28T21:00:00.000Z'),
        })),
        update: jest.fn(async (_args: Record<string, any>) => ({
          id: 'cycle-1',
        })),
      },
      teachingProgress: {
        findMany: jest.fn(async () => [
          {
            id: 'progress-1',
            subjectId: 'subject-1',
            version: 1,
            scopeHash: 'a'.repeat(64),
            effectivePracticeDate: new Date('2026-07-28'),
            publishedAt: new Date('2026-07-27'),
            nodes: [
              {
                libraryId: 'library-1',
                documentId: 'document-old',
                nodePathHash: 'b'.repeat(64),
                currentKnowledgeNodeId: 'retired-node',
                titleSnapshot: '旧标题',
                breadcrumbSnapshot: '旧路径',
                firstTaughtDate: new Date('2026-07-01'),
              },
            ],
          },
        ]),
      },
      knowledgeDocument: {
        findMany: jest.fn(
          async (args: { where: { id?: { in: string[] } } }) =>
            args.where.id
              ? []
              : [
                  {
                    id: 'document-new',
                    libraryId: 'library-1',
                    subjectId: 'subject-1',
                    activeVersion: {
                      nodes: [
                        {
                          id: 'node-new',
                          pathHash: 'b'.repeat(64),
                          title: '替换文档知识点',
                          breadcrumb: '章节 > 替换文档知识点',
                          libraryChapter: { libraryId: 'library-1' },
                        },
                      ],
                    },
                  },
                ],
        ),
      },
      subject: {
        findMany: jest.fn(async () => [{ id: 'subject-1', name: '生理学' }]),
      },
      quizQuestion: { findMany: jest.fn(async () => []) },
      dailyPracticeFixedAssignment: {
        findFirst: jest.fn(async () => ({
          id: 'assignment-1',
          questions: [
            {
              ordinal: 1,
              questionReviewRevision: 2,
              promptHash: sha256(prompt),
              question: {
                id: 'fixed-valid',
                enabled: true,
                reviewStatus: QuizQuestionReviewStatus.APPROVED,
                reviewRevision: 2,
                sourceRevision: 3,
                origin: QuizQuestionOrigin.MANUAL,
                prompt,
                type: 'SINGLE' as const,
                typeLabel: '单选题',
                subjectId: 'subject-1',
                subject: { name: '生理学', active: true },
                chapters: [
                  { chapterId: 'chapter-1', chapter: { active: true } },
                ],
              },
            },
          ],
        })),
      },
      dailyPracticePlanRevision: {
        updateMany: jest.fn(async () => ({ count: 3 })),
      },
      dailyPracticeDay: {
        findMany: jest.fn(async () => [{ id: 'day-processing-1' }]),
        updateMany: dayUpdateMany,
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };

    await expect(
      processRequestedCycleRefreeze(prisma as never, 'cycle-1'),
    ).resolves.toBe(true);

    expect(transaction.dailyPracticePlanRevision.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          generatedAt: null,
          day: expect.objectContaining({ cycleId: 'cycle-1' }),
        }),
        data: expect.objectContaining({
          generatedAt: expect.any(Date),
          degradedReason: 'CYCLE_REFROZEN',
        }),
      }),
    );
    expect(dayUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          cycleId: 'cycle-1',
          status: {
            in: expect.not.arrayContaining([
              DailyPracticeDayStatus.PAUSED,
              DailyPracticeDayStatus.STARTED,
              DailyPracticeDayStatus.COMPLETED,
            ]),
          },
          startedAt: null,
          completedAt: null,
        }),
        data: expect.objectContaining({
          status: DailyPracticeDayStatus.STALE,
          candidateSnapshot: Prisma.DbNull,
          candidateHash: null,
          progressSetHash: expect.any(String),
          fixedQuestionSnapshot: [
            expect.objectContaining({ questionId: 'fixed-valid', ordinal: 1 }),
          ],
          lastErrorCategory: 'CYCLE_REFROZEN',
          lastErrorMessage: '周期已重新冻结，正在统一重建未开始计划',
          leaseOwnerToken: null,
          leasedUntil: null,
        }),
      }),
    );
    expect(dayUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          cycleId: 'cycle-1',
          status: DailyPracticeDayStatus.PAUSED,
          startedAt: null,
          completedAt: null,
        }),
        data: expect.not.objectContaining({ status: expect.anything() }),
      }),
    );
    const secondDayData = dayUpdateMany.mock.calls[1]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(secondDayData.progressSetHash).toEqual(expect.any(String));
    expect(secondDayData.fixedQuestionSnapshot).toEqual([
      expect.objectContaining({ questionId: 'fixed-valid' }),
    ]);
    expect(transaction.dailyPracticeCycle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cycle-1' },
        data: expect.objectContaining({
          status: DailyPracticeCycleStatus.GENERATING,
          progressSetHash: expect.any(String),
          progressSnapshot: [
            expect.objectContaining({
              documentId: 'document-new',
              remappedFromDocumentId: 'document-old',
            }),
          ],
          fixedAssignmentId: 'assignment-1',
          poolStats: expect.objectContaining({
            invalidFixedQuestionIds: [],
            unresolvedProgressNodeCount: 0,
            remappedProgressNodeCount: 1,
            candidateQuestionCount: 0,
            candidateSetHash: expect.any(String),
          }),
          refreezeRequestedAt: null,
          refreezeRequestedById: null,
          lastErrorCategory: null,
          lastErrorMessage: null,
        }),
      }),
    );
    const cycleUpdateData = transaction.dailyPracticeCycle.update.mock
      .calls[0]?.[0]?.data as Record<string, any>;
    expect(cycleUpdateData.counts).toEqual({ activeUsers: 5, totalUsers: 5 });
    expect(cycleUpdateData.progressSetHash).toHaveLength(64);
    expect(transaction.dailyPracticeDay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cycleId: 'cycle-1',
          startedAt: null,
          completedAt: null,
          leaseOwnerToken: { not: null },
          status: { in: expect.any(Array) },
        },
        select: { id: true },
      }),
    );
    expect(jest.mocked(abortActiveDayGeneration)).toHaveBeenCalledWith(
      'day-processing-1',
      'CYCLE_REFROZEN',
    );
  });

  it('leaves a cycle untouched when no refreeze was requested', async () => {
    const transaction = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ singletonId: 1 }])
        .mockResolvedValueOnce([{ id: 'cycle-1' }]),
      dailyPracticeCycle: {
        findUnique: jest.fn(async () => ({
          id: 'cycle-1',
          status: DailyPracticeCycleStatus.READY,
          poolStats: null,
          counts: null,
          practiceDate: new Date('2026-07-28T00:00:00.000Z'),
          refreezeRequestedAt: null,
        })),
        update: jest.fn(),
      },
      teachingProgress: { findMany: jest.fn() },
      dailyPracticePlanRevision: { updateMany: jest.fn() },
      dailyPracticeDay: { updateMany: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };

    await expect(
      processRequestedCycleRefreeze(prisma as never, 'cycle-1'),
    ).resolves.toBe(false);
    expect(transaction.teachingProgress.findMany).not.toHaveBeenCalled();
    expect(transaction.dailyPracticePlanRevision.updateMany).not.toHaveBeenCalled();
    expect(transaction.dailyPracticeDay.updateMany).not.toHaveBeenCalled();
    expect(transaction.dailyPracticeCycle.update).not.toHaveBeenCalled();
  });

  it('refreezes a requested ready cycle before reconciling it', async () => {
    const initialCycle = {
      id: 'cycle-1',
      practiceDate: new Date('2026-07-28T00:00:00.000Z'),
      status: DailyPracticeCycleStatus.READY,
      progressSetHash: 'a'.repeat(64),
      poolStats: { frozenFixedQuestions: [] },
      counts: {
        activeUsers: 2,
        totalUsers: 2,
        terminalUsers: 2,
        statusCounts: { READY: 2 },
        finalizedAt: '2026-07-28T20:30:00.000Z',
      },
      refreezeRequestedAt: new Date('2026-07-28T21:00:00.000Z'),
      refreezeRequestedById: 'admin-1',
      leaseOwnerToken: null,
      leasedUntil: null,
    };
    const refrozenCycle = {
      ...initialCycle,
      status: DailyPracticeCycleStatus.GENERATING,
      counts: { activeUsers: 2, totalUsers: 2 },
      refreezeRequestedAt: null,
      refreezeRequestedById: null,
    };
    const transaction = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ singletonId: 1 }])
        .mockResolvedValueOnce([{ id: 'cycle-1' }]),
      dailyPracticeCycle: {
        findUnique: jest.fn(async () => initialCycle),
        update: jest.fn(async () => refrozenCycle),
      },
      teachingProgress: { findMany: jest.fn(async () => []) },
      knowledgeDocument: { findMany: jest.fn(async () => []) },
      dailyPracticeFixedAssignment: { findFirst: jest.fn(async () => null) },
      dailyPracticePlanRevision: {
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      dailyPracticeDay: {
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const findUnique = jest.fn(
      async ({ where }: { where: { practiceDate?: Date; id?: string } }) =>
        where.id ? refrozenCycle : initialCycle,
    );
    const prisma: Record<string, any> = {
      dailyPracticeSuggestion: { findMany: jest.fn(async () => []) },
      dailyPracticeSettings: {
        findUnique: jest.fn(async () => ({
          enabled: true,
          revision: 1,
          reason: null,
        })),
      },
      dailyPracticeServicePause: { findFirst: jest.fn(async () => null) },
      dailyPracticeCycle: {
        findUnique,
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      dailyPracticeDay: {
        groupBy: jest.fn(async () => [
          { status: DailyPracticeDayStatus.READY, _count: { _all: 2 } },
        ]),
      },
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };

    await expect(
      processDailyPracticeSchedulerTick(
        prisma as never,
        new Date('2026-07-28T21:30:00.000Z'),
      ),
    ).resolves.toBe(true);

    expect(transaction.dailyPracticeCycle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cycle-1' },
        data: expect.objectContaining({
          status: DailyPracticeCycleStatus.GENERATING,
          refreezeRequestedAt: null,
          refreezeRequestedById: null,
        }),
      }),
    );
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'cycle-1' } });
    expect(prisma.dailyPracticeDay.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cycleId: 'cycle-1' } }),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
