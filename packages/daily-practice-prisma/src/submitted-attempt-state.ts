import {
  extractMissingRubricPoints,
  observationBps,
  reviewIntervalDays,
  updatePracticeState,
  type MissingRubricPoint,
  type PracticeStateValue,
} from '@bmc3/daily-practice-core';
import {
  DailyPracticeDayStatus,
  Prisma,
  UserPracticeInitializationStatus,
  type PrismaClient,
} from '@prisma/client';

type TransactionClient = Prisma.TransactionClient;
type JsonValue = Prisma.JsonValue;

export interface SubmittedAttemptStateInput {
  id: string;
  userId: string;
  snapshot: JsonValue;
  results: JsonValue | null;
  submittedAt: Date;
  dailyPracticePlanRevisionId?: string | null;
}

export interface ApplySubmittedAttemptStateResult {
  applied: boolean;
  deferred: boolean;
  stateRevision: number | null;
  questionCount: number;
  knowledgeStateCount: number;
  chapterStateCount: number;
}

export async function lockUserPracticeProfile(
  transaction: TransactionClient,
  userId: string,
) {
  await transaction.userPracticeProfile.upsert({
    where: { userId },
    create: {
      userId,
      initializationStatus: UserPracticeInitializationStatus.PENDING,
    },
    update: {},
  });
  await transaction.$queryRaw(
    Prisma.sql`
      SELECT userId FROM UserPracticeProfile
      WHERE userId = ${userId}
      FOR UPDATE
    `,
  );
}

interface ParsedQuestion {
  id: string;
  subjectId: string | null;
  chapterIds: string[];
  knowledgeStateSources: Omit<KnowledgeSource, 'questionId'>[] | null;
}

interface ParsedResult {
  questionId: string;
  score: number;
  maxScore: number;
  criterionScores: Array<{
    description: string;
    awardedPoints: number;
    maxPoints: number;
  }>;
}

interface LoadedState extends PracticeStateValue {
  correctCount: number;
  wrongCount: number;
  lastWrongAt: Date | null;
  version: number;
}

interface KnowledgeSource {
  questionId: string;
  documentId: string;
  nodePathHash: string;
  currentKnowledgeNodeId: string | null;
  subjectId: string;
  libraryId: string;
}

interface StateMutation {
  state: PracticeStateValue;
  correctCount: number;
  wrongCount: number;
  lastWrongAt: Date | null;
  lastPracticedAt: Date;
  nextReviewAt: Date;
  missingRubricPoints: MissingRubricPoint[];
  lastQuestionId: string;
  version: number;
}

