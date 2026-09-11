import { describe, expect, it } from 'vitest';
import { shanghaiPracticeDate } from './dailyPractice';

describe('shanghaiPracticeDate', () => {
  it('keeps 03:59:59 in the previous practice day', () => {
    const beforeBoundary = new Date('2026-07-27T19:59:59.999Z');
    expect(shanghaiPracticeDate(0, beforeBoundary)).toBe('2026-07-27');
    expect(shanghaiPracticeDate(1, beforeBoundary)).toBe('2026-07-28');
  });

  it('switches practice day exactly at 04:00', () => {
    const boundary = new Date('2026-07-27T20:00:00.000Z');
    expect(shanghaiPracticeDate(0, boundary)).toBe('2026-07-28');
    expect(shanghaiPracticeDate(1, boundary)).toBe('2026-07-29');
  });
});
