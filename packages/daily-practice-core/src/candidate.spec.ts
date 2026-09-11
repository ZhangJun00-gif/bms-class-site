import {
  countEffectiveSelectable,
  prepareCandidates,
  requiredDailyPlanConcurrency,
  scheduleUsersAcrossWindow,
  scoreCandidate,
  selectDeterministicCandidates,
  type CandidateScoreInput,
} from './candidate';
import { practiceDayWindow } from './time';

function candidate(
  questionId: string,
  overrides: Partial<CandidateScoreInput> = {},
): CandidateScoreInput {
  return {
    questionId,
    gradingType: 'SINGLE',
    reviewUrgency: 20,
    errorRisk: 10,
    masteryBps: 5_000,
    coverageDebt: 5,
    seenWithin24Hours: false,
    suggestionMatch: 0,
    ...overrides,
  };
}

describe('candidate scoring and scheduling', () => {
  it('uses the bounded transparent score components', () => {
    expect(
      scoreCandidate(
        candidate('q1', {
          reviewUrgency: 40,
          errorRisk: 30,
          masteryBps: 0,
          coverageDebt: 10,
          suggestionMatch: 10,
        }),
      ),
    ).toBe(110);
    expect(
      scoreCandidate(candidate('q2', { seenWithin24Hours: true })),
    ).toBe(scoreCandidate(candidate('q2')) - 30);
  });

  it('uses stable SHA-256 tie breaks independent of input order', () => {
    const left = prepareCandidates(
      [candidate('q1'), candidate('q2'), candidate('q3')],
      '2026-07-28',
      'user-1',
    );
    const right = prepareCandidates(
      [candidate('q3'), candidate('q1'), candidate('q2')],
      '2026-07-28',
      'user-1',
    );
    expect(left.candidates.map((item) => item.questionId)).toEqual(
      right.candidates.map((item) => item.questionId),
    );
    expect(left.candidates.every((item) => item.tieBreakHash.length === 64)).toBe(
      true,
    );
  });

  it('counts an all-short-answer pool as one effective selectable question', () => {
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate(`short-${index}`, { gradingType: 'SHORT_ANSWER' }),
    );
    expect(countEffectiveSelectable(candidates)).toBe(1);
    expect(
      prepareCandidates(candidates, '2026-07-28', 'user-1').questionCount,
    ).toEqual({ minimum: 1, maximum: 1 });
  });

  it('allows only the highest-priority short answer to be mandatory', () => {
    const prepared = prepareCandidates(
      [
        candidate('short-high', {
          gradingType: 'SHORT_ANSWER',
          reviewUrgency: 40,
          mandatoryEligible: true,
        }),
        candidate('short-low', {
          gradingType: 'SHORT_ANSWER',
          reviewUrgency: 30,
          mandatoryEligible: true,
        }),
        candidate('choice', {
          reviewUrgency: 25,
          mandatoryEligible: true,
        }),
      ],
      '2026-07-28',
      'user-1',
    );
    expect(prepared.mandatoryQuestionIds).toEqual(['short-high', 'choice']);
    const selected = selectDeterministicCandidates(prepared.candidates, 3);
    expect(
      selected.filter((item) => item.gradingType === 'SHORT_ANSWER'),
    ).toHaveLength(1);
    expect(selected.map((item) => item.questionId)).toEqual(
      expect.arrayContaining(prepared.mandatoryQuestionIds),
    );
  });

  it.each([100, 1_000])(
    'stably spreads %i users inside the dispatch budget',
    (count) => {
      const users = Array.from({ length: count }, (_, index) => `user-${index}`);
      const first = scheduleUsersAcrossWindow('2026-07-28', users, 120_000);
      const second = scheduleUsersAcrossWindow(
        '2026-07-28',
        [...users].reverse(),
        120_000,
      );
      expect(first).toEqual(second);
      const window = practiceDayWindow('2026-07-28');
      const latestAllowed = window.deadlineAt.getTime() - 120_000;
      expect(
        first.every(
          (item) =>
            item.scheduledAt >= window.dayStartedAt &&
            item.scheduledAt.getTime() < latestAllowed,
        ),
      ).toBe(true);
      expect(new Set(first.map((item) => item.userId)).size).toBe(count);
    },
  );

  it('calculates the minimum capacity and rejects budgets that cannot execute', () => {
    expect(
      requiredDailyPlanConcurrency({
        activeUserCount: 101,
        providerP95Ms: 10_000,
        dispatchBudgetMs: 1_500_000,
      }),
    ).toBe(1);
    expect(
      requiredDailyPlanConcurrency({
        activeUserCount: 1_000,
        providerP95Ms: 20_000,
        dispatchBudgetMs: 1_500_000,
      }),
    ).toBe(14);
    expect(
      requiredDailyPlanConcurrency({
        activeUserCount: 0,
        providerP95Ms: 20_000,
        dispatchBudgetMs: 1_500_000,
      }),
    ).toBe(0);
    for (const input of [
      { activeUserCount: 1.5, providerP95Ms: 1_000, dispatchBudgetMs: 1_000 },
      { activeUserCount: 1, providerP95Ms: 0, dispatchBudgetMs: 1_000 },
      { activeUserCount: 1, providerP95Ms: 1_000, dispatchBudgetMs: 0 },
      { activeUserCount: 1, providerP95Ms: 300_000, dispatchBudgetMs: 1_500_000 },
    ]) {
      expect(() => requiredDailyPlanConcurrency(input)).toThrow(RangeError);
    }
  });
});