export async function applySubmittedAttemptState(
  transaction: TransactionClient,
  attemptInput: SubmittedAttemptStateInput,
  appliedAt = new Date(),
): Promise<ApplySubmittedAttemptStateResult> {
  assertAttemptInput(attemptInput);
  await lockUserPracticeProfile(transaction, attemptInput.userId);
  const authoritative = await transaction.quizAttempt.findUniqueOrThrow({
    where: { id: attemptInput.id },
    select: {
      id: true,
      userId: true,
      snapshot: true,
      results: true,
      submittedAt: true,
      knowledgeStateAppliedAt: true,
      knowledgeStateRevision: true,
      dailyPracticePlanRevisionId: true,
    },
  });
  if (
    !authoritative.submittedAt ||
    authoritative.userId !== attemptInput.userId
  ) {
    throw new AttemptStateValidationError(
      'attempt is not submitted by the expected user',
    );
  }
  const submittedAt = authoritative.submittedAt;
  if (authoritative.knowledgeStateAppliedAt) {
    await markDailyPracticeDayCompleted(
      transaction,
      authoritative.dailyPracticePlanRevisionId,
      submittedAt,
    );
    return emptyApplyResult(authoritative.knowledgeStateRevision, false);
  }
  const earlier = await transaction.quizAttempt.findFirst({
    where: {
      userId: authoritative.userId,
      submittedAt: { not: null },
      knowledgeStateAppliedAt: null,
      OR: [
        { submittedAt: { lt: submittedAt } },
        { submittedAt, id: { lt: authoritative.id } },
      ],
    },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  if (earlier) {
    await markDailyPracticeDayCompleted(
      transaction,
      authoritative.dailyPracticePlanRevisionId,
      submittedAt,
    );
    return emptyApplyResult(null, true);
  }
  const claimed = await transaction.quizAttempt.updateMany({
    where: {
      id: authoritative.id,
      userId: authoritative.userId,
      submittedAt: { not: null },
      knowledgeStateAppliedAt: null,
    },
    data: { knowledgeStateAppliedAt: appliedAt },
  });
  if (claimed.count !== 1) {
    const existing = await transaction.quizAttempt.findUnique({
      where: { id: authoritative.id },
      select: { knowledgeStateRevision: true },
    });
    await markDailyPracticeDayCompleted(
      transaction,
      authoritative.dailyPracticePlanRevisionId,
      submittedAt,
    );
    return emptyApplyResult(existing?.knowledgeStateRevision ?? null, false);
  }
  const questions = parseAttemptSnapshot(authoritative.snapshot);
  const results = parseAttemptResults(authoritative.results);
  assertMatchingQuestionSets(questions, results);
  const questionIds = questions.map((question) => question.id);
  const currentQuestions = await transaction.quizQuestion.findMany({
    where: { id: { in: questionIds } },
    select: {
      id: true,
      subjectId: true,
      chapters: { select: { chapterId: true } },
    },
  });
  const currentById = new Map(
    currentQuestions.map((question) => [question.id, question]),
  );
  const normalizedQuestions = questions.map((question) => {
    const current = currentById.get(question.id);
    const subjectId = question.subjectId ?? current?.subjectId ?? null;
    const chapterIds = question.chapterIds.length
      ? question.chapterIds
      : uniqueStrings(
          current?.chapters.map((chapter) => chapter.chapterId) ?? [],
        );
    return { ...question, subjectId, chapterIds };
  });
  const frozenSources = normalizedQuestions.flatMap((question) =>
    (question.knowledgeStateSources ?? []).map((source) => ({
      ...source,
      questionId: question.id,
    })),
  );
  const legacyQuestionIds = normalizedQuestions
    .filter((question) => question.knowledgeStateSources === null)
    .map((question) => question.id);
  const sources = [
    ...(await validateFrozenKnowledgeSources(transaction, frozenSources)),
    ...(await loadCurrentKnowledgeSources(transaction, legacyQuestionIds)),
  ];

  const profile = await transaction.userPracticeProfile.findUniqueOrThrow({
    where: { userId: authoritative.userId },
    select: { stateRevision: true, lastAppliedAttemptAt: true },
  });
  const stateRevision = profile.stateRevision + 1;
  const resultByQuestion = new Map(
    results.map((result) => [result.questionId, result]),
  );
  const sourceByQuestion = groupBy(sources, (source) => source.questionId);

  const knowledgeMutations = await buildKnowledgeMutations(
    transaction,
    authoritative.userId,
    normalizedQuestions,
    resultByQuestion,
    sourceByQuestion,
    submittedAt,
  );
  const chapterMutations = await buildChapterMutations(
    transaction,
    authoritative.userId,
    normalizedQuestions,
    resultByQuestion,
    submittedAt,
  );

  for (const [key, value] of knowledgeMutations) {
    const [documentId, nodePathHash] = splitCompositeKey(key);
    await transaction.userKnowledgeState.upsert({
      where: {
        userId_documentId_nodePathHash: {
          userId: authoritative.userId,
          documentId,
          nodePathHash,
        },
      },
      create: {
        userId: authoritative.userId,
        documentId,
        nodePathHash,
        currentKnowledgeNodeId: value.source.currentKnowledgeNodeId,
        subjectId: value.source.subjectId,
        libraryId: value.source.libraryId,
        ...stateWriteData(value.mutation),
      },
      update: {
        currentKnowledgeNodeId: value.source.currentKnowledgeNodeId,
        subjectId: value.source.subjectId,
        libraryId: value.source.libraryId,
        ...stateWriteData(value.mutation),
      },
    });
  }
  for (const [subjectChapterId, mutation] of chapterMutations) {
    await transaction.userChapterState.upsert({
      where: {
        userId_subjectChapterId: {
          userId: authoritative.userId,
          subjectChapterId,
        },
      },
      create: {
        userId: authoritative.userId,
        subjectChapterId,
        ...stateWriteData(mutation),
      },
      update: stateWriteData(mutation),
    });
  }

  const correctCount = results.filter(
    (result) => observationBps(result.score, result.maxScore) === 10_000,
  ).length;
  await transaction.userPracticeProfile.update({
    where: { userId: authoritative.userId },
    data: {
      stateRevision,
      lastAppliedAttemptAt:
        !profile.lastAppliedAttemptAt ||
        submittedAt > profile.lastAppliedAttemptAt
          ? submittedAt
          : profile.lastAppliedAttemptAt,
      attemptCount: { increment: 1 },
      questionCount: { increment: results.length },
      correctCount: { increment: correctCount },
      wrongCount: { increment: results.length - correctCount },
    },
  });
  await markDailyPracticeDayCompleted(
    transaction,
    authoritative.dailyPracticePlanRevisionId,
    submittedAt,
  );
  const finalized = await transaction.quizAttempt.updateMany({
    where: {
      id: authoritative.id,
      userId: authoritative.userId,
      knowledgeStateAppliedAt: appliedAt,
      knowledgeStateRevision: null,
    },
    data: { knowledgeStateRevision: stateRevision },
  });
  if (finalized.count !== 1) {
    throw new AttemptStateConcurrencyError(
      'attempt state CAS was lost before finalization',
    );
  }
  return {
    applied: true,
    deferred: false,
    stateRevision,
    questionCount: results.length,
    knowledgeStateCount: knowledgeMutations.size,
    chapterStateCount: chapterMutations.size,
  };
}

function emptyApplyResult(
  stateRevision: number | null,
  deferred: boolean,
): ApplySubmittedAttemptStateResult {
  return {
    applied: false,
    deferred,
    stateRevision,
    questionCount: 0,
    knowledgeStateCount: 0,
    chapterStateCount: 0,
  };
}

async function markDailyPracticeDayCompleted(
  transaction: TransactionClient,
  dailyPracticePlanRevisionId: string | null,
  submittedAt: Date,
) {
  if (!dailyPracticePlanRevisionId) return;
  const revision = await transaction.dailyPracticePlanRevision.findUnique({
    where: { id: dailyPracticePlanRevisionId },
    select: { dayId: true },
  });
  if (!revision) return;
  await transaction.dailyPracticeDay.updateMany({
    where: {
      id: revision.dayId,
      activeRevisionId: dailyPracticePlanRevisionId,
    },
    data: {
      status: DailyPracticeDayStatus.COMPLETED,
      completedAt: submittedAt,
    },
  });
}

async function validateFrozenKnowledgeSources(
  transaction: TransactionClient,
  sources: KnowledgeSource[],
) {
  const nodeIds = uniqueStrings(
    sources.flatMap((source) =>
      source.currentKnowledgeNodeId ? [source.currentKnowledgeNodeId] : [],
    ),
  );
  const existingNodes = nodeIds.length
    ? await transaction.knowledgeNode.findMany({
        where: { id: { in: nodeIds } },
        select: { id: true },
      })
    : [];
  const allowedNodes = new Set(existingNodes.map((node) => node.id));
  return sources.map((source) => ({
    ...source,
    currentKnowledgeNodeId:
      source.currentKnowledgeNodeId &&
      allowedNodes.has(source.currentKnowledgeNodeId)
        ? source.currentKnowledgeNodeId
        : null,
  }));
}

async function loadCurrentKnowledgeSources(
  transaction: TransactionClient,
  questionIds: string[],
): Promise<KnowledgeSource[]> {
  if (!questionIds.length) return [];
  const rows = await transaction.quizQuestionKnowledgeSource.findMany({
    where: { questionId: { in: questionIds }, current: true },
    select: {
      questionId: true,
      documentId: true,
      libraryId: true,
      nodePathHash: true,
      knowledgeNodeId: true,
      knowledgeNode: { select: { pathHash: true } },
      question: { select: { subjectId: true } },
    },
  });
  const deduplicated = new Map<string, KnowledgeSource>();
  for (const row of rows) {
    const nodePathHash =
      row.nodePathHash ?? row.knowledgeNode?.pathHash ?? null;
    if (!nodePathHash) continue;
    const key = compositeKey(row.questionId, row.documentId, nodePathHash);
    if (deduplicated.has(key)) continue;
    deduplicated.set(key, {
      questionId: row.questionId,
      documentId: row.documentId,
      nodePathHash,
      currentKnowledgeNodeId: row.knowledgeNodeId,
      subjectId: row.question.subjectId,
      libraryId: row.libraryId,
    });
  }
  return [...deduplicated.values()];
}

async function buildKnowledgeMutations(
  transaction: TransactionClient,
  userId: string,
  questions: ParsedQuestion[],
  resultByQuestion: Map<string, ParsedResult>,
  sourceByQuestion: Map<string, KnowledgeSource[]>,
  submittedAt: Date,
) {
  const sources = questions.flatMap(
    (question) => sourceByQuestion.get(question.id) ?? [],
  );
  const uniqueSourceKeys = uniqueStrings(
    sources.map((source) =>
      compositeKey(source.documentId, source.nodePathHash),
    ),
  );
  const previousRows = uniqueSourceKeys.length
    ? await transaction.userKnowledgeState.findMany({
        where: {
          userId,
          OR: uniqueSourceKeys.map((key) => {
            const [documentId, nodePathHash] = splitCompositeKey(key);
            return { documentId, nodePathHash };
          }),
        },
        select: knowledgeStateSelect,
      })
    : [];
  const previous = new Map(
    previousRows.map((row) => [
      compositeKey(row.documentId, row.nodePathHash),
      asLoadedState(row),
    ]),
  );
  const mutations = new Map<
    string,
    { source: KnowledgeSource; mutation: StateMutation }
  >();
  for (const question of questions) {
    const result = resultByQuestion.get(question.id)!;
    for (const source of sourceByQuestion.get(question.id) ?? []) {
      const key = compositeKey(source.documentId, source.nodePathHash);
      const current = mutations.get(key)?.mutation ?? previous.get(key) ?? null;
      mutations.set(key, {
        source,
        mutation: nextStateMutation(current, result, question.id, submittedAt),
      });
    }
  }
  return mutations;
}

async function buildChapterMutations(
  transaction: TransactionClient,
  userId: string,
  questions: ParsedQuestion[],
  resultByQuestion: Map<string, ParsedResult>,
  submittedAt: Date,
) {
  const chapterIds = uniqueStrings(
    questions.flatMap((question) => question.chapterIds),
  );
  const previousRows = chapterIds.length
    ? await transaction.userChapterState.findMany({
        where: { userId, subjectChapterId: { in: chapterIds } },
        select: chapterStateSelect,
      })
    : [];
  const previous = new Map(
    previousRows.map((row) => [row.subjectChapterId, asLoadedState(row)]),
  );
  const mutations = new Map<string, StateMutation>();
  for (const question of questions) {
    const result = resultByQuestion.get(question.id)!;
    for (const chapterId of uniqueStrings(question.chapterIds)) {
      const current =
        mutations.get(chapterId) ?? previous.get(chapterId) ?? null;
      mutations.set(
        chapterId,
        nextStateMutation(current, result, question.id, submittedAt),
      );
    }
  }
  return mutations;
}

const commonStateSelect = {
  attemptCount: true,
  correctCount: true,
  wrongCount: true,
  masteryBps: true,
  correctStreak: true,
  lastScoreBps: true,
  lastWrongAt: true,
  version: true,
} as const;

const knowledgeStateSelect = {
  ...commonStateSelect,
  documentId: true,
  nodePathHash: true,
} as const;

const chapterStateSelect = {
  ...commonStateSelect,
  subjectChapterId: true,
} as const;

function nextStateMutation(
  previous: LoadedState | StateMutation | null,
  result: ParsedResult,
  questionId: string,
  submittedAt: Date,
): StateMutation {
  const previousValue = !previous
    ? null
    : isStateMutation(previous)
      ? previous.state
      : previous.attemptCount > 0
        ? previous
        : null;
  const state = updatePracticeState(
    previousValue,
    result.score,
    result.maxScore,
  );
  const observed = observationBps(result.score, result.maxScore);
  const fullScore = observed === 10_000;
  const priorCorrect = previous ? previous.correctCount : 0;
  const priorWrong = previous ? previous.wrongCount : 0;
  const priorLastWrongAt = previous ? previous.lastWrongAt : null;
  const interval = reviewIntervalDays({
    observationBps: observed,
    correctStreak: state.correctStreak,
    masteryBps: state.masteryBps,
    recentConsecutiveErrors:
      !fullScore && Boolean(previous && previousValue!.lastScoreBps < 10_000),
  });
  return {
    state,
    correctCount: priorCorrect + (fullScore ? 1 : 0),
    wrongCount: priorWrong + (fullScore ? 0 : 1),
    lastWrongAt: fullScore ? priorLastWrongAt : submittedAt,
    lastPracticedAt: submittedAt,
    nextReviewAt: new Date(submittedAt.getTime() + interval * 86_400_000),
    missingRubricPoints: extractMissingRubricPoints(result.criterionScores),
    lastQuestionId: questionId,
    version: previous ? previous.version + 1 : 1,
  };
}

function stateWriteData(mutation: StateMutation) {
  return {
    attemptCount: mutation.state.attemptCount,
    correctCount: mutation.correctCount,
    wrongCount: mutation.wrongCount,
    masteryBps: mutation.state.masteryBps,
    correctStreak: mutation.state.correctStreak,
    lastScoreBps: mutation.state.lastScoreBps,
    lastPracticedAt: mutation.lastPracticedAt,
    lastWrongAt: mutation.lastWrongAt,
    nextReviewAt: mutation.nextReviewAt,
    missingRubricPoints:
      mutation.missingRubricPoints as unknown as Prisma.InputJsonValue,
    lastQuestionId: mutation.lastQuestionId,
    version: mutation.version,
  };
}

function asLoadedState(value: {
  attemptCount: number;
  masteryBps: number;
  correctStreak: number;
  lastScoreBps: number | null;
  correctCount: number;
  wrongCount: number;
  lastWrongAt: Date | null;
  version: number;
}): LoadedState {
  if (value.attemptCount > 0 && value.lastScoreBps === null) {
    throw new AttemptStateValidationError(
      'persisted practice state is inconsistent',
    );
  }
  return {
    attemptCount: value.attemptCount,
    masteryBps: value.masteryBps,
    correctStreak: value.correctStreak,
    lastScoreBps: value.lastScoreBps ?? 0,
    correctCount: value.correctCount,
    wrongCount: value.wrongCount,
    lastWrongAt: value.lastWrongAt,
    version: value.version,
  };
}

function isStateMutation(
  value: LoadedState | StateMutation,
): value is StateMutation {
  return 'state' in value;
}

export function parseAttemptSnapshot(value: JsonValue): ParsedQuestion[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) &&
        value.snapshotVersion === 2 &&
        Array.isArray(value.questions)
      ? value.questions
      : null;
  if (!raw || raw.length > 500)
    throw new AttemptStateValidationError('attempt snapshot is invalid');
  const seen = new Set<string>();
  return raw.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      seen.has(item.id)
    ) {
      throw new AttemptStateValidationError(
        'attempt snapshot question IDs are invalid',
      );
    }
    seen.add(item.id);
    const subjectId =
      isRecord(item.subject) && typeof item.subject.id === 'string'
        ? item.subject.id
        : typeof item.subjectId === 'string'
          ? item.subjectId
          : null;
    const chapterIds = Array.isArray(item.chapters)
      ? uniqueStrings(
          item.chapters.flatMap((chapter) =>
            isRecord(chapter) && typeof chapter.id === 'string'
              ? [chapter.id]
              : [],
          ),
        )
      : [];
    return {
      id: item.id,
      subjectId,
      chapterIds,
      knowledgeStateSources: parseFrozenSources(item.knowledgeStateSources),
    };
  });
}

