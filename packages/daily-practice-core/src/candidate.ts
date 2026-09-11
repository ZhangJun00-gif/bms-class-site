import { createHash } from 'node:crypto';
import {
  DAILY_PRACTICE_SPREAD_WINDOW_MS,
  practiceDayWindow,
} from './time';

export const DAILY_PRACTICE_GRADING_TYPES = [
  'SINGLE',
  'MULTIPLE',
  'TRUE_FALSE',
  'SHORT_ANSWER',
] as const;

export type DailyPracticeGradingType =
  (typeof DAILY_PRACTICE_GRADING_TYPES)[number];

export interface CandidateScoreInput {
  questionId: string;
  gradingType: DailyPracticeGradingType;
  reviewUrgency: number;
  errorRisk: number;
  masteryBps: number | null;
  coverageDebt: number;
  seenWithin24Hours: boolean;
  suggestionMatch: number;
  mandatoryEligible?: boolean;
}

export interface ScoredCandidate extends CandidateScoreInput {
  priorityScore: number;
  tieBreakHash: string;
  mandatory: boolean;
}

export interface CandidatePreparation {
  candidates: ScoredCandidate[];
  mandatoryQuestionIds: string[];
  effectiveSelectableCount: number;
  questionCount: { minimum: number; maximum: number };
}

export interface ScheduledUser {
  userId: string;
  rank: number;
  scheduledAt: Date;
  tieBreakHash: string;
}

export interface DailyPlanCapacityInput {
  activeUserCount: number;
  providerP95Ms: number;
  dispatchBudgetMs: number;
}

export function requiredDailyPlanConcurrency(
  input: DailyPlanCapacityInput,
): number {
  const activeUserCount = integerInRange(
    input.activeUserCount,
    0,
    Number.MAX_SAFE_INTEGER,
    'activeUserCount',
  );
  const providerP95Ms = integerInRange(
    input.providerP95Ms,
    1,
    DAILY_PRACTICE_SPREAD_WINDOW_MS - 1,
    'providerP95Ms',
  );
  const dispatchBudgetMs = integerInRange(
    input.dispatchBudgetMs,
    1,
    DAILY_PRACTICE_SPREAD_WINDOW_MS - 1,
    'dispatchBudgetMs',
  );
  if (providerP95Ms >= DAILY_PRACTICE_SPREAD_WINDOW_MS - dispatchBudgetMs) {
    throw new RangeError(
      'capacity configuration must leave execution time after the dispatch budget',
    );
  }
  if (activeUserCount === 0) return 0;
  const totalProviderMs = activeUserCount * providerP95Ms;
  if (!Number.isSafeInteger(totalProviderMs)) {
    throw new RangeError('capacity calculation exceeds the safe integer range');
  }
  return Math.ceil(totalProviderMs / dispatchBudgetMs);
}

export function scoreCandidate(input: CandidateScoreInput): number {
  assertGradingType(input.gradingType);
  const review = integerInRange(input.reviewUrgency, 0, 40, 'reviewUrgency');
  const error = integerInRange(input.errorRisk, 0, 30, 'errorRisk');
  const masteryGap =
    input.masteryBps === null
      ? 20
      : Math.round(
          (10_000 - integerInRange(input.masteryBps, 0, 10_000, 'masteryBps')) /
            500,
        );
  const coverage = integerInRange(input.coverageDebt, 0, 10, 'coverageDebt');
  const suggestion = integerInRange(input.suggestionMatch, 0, 10, 'suggestionMatch');
  return (
    review +
    error +
    masteryGap +
    coverage +
    suggestion -
    (input.seenWithin24Hours ? 30 : 0)
  );
}

export function stableCandidateHash(
  practiceDate: string,
  userId: string,
  questionId: string,
): string {
  if (!userId || !questionId) throw new RangeError('userId and questionId are required');
  practiceDayWindow(practiceDate);
  return sha256(`${practiceDate}\0${userId}\0${questionId}`);
}

export function prepareCandidates(
  input: readonly CandidateScoreInput[],
  practiceDate: string,
  userId: string,
): CandidatePreparation {
  const ids = new Set<string>();
  const scored = input.map((candidate): ScoredCandidate => {
    if (!candidate.questionId || ids.has(candidate.questionId)) {
      throw new RangeError('candidate questionId values must be unique and non-empty');
    }
    ids.add(candidate.questionId);
    return {
      ...candidate,
      priorityScore: scoreCandidate(candidate),
      tieBreakHash: stableCandidateHash(practiceDate, userId, candidate.questionId),
      mandatory: false,
    };
  });
  scored.sort(compareScoredCandidates);

  const mandatory: ScoredCandidate[] = [];
  let mandatoryShortAnswerCount = 0;
  for (const candidate of scored) {
    if (!candidate.mandatoryEligible || mandatory.length >= 2) continue;
    if (candidate.gradingType === 'SHORT_ANSWER') {
      if (mandatoryShortAnswerCount >= 1) continue;
      mandatoryShortAnswerCount += 1;
    }
    candidate.mandatory = true;
    mandatory.push(candidate);
  }
  const effectiveSelectableCount = countEffectiveSelectable(scored);
  return {
    candidates: scored,
    mandatoryQuestionIds: mandatory.map((candidate) => candidate.questionId),
    effectiveSelectableCount,
    questionCount: dynamicQuestionCount(effectiveSelectableCount),
  };
}

