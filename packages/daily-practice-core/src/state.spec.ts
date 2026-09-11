import {
  boundedMissingRubricStrings,
  extractMissingRubricPoints,
  observationBps,
  reviewIntervalDays,
  updatePracticeState,
} from './state';

describe('deterministic practice state', () => {
  it('computes observations and the 75/25 mastery update', () => {
    expect(observationBps(2, 3)).toBe(6_667);
    const first = updatePracticeState(null, 8, 10);
    expect(first).toEqual({
      attemptCount: 1,
      masteryBps: 8_000,
      correctStreak: 0,
      lastScoreBps: 8_000,
    });
    expect(updatePracticeState(first, 10, 10)).toEqual({
      attemptCount: 2,
      masteryBps: 8_500,
      correctStreak: 1,
      lastScoreBps: 10_000,
    });
  });

  it('uses only the fixed 1/3/7/14/30 day review intervals', () => {
    expect(
      reviewIntervalDays({ observationBps: 5_999, correctStreak: 0, masteryBps: 5_999 }),
    ).toBe(1);
    expect(
      reviewIntervalDays({ observationBps: 6_000, correctStreak: 0, masteryBps: 7_000 }),
    ).toBe(3);
    expect(
      reviewIntervalDays({ observationBps: 8_000, correctStreak: 0, masteryBps: 8_000 }),
    ).toBe(7);
    expect(
      reviewIntervalDays({ observationBps: 10_000, correctStreak: 2, masteryBps: 8_900 }),
    ).toBe(14);
    expect(
      reviewIntervalDays({ observationBps: 10_000, correctStreak: 3, masteryBps: 9_000 }),
    ).toBe(30);
    expect(
      reviewIntervalDays({
        observationBps: 10_000,
        correctStreak: 4,
        masteryBps: 9_500,
        recentConsecutiveErrors: true,
      }),
    ).toBe(1);
  });

  it('keeps at most ten bounded, deduplicated missing rubric points', () => {
    const criteria = Array.from({ length: 12 }, (_, index) => ({
      description:
        index < 2
          ? '  说明\n细胞膜的流动镶嵌结构  '
          : `${index} ${'长'.repeat(150)}`,
      awardedPoints: index === 11 ? 2 : 0,
      maxPoints: 2,
    }));
    const points = extractMissingRubricPoints(criteria);
    expect(points).toHaveLength(10);
    expect(points[0]?.text).toBe('说明 细胞膜的流动镶嵌结构');
    expect(points[0]?.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(points.every((point) => Array.from(point.text).length <= 120)).toBe(true);
    expect(points.every((point) => point.scoreBps < 10_000)).toBe(true);
    expect(boundedMissingRubricStrings(points)).toHaveLength(10);
  });

  it('rejects impossible scores', () => {
    expect(() => observationBps(-1, 10)).toThrow();
    expect(() => observationBps(11, 10)).toThrow();
    expect(() => observationBps(1, 0)).toThrow();
  });
});