function parseFrozenSources(
  value: unknown,
): Omit<KnowledgeSource, 'questionId'>[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 50) {
    throw new AttemptStateValidationError(
      'frozen knowledge sources are invalid',
    );
  }
  const seen = new Set<string>();
  return value.map((source) => {
    if (
      !isRecord(source) ||
      typeof source.documentId !== 'string' ||
      !source.documentId ||
      typeof source.nodePathHash !== 'string' ||
      !/^[a-f0-9]{64}$/iu.test(source.nodePathHash) ||
      typeof source.subjectId !== 'string' ||
      !source.subjectId ||
      typeof source.libraryId !== 'string' ||
      !source.libraryId ||
      !(
        source.currentKnowledgeNodeId === null ||
        typeof source.currentKnowledgeNodeId === 'string'
      )
    ) {
      throw new AttemptStateValidationError(
        'frozen knowledge source fields are invalid',
      );
    }
    const key = compositeKey(source.documentId, source.nodePathHash);
    if (seen.has(key)) {
      throw new AttemptStateValidationError(
        'frozen knowledge sources are duplicated',
      );
    }
    seen.add(key);
    return {
      documentId: source.documentId,
      nodePathHash: source.nodePathHash,
      currentKnowledgeNodeId: source.currentKnowledgeNodeId,
      subjectId: source.subjectId,
      libraryId: source.libraryId,
    };
  });
}

