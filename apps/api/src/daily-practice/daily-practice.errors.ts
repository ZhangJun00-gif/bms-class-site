import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';

export const DAILY_PRACTICE_ERROR_CODES = {
  paused: 'DAILY_PRACTICE_PAUSED',
  notInitialized: 'DAILY_PRACTICE_NOT_INITIALIZED',
  generating: 'DAILY_PRACTICE_GENERATING',
  noTeachingProgress: 'DAILY_PRACTICE_NO_TEACHING_PROGRESS',
  noContent: 'DAILY_PRACTICE_NO_CONTENT',
  planStale: 'DAILY_PRACTICE_PLAN_STALE',
  planAlreadyStarted: 'DAILY_PRACTICE_PLAN_ALREADY_STARTED',
  suggestionLimit: 'DAILY_PRACTICE_SUGGESTION_LIMIT',
  suggestionOutOfScope: 'DAILY_PRACTICE_SUGGESTION_OUT_OF_SCOPE',
  progressConflict: 'DAILY_PRACTICE_PROGRESS_CONFLICT',
  fixedAssignmentLocked: 'DAILY_PRACTICE_FIXED_ASSIGNMENT_LOCKED',
  fixedQuestionInvalid: 'DAILY_PRACTICE_FIXED_QUESTION_INVALID',
  serviceRevisionConflict: 'DAILY_PRACTICE_SERVICE_REVISION_CONFLICT',
  cycleNoRebuildableDays: 'DAILY_PRACTICE_CYCLE_NO_REBUILDABLE_DAYS',
  cycleRefreezeDateConflict: 'DAILY_PRACTICE_CYCLE_REFREEZE_DATE_CONFLICT',
  modelQuota: 'DAILY_PRACTICE_MODEL_QUOTA',
} as const;

export type DailyPracticeErrorCode =
  (typeof DAILY_PRACTICE_ERROR_CODES)[keyof typeof DAILY_PRACTICE_ERROR_CODES];

export function dailyPracticeBadRequest(
  code: DailyPracticeErrorCode,
  message: string,
): never {
  throw new BadRequestException({ statusCode: 400, code, message });
}

export function dailyPracticeConflict(
  code: DailyPracticeErrorCode,
  message: string,
): never {
  throw new ConflictException({ statusCode: 409, code, message });
}

export function dailyPracticeNotFound(
  code: DailyPracticeErrorCode,
  message: string,
): never {
  throw new NotFoundException({ statusCode: 404, code, message });
}

export function dailyPracticeUnavailable(
  code: DailyPracticeErrorCode,
  message: string,
): never {
  throw new HttpException(
    { statusCode: HttpStatus.SERVICE_UNAVAILABLE, code, message },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
