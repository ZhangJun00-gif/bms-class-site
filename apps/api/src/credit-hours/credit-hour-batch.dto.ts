import { CreditHourType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEnum,
  IsNumber, IsString, Length, Max, Min, ValidateNested,
} from 'class-validator';
import { CREDIT_HOUR_MAX_HOURS, CREDIT_HOUR_MIN_HOURS } from './credit-hours.dto';

export class CreditHourBatchEntryDto {
  @IsString()
  @Length(1, 191)
  userId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(CREDIT_HOUR_MIN_HOURS)
  @Max(CREDIT_HOUR_MAX_HOURS)
  hours!: number;
}

export class AdminCreditHourBatchCreateDto {
  @IsEnum(CreditHourType)
  type!: CreditHourType;

  @IsString()
  @Length(1, 160)
  activityName!: string;

  @IsString()
  @Length(1, 2_000)
  description!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((entry: CreditHourBatchEntryDto) => entry.userId)
  @ValidateNested({ each: true })
  @Type(() => CreditHourBatchEntryDto)
  entries!: CreditHourBatchEntryDto[];
}