export function parseAttemptResults(value: JsonValue | null): ParsedResult[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new AttemptStateValidationError('attempt results are invalid');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.questionId !== 'string' ||
      !item.questionId ||
      seen.has(item.questionId)
    ) {
      throw new AttemptStateValidationError(
        'attempt result question IDs are invalid',
      );
    }
    seen.add(item.questionId);
    const score = finiteNumber(item.score, 'result score');
    const maxScore = finiteNumber(item.maxScore, 'result maxScore');
    observationBps(score, maxScore);
    const criterionScores = Array.isArray(item.criterionScores)
      ? item.criterionScores.flatMap((criterion) => {
          if (
            !isRecord(criterion) ||
            typeof criterion.description !== 'string'
          ) {
            return [];
          }
          const awardedPoints = finiteNumber(
            criterion.awardedPoints,
            'criterion awardedPoints',
          );
          const maxPoints = finiteNumber(
            criterion.maxPoints,
            'criterion maxPoints',
          );
          observationBps(awardedPoints, maxPoints);
          return [
            { description: criterion.description, awardedPoints, maxPoints },
          ];
        })
      : [];
    return { questionId: item.questionId, score, maxScore, criterionScores };
  });
}

function assertMatchingQuestionSets(
  questions: ParsedQuestion[],
  results: ParsedResult[],
) {
  const questionIds = new Set(questions.map((question) => question.id));
  if (
    results.length !== questions.length ||
    results.some((result) => !questionIds.has(result.questionId))
  ) {
    throw new AttemptStateValidationError(
      'attempt results do not match the snapshot',
    );
  }
}

