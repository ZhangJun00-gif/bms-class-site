import { createHash } from 'node:crypto';

export interface PracticeStateValue {
  attemptCount: number;
  masteryBps: number;
  correctStreak: number;
  lastScoreBps: number;
}

export interface CriterionScoreInput {
  description: string;
  awardedPoints: number;
  maxPoints: number;
}

export interface MissingRubricPoint {
  text: string;
  scoreBps: number;
  hash: string;
}

export function observationBps(score: number, maximumScore: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(maximumScore)) {
    throw new RangeError('scores must be finite numbers');
  }
  if (maximumScore <= 0 || score < 0 || score > maximumScore) {
    throw new RangeError('score must be between zero and maximumScore');
  }
  return clampBps(Math.round((score / maximumScore) * 10_000));
}

export function updatePracticeState(
  previous: PracticeStateValue | null,
  score: number,
  maximumScore: number,
): PracticeStateValue {
  const observed = observationBps(score, maximumScore);
  const fullScore = observed === 10_000;
  if (!previous) {
    return {
      attemptCount: 1,
      masteryBps: observed,
      correctStreak: fullScore ? 1 : 0,
      lastScoreBps: observed,
    };
  }
  assertState(previous);
  return {
    attemptCount: previous.attemptCount + 1,
    masteryBps: clampBps(
      Math.round(previous.masteryBps * 0.75 + observed * 0.25),
    ),
    correctStreak: fullScore ? previous.correctStreak + 1 : 0,
    lastScoreBps: observed,
  };
}

export function reviewIntervalDays(input: {
  observationBps: number;
  correctStreak: number;
  masteryBps: number;
  recentConsecutiveErrors?: boolean;
}): 1 | 3 | 7 | 14 | 30 {
  const observed = integerInRange(input.observationBps, 0, 10_000, 'observationBps');
  const mastery = integerInRange(input.masteryBps, 0, 10_000, 'masteryBps');
  const streak = integerInRange(
    input.correctStreak,
    0,
    Number.MAX_SAFE_INTEGER,
    'correctStreak',
  );
  if (input.recentConsecutiveErrors || observed < 6_000) return 1;
  if (observed === 10_000 && streak >= 3 && mastery >= 9_000) return 30;
  if (observed === 10_000 && streak >= 2) return 14;
  if (observed >= 8_000) return 7;
  return 3;
}

export function extractMissingRubricPoints(
  criteria: readonly CriterionScoreInput[],
  options: { maximumItems?: number; maximumTextLength?: number } = {},
): MissingRubricPoint[] {
  const maximumItems = boundedOption(options.maximumItems, 10, 1, 10);
  const maximumTextLength = boundedOption(
    options.maximumTextLength,
    120,
    1,
    120,
  );
  const seen = new Set<string>();
  const result: MissingRubricPoint[] = [];
  for (const criterion of criteria) {
    if (result.length >= maximumItems) break;
    const score = observationBps(criterion.awardedPoints, criterion.maxPoints);
    if (score === 10_000) continue;
    const text = boundCriterionText(criterion.description, maximumTextLength);
    if (!text) continue;
    const hash = createHash('sha256').update(text, 'utf8').digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    result.push({ text, scoreBps: score, hash });
  }
  return result;
}

export function boundedMissingRubricStrings(
  points: readonly MissingRubricPoint[],
): string[] {
  return points.slice(0, 10).map((point) => boundCriterionText(point.text, 120));
}

function assertState(value: PracticeStateValue) {
  integerInRange(value.attemptCount, 1, Number.MAX_SAFE_INTEGER, 'attemptCount');
  integerInRange(value.masteryBps, 0, 10_000, 'masteryBps');
  integerInRange(value.correctStreak, 0, Number.MAX_SAFE_INTEGER, 'correctStreak');
  integerInRange(value.lastScoreBps, 0, 10_000, 'lastScoreBps');
}

function boundCriterionText(value: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new TypeError('criterion description must be text');
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(normalized).slice(0, maximumLength).join('').trim();
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) return fallback;
  return integerInRange(value, minimum, maximum, 'option');
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

function clampBps(value: number) {
  return Math.min(10_000, Math.max(0, value));
}
