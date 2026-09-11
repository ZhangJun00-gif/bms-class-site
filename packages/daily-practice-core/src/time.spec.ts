import {
  addPracticeDateDays,
  nextPracticeDate,
  practiceDateDifference,
  practiceDateForInstant,
  practiceDateFromDbDate,
  practiceDateToDbDate,
  practiceDayWindow,
} from './time';

describe('daily practice time', () => {
  it('uses the Asia/Shanghai 04:00 boundary exactly', () => {
    expect(
      practiceDateForInstant(new Date('2026-07-27T19:59:59.999Z')),
    ).toBe('2026-07-27');
    expect(practiceDateForInstant(new Date('2026-07-27T20:00:00.000Z'))).toBe(
      '2026-07-28',
    );
    expect(practiceDateForInstant(new Date('2026-07-28T19:59:59.999Z'))).toBe(
      '2026-07-28',
    );
    expect(practiceDateForInstant(new Date('2026-07-28T20:00:00.000Z'))).toBe(
      '2026-07-29',
    );
  });

  it('returns authoritative start, deadline, and next-start instants', () => {
    const window = practiceDayWindow('2026-07-28');
    expect(window).toEqual({
      practiceDate: '2026-07-28',
      dayStartedAt: new Date('2026-07-27T20:00:00.000Z'),
      deadlineAt: new Date('2026-07-27T20:30:00.000Z'),
      nextDayStartsAt: new Date('2026-07-28T20:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });
  });

  it('handles month, year, and leap-day date arithmetic', () => {
    expect(nextPracticeDate('2026-12-31')).toBe('2027-01-01');
    expect(addPracticeDateDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addPracticeDateDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(practiceDateDifference('2028-03-01', '2028-02-28')).toBe(2);
    expect(practiceDateDifference('2026-07-28', '2026-08-01')).toBe(-4);
  });

  it('round-trips MySQL DATE values without applying a browser timezone', () => {
    const dbDate = practiceDateToDbDate('2026-07-28');
    expect(dbDate.toISOString()).toBe('2026-07-28T00:00:00.000Z');
    expect(practiceDateFromDbDate(dbDate)).toBe('2026-07-28');
    expect(practiceDateFromDbDate('2026-07-28')).toBe('2026-07-28');
  });

  it('rejects malformed and impossible calendar dates', () => {
    expect(() => practiceDayWindow('2026-02-29')).toThrow();
    expect(() => practiceDayWindow('2026-7-28')).toThrow();
  });
});