export function countEffectiveSelectable(
  candidates: readonly Pick<CandidateScoreInput, 'gradingType'>[],
): number {
  let selectionQuestions = 0;
  let shortAnswers = 0;
  for (const candidate of candidates) {
    assertGradingType(candidate.gradingType);
    if (candidate.gradingType === 'SHORT_ANSWER') shortAnswers += 1;
    else selectionQuestions += 1;
  }
  return selectionQuestions + Math.min(shortAnswers, 1);
}

export function dynamicQuestionCount(effectiveSelectableCount: number): {
  minimum: number;
  maximum: number;
} {
  const effective = integerInRange(
    effectiveSelectableCount,
    0,
    Number.MAX_SAFE_INTEGER,
    'effectiveSelectableCount',
  );
  const maximum = Math.min(effective, 10);
  return {
    minimum: effective === 0 ? 0 : effective < 5 ? effective : 5,
    maximum,
  };
}

export function dynamicKnowledgeCount(candidateCount: number): {
  minimum: number;
  maximum: number;
} {
  const count = integerInRange(
    candidateCount,
    0,
    Number.MAX_SAFE_INTEGER,
    'candidateCount',
  );
  return {
    minimum: count === 0 ? 0 : Math.min(count, 3),
    maximum: Math.min(count, 5),
  };
}

export function scheduleUsersAcrossWindow(
  practiceDate: string,
  userIds: readonly string[],
  executionBudgetMs = 0,
): ScheduledUser[] {
  if (
    !Number.isSafeInteger(executionBudgetMs) ||
    executionBudgetMs < 0 ||
    executionBudgetMs >= DAILY_PRACTICE_SPREAD_WINDOW_MS
  ) {
    throw new RangeError('executionBudgetMs must leave a positive dispatch window');
  }
  const uniqueIds = new Set(userIds);
  if (uniqueIds.size !== userIds.length || userIds.some((id) => !id)) {
    throw new RangeError('userIds must be unique and non-empty');
  }
  const window = practiceDayWindow(practiceDate);
  const dispatchMs = DAILY_PRACTICE_SPREAD_WINDOW_MS - executionBudgetMs;
  const ordered = userIds
    .map((userId) => ({
      userId,
      tieBreakHash: sha256(`${practiceDate}\0${userId}`),
    }))
    .sort((left, right) =>
      compareAscii(left.tieBreakHash, right.tieBreakHash) ||
      compareAscii(left.userId, right.userId),
    );
  return ordered.map((item, rank) => ({
    ...item,
    rank,
    scheduledAt: scheduledAtForRank(
      window.dayStartedAt,
      rank,
      ordered.length,
      dispatchMs,
    ),
  }));
}

export function selectDeterministicCandidates(
  candidates: readonly ScoredCandidate[],
  maximumCount: number,
): ScoredCandidate[] {
  const target = integerInRange(maximumCount, 0, 10, 'maximumCount');
  const byId = new Map(candidates.map((candidate) => [candidate.questionId, candidate]));
  if (byId.size !== candidates.length) throw new RangeError('candidate IDs must be unique');
  const ordered = [...candidates].sort(compareScoredCandidates);
  const selected: ScoredCandidate[] = [];
  const selectedIds = new Set<string>();
  let shortAnswerCount = 0;
  const append = (candidate: ScoredCandidate) => {
    if (selected.length >= target || selectedIds.has(candidate.questionId)) return;
    if (candidate.gradingType === 'SHORT_ANSWER') {
      if (shortAnswerCount >= 1) return;
      shortAnswerCount += 1;
    }
    selected.push(candidate);
    selectedIds.add(candidate.questionId);
  };
  ordered.filter((candidate) => candidate.mandatory).forEach(append);
  ordered.forEach(append);
  return selected;
}

function scheduledAtForRank(
  startedAt: Date,
  rank: number,
  total: number,
  dispatchMs: number,
): Date {
  if (total === 0) throw new RangeError('cannot schedule a rank in an empty set');
  const offset = Math.floor(((rank + 0.5) * dispatchMs) / total);
  return new Date(startedAt.getTime() + offset);
}

function compareScoredCandidates(left: ScoredCandidate, right: ScoredCandidate) {
  return (
    right.priorityScore - left.priorityScore ||
    compareAscii(left.tieBreakHash, right.tieBreakHash) ||
    compareAscii(left.questionId, right.questionId)
  );
}

function assertGradingType(value: string): asserts value is DailyPracticeGradingType {
  if (!(DAILY_PRACTICE_GRADING_TYPES as readonly string[]).includes(value)) {
    throw new RangeError(`unsupported grading type: ${value}`);
  }
}

function integerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareAscii(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
