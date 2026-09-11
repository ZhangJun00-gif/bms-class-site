import {
  CreditHourReviewJobStatus,
  CreditHourSubmissionStatus,
  CreditHourType,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export const CREDIT_HOUR_MIN_HOURS = 0.5;
export const CREDIT_HOUR_MAX_HOURS = 1_000;

export class CreditHourSubmissionDto {
  @IsEnum(CreditHourType)
  type!: CreditHourType;

  @IsString()
  @Length(1, 160)
  activityName!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(CREDIT_HOUR_MIN_HOURS)
  @Max(CREDIT_HOUR_MAX_HOURS)
  hours!: number;

  @IsString()
  @Length(1, 2_000)
  sourceDescription!: string;

  @IsOptional()
  @IsString()
  @Length(1, 191)
  replacesSubmissionId?: string;
}

export class CreditHourPageQuery {
  @IsOptional()
  @IsEnum(CreditHourType)
  type?: CreditHourType;

  @IsOptional()
  @IsEnum(CreditHourSubmissionStatus)
  status?: CreditHourSubmissionStatus;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

export class CreditHourLeaderboardQuery {
  @IsIn([CreditHourType.QUALITY, CreditHourType.VOLUNTEER, 'TOTAL'])
  type: CreditHourType | 'TOTAL' = CreditHourType.QUALITY;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 50;
}

export class AdminCreditHourOverviewQuery {
  @IsOptional()
  @IsString()
  @Length(1, 512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 50;
}

export class WithdrawCreditHourDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}

export class AdminCreditHourPageQuery extends CreditHourPageQuery {
  @IsOptional()
  @IsString()
  @Length(1, 160)
  keyword?: string;

  @IsOptional()
  @IsEnum(CreditHourReviewJobStatus)
  jobStatus?: CreditHourReviewJobStatus;
}

export class AdminCreditHourCreateDto {
  @IsString()
  @Length(1, 191)
  userId!: string;

  @IsEnum(CreditHourType)
  type!: CreditHourType;

  @IsString()
  @Length(1, 160)
  activityName!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(CREDIT_HOUR_MIN_HOURS)
  @Max(CREDIT_HOUR_MAX_HOURS)
  hours!: number;

  @IsString()
  @Length(1, 2_000)
  description!: string;
}

export class AdminCreditHourDecisionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision!: number;

  @IsEnum(CreditHourSubmissionStatus)
  decision!: CreditHourSubmissionStatus;

  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class AdminCreditHourActionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision!: number;

  @IsString()
  @Length(1, 500)
  reason!: string;
}
