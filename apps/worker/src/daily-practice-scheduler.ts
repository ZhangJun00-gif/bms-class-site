import { createHash, randomUUID } from 'node:crypto';
import {
  DAILY_PRACTICE_SPREAD_WINDOW_MS,
  practiceDateForInstant,
  practiceDateFromDbDate,
  practiceDateToDbDate,
  practiceDayWindow,
  requiredDailyPlanConcurrency,
  scheduleUsersAcrossWindow,
} from '@bmc3/daily-practice-core';
import {
  AccountStatus,
  ContentStatus,
  DailyPracticeCycleStatus,
  DailyPracticeDayStatus,
  DailyPracticeSuggestionStatus,
  IndexStatus,
  KnowledgeKind,
  KnowledgeLibraryScope,
  KnowledgeRenderStatus,
  Prisma,
  QuizQuestionCategory,
  QuizQuestionOrigin,
  QuizQuestionReviewStatus,
  QuizQuestionSourceReviewStatus,
  type PrismaClient,
} from '@prisma/client';
import { loadDailyPracticeServiceGate } from './daily-practice-service';
import { safeAiErrorMessage } from './ai-invocation-gateway';
import { abortActiveDayGeneration } from './daily-practice-active-days';

const activeCycleLeases = new Map<string, string>();
const DAY_CREATE_BATCH = 500;

export interface FrozenProgressNode {
  progressId: string;
  subjectId: string;
  progressVersion: number;
  scopeHash: string;
  libraryId: string;
  documentId: string;
  nodePathHash: string;
  currentKnowledgeNodeId: string | null;
  title: string;
  breadcrumb: string;
  firstTaughtDate: string;
  remappedFromDocumentId?: string;
}

export interface FrozenFixedQuestion {
  questionId: string;
  ordinal: number;
  questionReviewRevision: number;
  sourceRevision: number;
  promptHash: string;
  gradingType: 'SINGLE' | 'MULTIPLE' | 'TRUE_FALSE' | 'SHORT_ANSWER';
  typeLabel: string;
  promptExcerpt: string;
  subjectId: string;
  subjectName: string;
  chapterIds: string[];
}

export interface FrozenCycleInputs {
  progressSnapshot: FrozenProgressNode[];
  progressSetHash: string;
  fixedAssignmentId: string | null;
  fixedQuestionSnapshot: FrozenFixedQuestion[];
  frozenFixedAssignmentHash: string;
  invalidFixedQuestionIds: string[];
  unresolvedProgressNodeCount: number;
  remappedProgressNodeCount: number;
  candidateQuestionCount: number;
  candidateSetHash: string;
  candidateTypeCounts: Record<string, number>;
  gapSummary: Array<{
    subjectId: string;
    subject: string;
    nodeCount: number;
    eligibleQuestionCount: number;
  }>;
}