function assertAttemptInput(input: SubmittedAttemptStateInput) {
  if (
    !input.id ||
    !input.userId ||
    !(input.submittedAt instanceof Date) ||
    !Number.isFinite(input.submittedAt.getTime())
  ) {
    throw new AttemptStateValidationError('submitted attempt input is invalid');
  }
}

function finiteNumber(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AttemptStateValidationError(`${name} must be finite`);
  }
  return value;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function groupBy<T>(values: T[], key: (value: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const current = grouped.get(key(value)) ?? [];
    current.push(value);
    grouped.set(key(value), current);
  }
  return grouped;
}

const COMPOSITE_SEPARATOR = '\u0000';

function compositeKey(...parts: string[]) {
  if (parts.some((part) => part.includes(COMPOSITE_SEPARATOR))) {
    throw new AttemptStateValidationError(
      'state key contains an invalid separator',
    );
  }
  return parts.join(COMPOSITE_SEPARATOR);
}

function splitCompositeKey(value: string): [string, string] {
  const parts = value.split(COMPOSITE_SEPARATOR);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AttemptStateValidationError('state key is invalid');
  }
  return [parts[0], parts[1]];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class AttemptStateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptStateValidationError';
  }
}

export class AttemptStateConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptStateConcurrencyError';
  }
}

export type DailyPracticePrismaClient = PrismaClient;
