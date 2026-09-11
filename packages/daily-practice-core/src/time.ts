export const DAILY_PRACTICE_TIME_ZONE = 'Asia/Shanghai';
export const DAILY_PRACTICE_DAY_START_HOUR = 4;
export const DAILY_PRACTICE_SPREAD_WINDOW_MS = 30 * 60_000;

export interface PracticeDayWindow {
  practiceDate: string;
  dayStartedAt: Date;
  deadlineAt: Date;
  nextDayStartsAt: Date;
  timeZone: typeof DAILY_PRACTICE_TIME_ZONE;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

interface DateTimeParts extends DateParts {
  hour: number;
  minute: number;
  second: number;
}

const localFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DAILY_PRACTICE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function practiceDateForInstant(instant: Date | number): string {
  const date = asValidInstant(instant);
  const local = formatLocalParts(date);
  const localDate = formatDateParts(local);
  return local.hour < DAILY_PRACTICE_DAY_START_HOUR
    ? addPracticeDateDays(localDate, -1)
    : localDate;
}

export function practiceDayWindow(practiceDate: string): PracticeDayWindow {
  const date = parsePracticeDate(practiceDate);
  const nextDate = addPracticeDateDays(practiceDate, 1);
  const dayStartedAt = zonedDateTimeToInstant({
    ...date,
    hour: DAILY_PRACTICE_DAY_START_HOUR,
    minute: 0,
    second: 0,
  });
  const nextDayStartsAt = zonedDateTimeToInstant({
    ...parsePracticeDate(nextDate),
    hour: DAILY_PRACTICE_DAY_START_HOUR,
    minute: 0,
    second: 0,
  });
  return {
    practiceDate,
    dayStartedAt,
    deadlineAt: new Date(dayStartedAt.getTime() + DAILY_PRACTICE_SPREAD_WINDOW_MS),
    nextDayStartsAt,
    timeZone: DAILY_PRACTICE_TIME_ZONE,
  };
}

export function nextPracticeDate(practiceDate: string): string {
  return addPracticeDateDays(practiceDate, 1);
}

export function previousPracticeDate(practiceDate: string): string {
  return addPracticeDateDays(practiceDate, -1);
}

export function addPracticeDateDays(practiceDate: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError('days must be an integer');
  const value = parsePracticeDate(practiceDate);
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return formatDateParts({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

export function practiceDateDifference(
  laterPracticeDate: string,
  earlierPracticeDate: string,
): number {
  const later = dateOnlyEpoch(laterPracticeDate);
  const earlier = dateOnlyEpoch(earlierPracticeDate);
  return Math.round((later - earlier) / 86_400_000);
}

export function practiceDateToDbDate(practiceDate: string): Date {
  const value = parsePracticeDate(practiceDate);
  return new Date(Date.UTC(value.year, value.month - 1, value.day));
}

export function practiceDateFromDbDate(value: Date | string): string {
  if (typeof value === 'string') {
    parsePracticeDate(value);
    return value;
  }
  const date = asValidInstant(value);
  return formatDateParts({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

export function isPracticeDate(value: string): boolean {
  try {
    parsePracticeDate(value);
    return true;
  } catch {
    return false;
  }
}

export function parsePracticeDate(value: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new RangeError('practiceDate must use YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    throw new RangeError('practiceDate is not a valid calendar date');
  }
  return { year, month, day };
}

function zonedDateTimeToInstant(target: DateTimeParts): Date {
  const targetAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const actual = formatLocalParts(new Date(candidate));
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = targetAsUtc - actualAsUtc;
    if (correction === 0) return new Date(candidate);
    candidate += correction;
  }
  const finalParts = formatLocalParts(new Date(candidate));
  if (sameDateTime(finalParts, target)) return new Date(candidate);
  throw new RangeError('local practice boundary could not be resolved');
}

function formatLocalParts(date: Date): DateTimeParts {
  const values = new Map(
    localFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: requiredPart(values, 'year'),
    month: requiredPart(values, 'month'),
    day: requiredPart(values, 'day'),
    hour: requiredPart(values, 'hour'),
    minute: requiredPart(values, 'minute'),
    second: requiredPart(values, 'second'),
  };
}

function requiredPart(values: Map<string, number>, name: string): number {
  const value = values.get(name);
  if (value === undefined || !Number.isInteger(value)) {
    throw new RangeError(`missing Intl ${name} part`);
  }
  return value;
}

function formatDateParts(value: DateParts): string {
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function dateOnlyEpoch(practiceDate: string): number {
  const value = parsePracticeDate(practiceDate);
  return Date.UTC(value.year, value.month - 1, value.day);
}

function sameDateTime(left: DateTimeParts, right: DateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function asValidInstant(value: Date | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('invalid instant');
  return date;
}