export async function processDailyPracticeSchedulerTick(
  prisma: PrismaClient,
  suppliedNow?: Date | (() => Date),
) {
  const clock =
    typeof suppliedNow === 'function'
      ? suppliedNow
      : suppliedNow
        ? () => new Date(suppliedNow.getTime())
        : () => new Date();
  const now = clock();
  const practiceDate = practiceDateForInstant(now);
  const practiceDateDb = practiceDateToDbDate(practiceDate);
  const finalizedSuggestions = await finalizePastDailyPracticeSuggestions(
    prisma,
    practiceDateDb,
  );
  const gate = await loadDailyPracticeServiceGate(prisma, now);
  if (!gate.open) {
    const existing = await prisma.dailyPracticeCycle.findUnique({
      where: { practiceDate: practiceDateDb },
      select: { id: true },
    });
    if (existing) {
      await prisma.$transaction([
        prisma.dailyPracticeCycle.updateMany({
          where: { id: existing.id },
          data: { status: DailyPracticeCycleStatus.PAUSED },
        }),
        prisma.dailyPracticeDay.updateMany({
          where: { cycleId: existing.id, status: DailyPracticeDayStatus.PENDING },
          data: { status: DailyPracticeDayStatus.PAUSED },
        }),
      ]);
      return true;
    }
    return finalizedSuggestions > 0;
  }

  let cycle = await prisma.dailyPracticeCycle.findUnique({
    where: { practiceDate: practiceDateDb },
  });
  if (!cycle) {
    cycle = await createCycleUnderSettingsLock(prisma, clock);
    if (!cycle) return false;
  }
  if (cycle.refreezeRequestedAt) {
    const refrozen = await processRequestedCycleRefreeze(prisma, cycle.id);
    if (refrozen) {
      cycle = await prisma.dailyPracticeCycle.findUnique({
        where: { id: cycle.id },
      });
      if (!cycle) return false;
    }
  }
  if (readFixedSnapshot(cycle.poolStats).length) {
    const rebuilt = await refreshInvalidatedFixedQuestions(prisma, cycle.id);
    if (rebuilt) {
      cycle = await prisma.dailyPracticeCycle.findUnique({
        where: { id: cycle.id },
      });
      if (!cycle) return false;
    }
  }

  if (
    cycle.status === DailyPracticeCycleStatus.GENERATING ||
    cycle.status === DailyPracticeCycleStatus.DEGRADED ||
    cycle.status === DailyPracticeCycleStatus.READY
  ) {
    if (
      cycle.status === DailyPracticeCycleStatus.READY ||
      cycleCountsAreFinalized(cycle.counts)
    ) {
      return finalizedSuggestions > 0;
    }
    return (
      (await reconcileDailyPracticeCycle(
        prisma,
        cycle.id,
        cycle.counts,
        clock(),
      )) || finalizedSuggestions > 0
    );
  }

  const cyclePracticeDate = practiceDateFromDbDate(cycle.practiceDate);
  const cyclePracticeDateDb = practiceDateToDbDate(cyclePracticeDate);
  const recoveringFromPause = cycle.status === DailyPracticeCycleStatus.PAUSED;

  const ownerToken = randomUUID();
  const claimed = await prisma.dailyPracticeCycle.updateMany({
    where: {
      id: cycle.id,
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
    },
    data: {
      leaseOwnerToken: ownerToken,
      leasedUntil: new Date(now.getTime() + schedulerLeaseMs()),
      ...(cycle.status === DailyPracticeCycleStatus.PAUSED
        ? { status: DailyPracticeCycleStatus.BUILDING }
        : {}),
    },
  });
  if (claimed.count !== 1) return false;
  activeCycleLeases.set(cycle.id, ownerToken);
  try {
    const secondGate = await loadDailyPracticeServiceGate(prisma, clock());
    if (!secondGate.open) {
      await pauseClaimedCycle(prisma, cycle.id, ownerToken);
      return true;
    }
    const activeUsers = await prisma.user.findMany({
      where: { status: AccountStatus.ACTIVE },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const revisionByUser = new Map<string, number>();
    for (let offset = 0; offset < activeUsers.length; offset += DAY_CREATE_BATCH) {
      const userIds = activeUsers
        .slice(offset, offset + DAY_CREATE_BATCH)
        .map((user) => user.id);
      await prisma.userPracticeProfile.createMany({
        data: userIds.map((userId) => ({ userId })),
        skipDuplicates: true,
      });
      const profiles = await prisma.userPracticeProfile.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, stateRevision: true },
      });
      for (const profile of profiles) {
        revisionByUser.set(profile.userId, profile.stateRevision);
      }
    }
    const executionBudgetMs = dailyPlanTimeoutMs();
    const dispatchBudgetMs =
      DAILY_PRACTICE_SPREAD_WINDOW_MS - executionBudgetMs - 1;
    const requiredConcurrency = requiredDailyPlanConcurrency({
      activeUserCount: activeUsers.length,
      providerP95Ms: executionBudgetMs,
      dispatchBudgetMs,
    });
    const configuredConcurrency = dailyPlanConcurrency();
    const capacityAccepted = requiredConcurrency <= configuredConcurrency;
    const baseSchedule = scheduleUsersAcrossWindow(
      cyclePracticeDate,
      activeUsers.map((user) => user.id),
      executionBudgetMs,
    );
    const resumeAt = clock();
    const schedule = recoveringFromPause
      ? shiftScheduleToResumeWindow(
          baseSchedule,
          practiceDayWindow(cyclePracticeDate).dayStartedAt,
          resumeAt,
        )
      : baseSchedule;
    const deadlineAt = recoveringFromPause
      ? new Date(resumeAt.getTime() + DAILY_PRACTICE_SPREAD_WINDOW_MS)
      : cycle.deadlineAt;
    if (recoveringFromPause) {
      const updated = await prisma.dailyPracticeCycle.updateMany({
        where: { id: cycle.id, leaseOwnerToken: ownerToken },
        data: { baselineAt: resumeAt, deadlineAt, candidateCutoffAt: resumeAt },
      });
      if (updated.count !== 1) throw new DailySchedulerLeaseLostError();
    }
    const fixedSnapshot = readFixedSnapshot(cycle.poolStats);
    for (let offset = 0; offset < schedule.length; offset += DAY_CREATE_BATCH) {
      const currentGate = await loadDailyPracticeServiceGate(prisma, clock());
      if (!currentGate.open) {
        await pauseClaimedCycle(prisma, cycle.id, ownerToken);
        return true;
      }
      const batch = schedule.slice(offset, offset + DAY_CREATE_BATCH);
      await prisma.dailyPracticeDay.createMany({
        data: batch.map((scheduled) => ({
          cycleId: cycle.id,
          userId: scheduled.userId,
          practiceDate: cyclePracticeDateDb,
          scheduledAt: scheduled.scheduledAt,
          deadlineAt,
          status: DailyPracticeDayStatus.PENDING,
          profileRevision: revisionByUser.get(scheduled.userId) ?? 0,
          progressSetHash: cycle.progressSetHash,
          fixedQuestionSnapshot: fixedSnapshot as unknown as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
      if (recoveringFromPause) {
        await prisma.$transaction(
          batch.map((scheduled) =>
            prisma.dailyPracticeDay.updateMany({
              where: {
                cycleId: cycle.id,
                userId: scheduled.userId,
                status: DailyPracticeDayStatus.PAUSED,
              },
              data: {
                status: DailyPracticeDayStatus.PENDING,
                scheduledAt: scheduled.scheduledAt,
                deadlineAt,
              },
            }),
          ),
        );
      }
      const renewed = await prisma.dailyPracticeCycle.updateMany({
        where: { id: cycle.id, leaseOwnerToken: ownerToken },
        data: { leasedUntil: new Date(Date.now() + schedulerLeaseMs()) },
      });
      if (renewed.count !== 1) throw new DailySchedulerLeaseLostError();
    }
    if (recoveringFromPause) {
      await prisma.dailyPracticeDay.updateMany({
        where: {
          cycleId: cycle.id,
          status: DailyPracticeDayStatus.PAUSED,
        },
        data: {
          status: DailyPracticeDayStatus.FAILED,
          lastErrorCategory: 'NOT_ELIGIBLE_DURING_RESUME',
          lastErrorMessage: '账号未被纳入本次恢复后的每日练习生成范围',
        },
      });
    }
    const createdDays = await prisma.dailyPracticeDay.count({
      where: { cycleId: cycle.id },
    });
    await prisma.$transaction([
      prisma.dailyPracticeCycle.updateMany({
        where: { id: cycle.id, leaseOwnerToken: ownerToken },
        data: {
          status: capacityAccepted
            ? DailyPracticeCycleStatus.GENERATING
            : DailyPracticeCycleStatus.DEGRADED,
          counts: {
            activeUsers: activeUsers.length,
            createdDays,
            requiredConcurrency,
            configuredConcurrency,
            capacityAccepted,
          } as Prisma.InputJsonValue,
          lastErrorCategory: capacityAccepted ? null : 'CAPACITY_GATE_FAILED',
          lastErrorMessage: capacityAccepted
            ? null
            : '当前配置未通过保守容量门禁，仅允许确定性计划',
          leaseOwnerToken: null,
          leasedUntil: null,
        },
      }),
    ]);
    return true;
  } catch (error) {
    await prisma.dailyPracticeCycle.updateMany({
      where: { id: cycle.id, leaseOwnerToken: ownerToken },
      data: {
        status: DailyPracticeCycleStatus.FAILED,
        lastErrorCategory:
          error instanceof DailySchedulerLeaseLostError
            ? 'LEASE_LOST'
            : 'SCHEDULER_FAILED',
        lastErrorMessage: safeAiErrorMessage(error).slice(0, 500),
        leaseOwnerToken: null,
        leasedUntil: null,
      },
    });
    throw error;
  } finally {
    activeCycleLeases.delete(cycle.id);
  }
}

async function createCycleUnderSettingsLock(
  prisma: PrismaClient,
  clock: () => Date,
) {
  return prisma.$transaction(async (transaction) => {
    await lockDailyPracticeSettings(transaction);
    const lockedNow = clock();
    const lockedPracticeDate = practiceDateForInstant(lockedNow);
    const lockedPracticeDateDb = practiceDateToDbDate(lockedPracticeDate);
    const gate = await loadDailyPracticeServiceGate(transaction, lockedNow);
    if (!gate.open) return null;
    const existing = await transaction.dailyPracticeCycle.findUnique({
      where: { practiceDate: lockedPracticeDateDb },
    });
    if (existing) return existing;
    const frozen = await freezeCycleInputs(transaction, lockedPracticeDate);
    const window = practiceDayWindow(lockedPracticeDate);
    return transaction.dailyPracticeCycle.create({
      data: {
        practiceDate: lockedPracticeDateDb,
        baselineAt: window.dayStartedAt,
        deadlineAt: window.deadlineAt,
        candidateCutoffAt: lockedNow,
        status: DailyPracticeCycleStatus.BUILDING,
        settingsRevision: gate.settingsRevision,
        progressSetHash: frozen.progressSetHash,
        progressSnapshot: frozen.progressSnapshot as unknown as Prisma.InputJsonValue,
        fixedAssignmentId: frozen.fixedAssignmentId,
        frozenFixedAssignmentHash: frozen.frozenFixedAssignmentHash,
        poolStats: {
          frozenFixedQuestions: frozen.fixedQuestionSnapshot,
          invalidFixedQuestionIds: frozen.invalidFixedQuestionIds,
          unresolvedProgressNodeCount: frozen.unresolvedProgressNodeCount,
          remappedProgressNodeCount: frozen.remappedProgressNodeCount,
          candidateQuestionCount: frozen.candidateQuestionCount,
          candidateSetHash: frozen.candidateSetHash,
          candidateTypeCounts: frozen.candidateTypeCounts,
          gapSummary: frozen.gapSummary,
        } as unknown as Prisma.InputJsonValue,
        counts: { activeUsers: 0, createdDays: 0 } as Prisma.InputJsonValue,
      },
    });
  });
}

async function lockDailyPracticeSettings(transaction: Prisma.TransactionClient) {
  const rows = await transaction.$queryRaw<Array<{ singletonId: number }>>(
    Prisma.sql`
      SELECT singletonId
      FROM DailyPracticeSettings
      WHERE singletonId = 1
      FOR UPDATE
    `,
  );
  if (rows.length !== 1) {
    throw new Error('DailyPracticeSettings singleton is missing');
  }
}

export function shiftScheduleToResumeWindow<T extends { scheduledAt: Date }>(
  schedule: T[],
  originalBaselineAt: Date,
  resumedAt: Date,
) {
  return schedule.map((entry) => ({
    ...entry,
    scheduledAt: new Date(
      resumedAt.getTime() +
        Math.max(0, entry.scheduledAt.getTime() - originalBaselineAt.getTime()),
    ),
  }));
}

export async function releaseActiveDailySchedulerLeases(prisma: PrismaClient) {
  for (const [cycleId, ownerToken] of [...activeCycleLeases]) {
    await prisma.dailyPracticeCycle.updateMany({
      where: { id: cycleId, leaseOwnerToken: ownerToken },
      data: { leaseOwnerToken: null, leasedUntil: null },
    });
    activeCycleLeases.delete(cycleId);
  }
}

export async function reconcileDailyPracticeCycle(
  prisma: PrismaClient,
  cycleId: string,
  existingCounts: Prisma.JsonValue | null,
  now = new Date(),
) {
  const statusRows = await prisma.dailyPracticeDay.groupBy({
    by: ['status'],
    where: { cycleId },
    _count: { _all: true },
  });
  const statusCounts = Object.fromEntries(
    statusRows.map((row) => [row.status, row._count._all]),
  );
  const totalUsers = statusRows.reduce(
    (sum, row) => sum + row._count._all,
    0,
  );
  const unfinished =
    (statusCounts[DailyPracticeDayStatus.PENDING] ?? 0) +
    (statusCounts[DailyPracticeDayStatus.PROCESSING] ?? 0) +
    (statusCounts[DailyPracticeDayStatus.PAUSED] ?? 0) +
    (statusCounts[DailyPracticeDayStatus.STALE] ?? 0);
  if (unfinished > 0) return false;

  const degradedStatuses = new Set<DailyPracticeDayStatus>([
    DailyPracticeDayStatus.LIMITED_CONTENT,
    DailyPracticeDayStatus.NO_CONTENT,
    DailyPracticeDayStatus.DEGRADED_READY,
    DailyPracticeDayStatus.FAILED,
    DailyPracticeDayStatus.STALE,
  ]);
  const degraded = statusRows.some(
    (row) => degradedStatuses.has(row.status) && row._count._all > 0,
  );
  const counts = {
    ...(isRecord(existingCounts) ? existingCounts : {}),
    totalUsers,
    terminalUsers: totalUsers,
    statusCounts,
    finalizedAt: now.toISOString(),
  };
  const updated = await prisma.dailyPracticeCycle.updateMany({
    where: {
      id: cycleId,
      status: {
        in: [
          DailyPracticeCycleStatus.GENERATING,
          DailyPracticeCycleStatus.DEGRADED,
        ],
      },
    },
    data: {
      status: degraded
        ? DailyPracticeCycleStatus.DEGRADED
        : DailyPracticeCycleStatus.READY,
      counts: counts as Prisma.InputJsonValue,
      leaseOwnerToken: null,
      leasedUntil: null,
    },
  });
  return updated.count === 1;
}

export async function finalizePastDailyPracticeSuggestions(
  prisma: PrismaClient,
  currentPracticeDate: Date,
) {
  const pending = await prisma.dailyPracticeSuggestion.findMany({
    where: {
      status: DailyPracticeSuggestionStatus.PENDING,
      targetPracticeDate: { lt: currentPracticeDate },
    },
    select: { id: true, targetPracticeDate: true },
    orderBy: [{ targetPracticeDate: 'asc' }, { createdAt: 'asc' }],
    take: 500,
  });
  if (!pending.length) return 0;
  const targetDates = uniqueStrings(
    pending.map(({ targetPracticeDate }) =>
      practiceDateFromDbDate(targetPracticeDate),
    ),
  );
  const cycles = await prisma.dailyPracticeCycle.findMany({
    where: {
      practiceDate: {
        in: targetDates.map(practiceDateToDbDate),
      },
    },
    select: { practiceDate: true },
  });
  const cycleDates = new Set(
    cycles.map(({ practiceDate }) => practiceDateFromDbDate(practiceDate)),
  );
  const expiredIds: string[] = [];
  const notAppliedIds: string[] = [];
  for (const suggestion of pending) {
    const targetDate = practiceDateFromDbDate(suggestion.targetPracticeDate);
    (cycleDates.has(targetDate) ? notAppliedIds : expiredIds).push(
      suggestion.id,
    );
  }
  const [expired, notApplied] = await prisma.$transaction([
    prisma.dailyPracticeSuggestion.updateMany({
      where: {
        id: { in: expiredIds },
        status: DailyPracticeSuggestionStatus.PENDING,
      },
      data: { status: DailyPracticeSuggestionStatus.EXPIRED_SERVICE_PAUSED },
    }),
    prisma.dailyPracticeSuggestion.updateMany({
      where: {
        id: { in: notAppliedIds },
        status: DailyPracticeSuggestionStatus.PENDING,
      },
      data: { status: DailyPracticeSuggestionStatus.NOT_APPLIED },
    }),
  ]);
  return expired.count + notApplied.count;
}

export async function freezeCycleInputs(
  prisma: Prisma.TransactionClient,
  practiceDate: string,
): Promise<FrozenCycleInputs> {
  const practiceDateDb = practiceDateToDbDate(practiceDate);
  const progresses = await prisma.teachingProgress.findMany({
    where: { effectivePracticeDate: { lte: practiceDateDb } },
    include: { nodes: { orderBy: [{ documentId: 'asc' }, { nodePathHash: 'asc' }] } },
    orderBy: [
      { subjectId: 'asc' },
      { effectivePracticeDate: 'desc' },
      { version: 'desc' },
      { publishedAt: 'desc' },
    ],
  });
  const latestBySubject = new Map<string, (typeof progresses)[number]>();
  for (const progress of progresses) {
    if (!latestBySubject.has(progress.subjectId)) {
      latestBySubject.set(progress.subjectId, progress);
    }
  }
  const selectedProgresses = [...latestBySubject.values()]
    .sort((left, right) => compareAscii(left.subjectId, right.subjectId));
  const resolvedProgress = await resolveCurrentProgressNodes(prisma, selectedProgresses);
  const progressSnapshot = resolvedProgress.nodes;
  const candidateStats = await analyzeFrozenCandidatePool(
    prisma,
    selectedProgresses,
    progressSnapshot,
  );
  const assignment = await prisma.dailyPracticeFixedAssignment.findFirst({
    where: { practiceDate: practiceDateDb },
    orderBy: [{ revision: 'desc' }, { publishedAt: 'desc' }],
    include: {
      questions: {
        orderBy: { ordinal: 'asc' },
        include: {
          question: {
            include: {
              subject: { select: { name: true, active: true } },
              chapters: {
                select: { chapterId: true, chapter: { select: { active: true } } },
                orderBy: { chapterId: 'asc' },
              },
            },
          },
        },
      },
    },
  });
  const fixedQuestionSnapshot: FrozenFixedQuestion[] = [];
  const invalidFixedQuestionIds: string[] = [];
  for (const configured of assignment?.questions ?? []) {
    const question = configured.question;
    const valid =
      question.enabled &&
      question.reviewStatus === QuizQuestionReviewStatus.APPROVED &&
      question.reviewRevision === configured.questionReviewRevision &&
      (question.origin === QuizQuestionOrigin.MANUAL ||
        question.origin === QuizQuestionOrigin.CSV) &&
      question.subject.active &&
      question.chapters.length > 0 &&
      question.chapters.every((chapter) => chapter.chapter.active) &&
      sha256(question.prompt) === configured.promptHash;
    if (!valid) {
      invalidFixedQuestionIds.push(question.id);
      continue;
    }
    fixedQuestionSnapshot.push({
      questionId: question.id,
      ordinal: fixedQuestionSnapshot.length + 1,
      questionReviewRevision: question.reviewRevision,
      sourceRevision: question.sourceRevision,
      promptHash: configured.promptHash,
      gradingType: question.type,
      typeLabel: question.typeLabel,
      promptExcerpt: boundText(question.prompt, 300),
      subjectId: question.subjectId,
      subjectName: question.subject.name,
      chapterIds: question.chapters.map((chapter) => chapter.chapterId),
    });
  }
  return {
    progressSnapshot,
    progressSetHash: sha256(stableJson(progressSnapshot)),
    fixedAssignmentId: assignment?.id ?? null,
    fixedQuestionSnapshot,
    frozenFixedAssignmentHash: sha256(stableJson(fixedQuestionSnapshot)),
    invalidFixedQuestionIds,
    unresolvedProgressNodeCount: resolvedProgress.unresolvedCount,
    remappedProgressNodeCount: resolvedProgress.remappedCount,
    ...candidateStats,
  };
}

async function analyzeFrozenCandidatePool(
  prisma: Prisma.TransactionClient,
  progresses: Array<{
    subjectId: string;
    nodes: Array<{ documentId: string; nodePathHash: string }>;
  }>,
  progressSnapshot: FrozenProgressNode[],
) {
  const subjectIds = uniqueStrings(progresses.map((progress) => progress.subjectId))
    .sort(compareAscii);
  const subjects = subjectIds.length
    ? await prisma.subject.findMany({
        where: { id: { in: subjectIds } },
        select: { id: true, name: true },
      })
    : [];
  const subjectNames = new Map(subjects.map((subject) => [subject.id, subject.name]));
  const nodeCountBySubject = new Map(
    progresses.map((progress) => [progress.subjectId, progress.nodes.length]),
  );
  const resolvedNodeCountBySubject = new Map<string, number>();
  for (const node of progressSnapshot) {
    resolvedNodeCountBySubject.set(
      node.subjectId,
      (resolvedNodeCountBySubject.get(node.subjectId) ?? 0) + 1,
    );
  }
  const sourceKeys = new Set(
    progressSnapshot.map((node) => sourceKey(node.documentId, node.nodePathHash)),
  );
  const sourceScope = progressSnapshot.map((node) => ({
    documentId: node.documentId,
    OR: [
      { nodePathHash: node.nodePathHash },
      {
        nodePathHash: null,
        knowledgeNode: { pathHash: node.nodePathHash },
      },
    ],
  }));
  const eligibleBySubject = new Map<string, number>();
  const candidateTypeCounts: Record<string, number> = {};
  const candidateHash = createHash('sha256');
  let candidateQuestionCount = 0;
  let cursor: string | undefined;
  if (sourceScope.length) {
    while (true) {
      const rows = await prisma.quizQuestion.findMany({
        where: {
          enabled: true,
          origin: QuizQuestionOrigin.AI_GENERATED,
          category: QuizQuestionCategory.KNOWLEDGE_RECALL,
          reviewStatus: QuizQuestionReviewStatus.APPROVED,
          sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
          subject: { active: true },
          chapters: {
            some: {},
            every: { chapter: { active: true } },
          },
          knowledgeSources: {
            some: { current: true, OR: sourceScope },
            every: {
              OR: [
                { current: false },
                { current: true, OR: sourceScope },
              ],
            },
          },
        },
        select: {
          id: true,
          subjectId: true,
          type: true,
          sourceRevision: true,
          knowledgeSources: {
            where: { current: true },
            orderBy: [{ ordinal: 'asc' }, { id: 'asc' }],
            select: {
              documentId: true,
              nodePathHash: true,
              sourceRevision: true,
              knowledgeNode: { select: { pathHash: true } },
            },
          },
        },
        orderBy: { id: 'asc' },
        take: 1_000,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const question of rows) {
        const sources = question.knowledgeSources.flatMap((source) => {
          const pathHash = source.nodePathHash ?? source.knowledgeNode?.pathHash;
          return pathHash ? [{ ...source, pathHash }] : [];
        });
        if (
          sources.length !== question.knowledgeSources.length ||
          !sources.every(
            (source) =>
              source.sourceRevision === question.sourceRevision &&
              sourceKeys.has(sourceKey(source.documentId, source.pathHash)),
          )
        ) {
          continue;
        }
        candidateQuestionCount += 1;
        candidateHash.update(question.id, 'utf8');
        candidateHash.update('\n', 'utf8');
        eligibleBySubject.set(
          question.subjectId,
          (eligibleBySubject.get(question.subjectId) ?? 0) + 1,
        );
        candidateTypeCounts[question.type] =
          (candidateTypeCounts[question.type] ?? 0) + 1;
      }
      if (rows.length < 1_000) break;
      cursor = rows.at(-1)!.id;
    }
  }
  const gapSummary = subjectIds.flatMap((subjectId) => {
    const nodeCount = nodeCountBySubject.get(subjectId) ?? 0;
    const resolvedNodeCount = resolvedNodeCountBySubject.get(subjectId) ?? 0;
    const eligibleQuestionCount = eligibleBySubject.get(subjectId) ?? 0;
    if (eligibleQuestionCount >= 20 && resolvedNodeCount === nodeCount) return [];
    return [{
      subjectId,
      subject: subjectNames.get(subjectId) ?? subjectId,
      nodeCount,
      eligibleQuestionCount,
    }];
  });
  return {
    candidateQuestionCount,
    candidateSetHash: candidateHash.digest('hex'),
    candidateTypeCounts,
    gapSummary,
  };
}

async function resolveCurrentProgressNodes(
  prisma: Prisma.TransactionClient,
  progresses: Array<{
    id: string;
    subjectId: string;
    version: number;
    scopeHash: string;
    nodes: Array<{
      libraryId: string;
      documentId: string;
      nodePathHash: string;
      firstTaughtDate: Date;
    }>;
  }>,
) {
  const flattened = progresses.flatMap((progress) =>
    progress.nodes.map((node) => ({ progress, node })),
  );
  const unresolvedPairs: typeof flattened = [];
  const resolvedByKey = new Map<
    string,
    {
      id: string;
      title: string;
      breadcrumb: string;
      documentId: string;
      pathHash: string;
      documentLibraryId: string;
      documentSubjectId: string;
      chapterLibraryId: string;
    }
  >();
  for (let offset = 0; offset < flattened.length; offset += DAY_CREATE_BATCH) {
    const batch = flattened.slice(offset, offset + DAY_CREATE_BATCH);
    const documentIds = uniqueStrings(batch.map(({ node }) => node.documentId));
    const pathHashes = uniqueStrings(batch.map(({ node }) => node.nodePathHash));
    const documents = await prisma.knowledgeDocument.findMany({
      where: {
        id: { in: documentIds },
        status: ContentStatus.PUBLISHED,
        indexStatus: IndexStatus.READY,
        kind: KnowledgeKind.MARKDOWN,
        deletedAt: null,
        subject: { active: true },
        library: {
          scope: KnowledgeLibraryScope.SHARED,
          active: true,
          deletedAt: null,
        },
        activeVersion: {
          is: {
            indexStatus: IndexStatus.READY,
            renderStatus: KnowledgeRenderStatus.READY,
          },
        },
      },
      select: {
        id: true,
        libraryId: true,
        subjectId: true,
        activeVersion: {
          select: {
            nodes: {
              where: {
                pathHash: { in: pathHashes },
                libraryChapter: { active: true },
              },
              select: {
                id: true,
                pathHash: true,
                title: true,
                breadcrumb: true,
                libraryChapter: { select: { libraryId: true } },
              },
            },
          },
        },
      },
    });
    for (const document of documents) {
      for (const node of document.activeVersion?.nodes ?? []) {
        resolvedByKey.set(sourceKey(document.id, node.pathHash), {
          id: node.id,
          title: node.title,
          breadcrumb: node.breadcrumb,
          documentId: document.id,
          pathHash: node.pathHash,
          documentLibraryId: document.libraryId,
          documentSubjectId: document.subjectId,
          chapterLibraryId: node.libraryChapter.libraryId,
        });
      }
    }
  }
  const nodes: FrozenProgressNode[] = [];
  for (const { progress, node } of flattened) {
    const key = sourceKey(node.documentId, node.nodePathHash);
    const current = resolvedByKey.get(key);
    if (
      !current ||
      current.documentLibraryId !== node.libraryId ||
      current.chapterLibraryId !== node.libraryId ||
      current.documentSubjectId !== progress.subjectId
    ) {
      unresolvedPairs.push({ progress, node });
      continue;
    }
    nodes.push({
      progressId: progress.id,
      subjectId: progress.subjectId,
      progressVersion: progress.version,
      scopeHash: progress.scopeHash,
      libraryId: node.libraryId,
      documentId: node.documentId,
      nodePathHash: node.nodePathHash,
      currentKnowledgeNodeId: current.id,
      title: current.title,
      breadcrumb: current.breadcrumb,
      firstTaughtDate: practiceDateFromDbDate(node.firstTaughtDate),
    });
  }
  const remappedCount = await remapUnresolvedProgressNodes(
    prisma,
    unresolvedPairs,
    nodes,
  );
  return {
    nodes,
    unresolvedCount: unresolvedPairs.length,
    remappedCount,
  };
}

async function remapUnresolvedProgressNodes(
  prisma: Prisma.TransactionClient,
  unresolvedPairs: Array<{
    progress: {
      id: string;
      subjectId: string;
      version: number;
      scopeHash: string;
    };
    node: {
      libraryId: string;
      documentId: string;
      nodePathHash: string;
      firstTaughtDate: Date;
    };
  }>,
  nodes: FrozenProgressNode[],
) {
  if (!unresolvedPairs.length) return 0;
  const libraryIds = uniqueStrings(
    unresolvedPairs.map(({ node }) => node.libraryId),
  );
  const subjectIds = uniqueStrings(
    unresolvedPairs.map(({ progress }) => progress.subjectId),
  );
  const pathHashes = uniqueStrings(
    unresolvedPairs.map(({ node }) => node.nodePathHash),
  );
  const candidates = await prisma.knowledgeDocument.findMany({
    where: {
      libraryId: { in: libraryIds },
      subjectId: { in: subjectIds },
      status: ContentStatus.PUBLISHED,
      indexStatus: IndexStatus.READY,
      kind: KnowledgeKind.MARKDOWN,
      deletedAt: null,
      subject: { active: true },
      library: {
        scope: KnowledgeLibraryScope.SHARED,
        active: true,
        deletedAt: null,
      },
      activeVersion: {
        is: {
          indexStatus: IndexStatus.READY,
          renderStatus: KnowledgeRenderStatus.READY,
        },
      },
    },
    select: {
      id: true,
      libraryId: true,
      subjectId: true,
      activeVersion: {
        select: {
          nodes: {
            where: {
              pathHash: { in: pathHashes },
              libraryChapter: { active: true },
            },
            select: {
              id: true,
              pathHash: true,
              title: true,
              breadcrumb: true,
              libraryChapter: { select: { libraryId: true } },
            },
          },
        },
      },
    },
  });
  const candidateDocumentIdsByKey = new Map<string, Set<string>>();
  const candidateNodeByKey = new Map<
    string,
    {
      id: string;
      title: string;
      breadcrumb: string;
      documentId: string;
      documentLibraryId: string;
      documentSubjectId: string;
      chapterLibraryId: string;
    }
  >();
  for (const document of candidates) {
    for (const node of document.activeVersion?.nodes ?? []) {
      const remapKey = sourceKey(
        sourceKey(document.libraryId, document.subjectId),
        node.pathHash,
      );
      const documentIds =
        candidateDocumentIdsByKey.get(remapKey) ?? new Set<string>();
      documentIds.add(document.id);
      candidateDocumentIdsByKey.set(remapKey, documentIds);
      candidateNodeByKey.set(sourceKey(document.id, node.pathHash), {
        id: node.id,
        title: node.title,
        breadcrumb: node.breadcrumb,
        documentId: document.id,
        documentLibraryId: document.libraryId,
        documentSubjectId: document.subjectId,
        chapterLibraryId: node.libraryChapter.libraryId,
      });
    }
  }
  let remappedCount = 0;
  const stillUnresolved: typeof unresolvedPairs = [];
  for (const { progress, node } of unresolvedPairs) {
    const remapKey = sourceKey(
      sourceKey(node.libraryId, progress.subjectId),
      node.nodePathHash,
    );
    const candidateDocumentIds = candidateDocumentIdsByKey.get(remapKey);
    const candidateDocumentId =
      candidateDocumentIds?.size === 1
        ? [...candidateDocumentIds][0]
        : undefined;
    const current = candidateDocumentId
      ? candidateNodeByKey.get(sourceKey(candidateDocumentId, node.nodePathHash))
      : undefined;
    if (
      !current ||
      current.documentLibraryId !== node.libraryId ||
      current.chapterLibraryId !== node.libraryId ||
      current.documentSubjectId !== progress.subjectId
    ) {
      stillUnresolved.push({ progress, node });
      continue;
    }
    remappedCount += 1;
    nodes.push({
      progressId: progress.id,
      subjectId: progress.subjectId,
      progressVersion: progress.version,
      scopeHash: progress.scopeHash,
      libraryId: node.libraryId,
      documentId: current.documentId,
      nodePathHash: node.nodePathHash,
      currentKnowledgeNodeId: current.id,
      title: current.title,
      breadcrumb: current.breadcrumb,
      firstTaughtDate: practiceDateFromDbDate(node.firstTaughtDate),
      remappedFromDocumentId: node.documentId,
    });
  }
  unresolvedPairs.length = 0;
  unresolvedPairs.push(...stillUnresolved);
  return remappedCount;
}

function readFixedSnapshot(value: Prisma.JsonValue | null) {
  if (!isRecord(value) || !Array.isArray(value.frozenFixedQuestions)) return [];
  return value.frozenFixedQuestions;
}

const REBUILDABLE_DAY_STATUSES = [
  DailyPracticeDayStatus.PENDING,
  DailyPracticeDayStatus.PROCESSING,
  DailyPracticeDayStatus.READY,
  DailyPracticeDayStatus.LIMITED_CONTENT,
  DailyPracticeDayStatus.NO_CONTENT,
  DailyPracticeDayStatus.DEGRADED_READY,
  DailyPracticeDayStatus.FAILED,
  DailyPracticeDayStatus.PAUSED,
  DailyPracticeDayStatus.STALE,
] as const;

export async function refreshInvalidatedFixedQuestions(
  prisma: PrismaClient,
  cycleId: string,
) {
  return prisma.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT id
        FROM DailyPracticeCycle
        WHERE id = ${cycleId}
        FOR UPDATE
      `,
    );
    if (!locked.length) return false;
    const cycle = await transaction.dailyPracticeCycle.findUnique({
      where: { id: cycleId },
      select: {
        id: true,
        status: true,
        poolStats: true,
        counts: true,
      },
    });
    if (!cycle) return false;
    const frozen = readFixedSnapshot(
      cycle.poolStats,
    ) as unknown as FrozenFixedQuestion[];
    if (!frozen.length) return false;
    const current = await filterCurrentFixedQuestions(transaction, frozen);
    if (stableJson(current) === stableJson(frozen)) return false;

    const currentIds = new Set(current.map((question) => question.questionId));
    const removedIds = frozen
      .filter((question) => !currentIds.has(question.questionId))
      .map((question) => question.questionId);
    const poolStats = isRecord(cycle.poolStats)
      ? { ...cycle.poolStats }
      : {};
    const existingInvalidIds = Array.isArray(poolStats.invalidFixedQuestionIds)
      ? poolStats.invalidFixedQuestionIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    poolStats.frozenFixedQuestions = current as unknown as Prisma.JsonValue;
    poolStats.invalidFixedQuestionIds = uniqueStrings([
      ...existingInvalidIds,
      ...removedIds,
    ]);

    const rebuiltAt = new Date();
    await transaction.dailyPracticePlanRevision.updateMany({
      where: {
        generatedAt: null,
        day: {
          cycleId,
          status: { in: [...REBUILDABLE_DAY_STATUSES] },
          startedAt: null,
          completedAt: null,
        },
      },
      data: {
        generatedAt: rebuiltAt,
        degradedReason: 'FIXED_QUESTION_INVALIDATED',
      },
    });
    const commonDayData = {
      fixedQuestionSnapshot: current as unknown as Prisma.InputJsonValue,
      candidateSnapshot: Prisma.DbNull,
      candidateHash: null,
      lastErrorCategory: 'FIXED_QUESTION_INVALIDATED',
      lastErrorMessage: '管理员固定题已失效，正在统一重建未开始计划',
    };
    const rebuilt = await transaction.dailyPracticeDay.updateMany({
      where: {
        cycleId,
        status: {
          in: REBUILDABLE_DAY_STATUSES.filter(
            (status) => status !== DailyPracticeDayStatus.PAUSED,
          ),
        },
        startedAt: null,
        completedAt: null,
      },
      data: {
        ...commonDayData,
        status: DailyPracticeDayStatus.STALE,
      },
    });
    const paused = await transaction.dailyPracticeDay.updateMany({
      where: {
        cycleId,
        status: DailyPracticeDayStatus.PAUSED,
        startedAt: null,
        completedAt: null,
      },
      data: commonDayData,
    });
    const affectedDays = rebuilt.count + paused.count;
    const counts = isRecord(cycle.counts) ? { ...cycle.counts } : {};
    delete counts.finalizedAt;
    delete counts.terminalUsers;
    delete counts.statusCounts;
    await transaction.dailyPracticeCycle.update({
      where: { id: cycleId },
      data: {
        frozenFixedAssignmentHash: sha256(stableJson(current)),
        poolStats: poolStats as unknown as Prisma.InputJsonValue,
        counts: counts as Prisma.InputJsonValue,
        ...(affectedDays > 0 && cycle.status !== DailyPracticeCycleStatus.PAUSED
          ? { status: DailyPracticeCycleStatus.GENERATING }
          : {}),
      },
    });
    return true;
  });
}

export async function processRequestedCycleRefreeze(
  prisma: PrismaClient,
  cycleId: string,
): Promise<boolean> {
  let outcome: {
    processed: boolean;
    leasedDayIds: string[];
  } = { processed: false, leasedDayIds: [] };
  await prisma.$transaction(async (transaction) => {
    await lockDailyPracticeSettings(transaction);
    const locked = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT id
        FROM DailyPracticeCycle
        WHERE id = ${cycleId}
        FOR UPDATE
      `,
    );
    if (!locked.length) return;
    const cycle = await transaction.dailyPracticeCycle.findUnique({
      where: { id: cycleId },
      select: {
        id: true,
        status: true,
        poolStats: true,
        counts: true,
        practiceDate: true,
        refreezeRequestedAt: true,
      },
    });
    if (!cycle || cycle.refreezeRequestedAt === null) return;
    const leasedDays = await transaction.dailyPracticeDay.findMany({
      where: {
        cycleId,
        startedAt: null,
        completedAt: null,
        leaseOwnerToken: { not: null },
        status: { in: [...REBUILDABLE_DAY_STATUSES] },
      },
      select: { id: true },
    });
    const frozen = await freezeCycleInputs(
      transaction,
      practiceDateFromDbDate(cycle.practiceDate),
    );

    const rebuiltAt = new Date();
    await transaction.dailyPracticePlanRevision.updateMany({
      where: {
        generatedAt: null,
        day: {
          cycleId,
          status: { in: [...REBUILDABLE_DAY_STATUSES] },
          startedAt: null,
          completedAt: null,
        },
      },
      data: {
        generatedAt: rebuiltAt,
        degradedReason: 'CYCLE_REFROZEN',
      },
    });
    const commonDayData = {
      fixedQuestionSnapshot:
        frozen.fixedQuestionSnapshot as unknown as Prisma.InputJsonValue,
      candidateSnapshot: Prisma.DbNull,
      candidateHash: null,
      progressSetHash: frozen.progressSetHash,
      lastErrorCategory: 'CYCLE_REFROZEN',
      lastErrorMessage: '周期已重新冻结，正在统一重建未开始计划',
      leaseOwnerToken: null,
      leasedUntil: null,
    };
    const rebuilt = await transaction.dailyPracticeDay.updateMany({
      where: {
        cycleId,
        status: {
          in: REBUILDABLE_DAY_STATUSES.filter(
            (status) => status !== DailyPracticeDayStatus.PAUSED,
          ),
        },
        startedAt: null,
        completedAt: null,
      },
      data: {
        ...commonDayData,
        status: DailyPracticeDayStatus.STALE,
      },
    });
    const paused = await transaction.dailyPracticeDay.updateMany({
      where: {
        cycleId,
        status: DailyPracticeDayStatus.PAUSED,
        startedAt: null,
        completedAt: null,
      },
      data: commonDayData,
    });
    const affectedDays = rebuilt.count + paused.count;
    const counts = isRecord(cycle.counts) ? { ...cycle.counts } : {};
    delete counts.finalizedAt;
    delete counts.terminalUsers;
    delete counts.statusCounts;
    await transaction.dailyPracticeCycle.update({
      where: { id: cycleId },
      data: {
        progressSnapshot:
          frozen.progressSnapshot as unknown as Prisma.InputJsonValue,
        progressSetHash: frozen.progressSetHash,
        fixedAssignmentId: frozen.fixedAssignmentId,
        frozenFixedAssignmentHash: frozen.frozenFixedAssignmentHash,
        poolStats: {
          frozenFixedQuestions: frozen.fixedQuestionSnapshot,
          invalidFixedQuestionIds: frozen.invalidFixedQuestionIds,
          unresolvedProgressNodeCount: frozen.unresolvedProgressNodeCount,
          remappedProgressNodeCount: frozen.remappedProgressNodeCount,
          candidateQuestionCount: frozen.candidateQuestionCount,
          candidateSetHash: frozen.candidateSetHash,
          candidateTypeCounts: frozen.candidateTypeCounts,
          gapSummary: frozen.gapSummary,
        } as unknown as Prisma.InputJsonValue,
        counts: counts as Prisma.InputJsonValue,
        refreezeRequestedAt: null,
        refreezeRequestedById: null,
        lastErrorCategory: null,
        lastErrorMessage: null,
        ...(affectedDays > 0 && cycle.status !== DailyPracticeCycleStatus.PAUSED
          ? { status: DailyPracticeCycleStatus.GENERATING }
          : {}),
      },
    });
    outcome = {
      processed: true,
      leasedDayIds: leasedDays.map((day) => day.id),
    };
  });
  if (!outcome.processed) return false;
  for (const dayId of outcome.leasedDayIds) {
    abortActiveDayGeneration(dayId, 'CYCLE_REFROZEN');
  }
  return true;
}

export async function filterCurrentFixedQuestions(
  prisma: Pick<PrismaClient, 'quizQuestion'>,
  frozen: FrozenFixedQuestion[],
) {
  if (!frozen.length) return frozen;
  const rows = await prisma.quizQuestion.findMany({
    where: { id: { in: frozen.map((question) => question.questionId) } },
    select: {
      id: true,
      enabled: true,
      origin: true,
      reviewStatus: true,
      reviewRevision: true,
      sourceRevision: true,
      prompt: true,
      subject: { select: { active: true } },
      chapters: {
        select: { chapter: { select: { active: true } } },
      },
    },
  });
  const current = new Map(rows.map((row) => [row.id, row]));
  return frozen
    .filter((question) => {
      const row = current.get(question.questionId);
      return Boolean(
        row &&
          row.enabled &&
          (row.origin === QuizQuestionOrigin.MANUAL ||
            row.origin === QuizQuestionOrigin.CSV) &&
          row.reviewStatus === QuizQuestionReviewStatus.APPROVED &&
          row.reviewRevision === question.questionReviewRevision &&
          row.sourceRevision === question.sourceRevision &&
          row.subject.active &&
          row.chapters.length > 0 &&
          row.chapters.every(({ chapter }) => chapter.active) &&
          sha256(row.prompt) === question.promptHash,
      );
    })
    .map((question, index) => ({ ...question, ordinal: index + 1 }));
}

async function pauseClaimedCycle(
  prisma: PrismaClient,
  cycleId: string,
  ownerToken: string,
) {
  await prisma.$transaction([
    prisma.dailyPracticeDay.updateMany({
      where: { cycleId, status: DailyPracticeDayStatus.PENDING },
      data: { status: DailyPracticeDayStatus.PAUSED },
    }),
    prisma.dailyPracticeCycle.updateMany({
      where: { id: cycleId, leaseOwnerToken: ownerToken },
      data: {
        status: DailyPracticeCycleStatus.PAUSED,
        leaseOwnerToken: null,
        leasedUntil: null,
      },
    }),
  ]);
}

function schedulerLeaseMs() {
  return configuredInteger('DAILY_PRACTICE_JOB_LEASE_MS', 60_000, 3_600_000, 600_000);
}

function dailyPlanTimeoutMs() {
  return configuredInteger('AI_DAILY_PLAN_TIMEOUT_MS', 1_000, 600_000, 180_000);
}

function dailyPlanConcurrency() {
  return configuredInteger('AI_DAILY_PLAN_CONCURRENCY', 1, 100, 1);
}

function configuredInteger(name: string, minimum: number, maximum: number, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be ${minimum}-${maximum}`);
  }
  return value;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareAscii)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundText(value: string, maximum: number) {
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' '))
    .slice(0, maximum)
    .join('')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cycleCountsAreFinalized(value: Prisma.JsonValue | null) {
  return isRecord(value) && typeof value.finalizedAt === 'string';
}

function sourceKey(documentId: string, nodePathHash: string) {
  return `${documentId}\u0000${nodePathHash}`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function compareAscii(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

class DailySchedulerLeaseLostError extends Error {
  constructor() {
    super('daily scheduler lease was lost');
    this.name = 'DailySchedulerLeaseLostError';
  }
}
