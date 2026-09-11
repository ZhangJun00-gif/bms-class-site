import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminCreditHourCreateDto,
  CreditHourSubmissionDto,
} from './credit-hours.dto';

describe('credit hour DTO limits', () => {
  it('accepts 1000 hours and rejects 1000.5 hours for user submissions', async () => {
    const dto = plainToInstance(CreditHourSubmissionDto, {
      type: 'QUALITY',
      activityName: '活动',
      hours: 1_000,
      sourceDescription: '来源',
    });
    expect(await validate(dto)).toHaveLength(0);

    dto.hours = 1_000.5;
    expect((await validate(dto)).some((error) => error.property === 'hours')).toBe(
      true,
    );
  });

  it('accepts 1000 hours and rejects 1000.5 hours for admin-created records', async () => {
    const dto = plainToInstance(AdminCreditHourCreateDto, {
      userId: 'user-1',
      type: 'VOLUNTEER',
      activityName: '活动',
      hours: 1_000,
      description: '描述',
    });
    expect(await validate(dto)).toHaveLength(0);

    dto.hours = 1_000.5;
    expect((await validate(dto)).some((error) => error.property === 'hours')).toBe(
      true,
    );
  });
});
