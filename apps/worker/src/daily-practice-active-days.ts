import type { DailyPracticeDayStatus } from '@prisma/client';

export interface ActiveDailyDayLease {
  ownerToken: string;
  controller: AbortController;
  preservedStatus: DailyPracticeDayStatus | null;
}

export const activeDays = new Map<string, ActiveDailyDayLease>();

export function abortActiveDayGeneration(
  dayId: string,
  reason: string,
): boolean {
  const active = activeDays.get(dayId);
  if (!active) return false;
  activeDays.delete(dayId);
  active.controller.abort(new DOMException(reason, 'AbortError'));
  return true;
}
