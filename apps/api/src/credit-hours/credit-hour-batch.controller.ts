import { Body, Controller, Headers, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role, type User } from '@prisma/client';
import { CurrentUser, Roles } from '../common/auth';
import { AdminCreditHourBatchCreateDto } from './credit-hour-batch.dto';
import { CreditHourBatchService } from './credit-hour-batch.service';

@ApiTags('admin-credit-hours')
@Roles(Role.ADMIN)
@Controller('admin/credit-hours/submission-batches')
export class CreditHourBatchController {
  constructor(private readonly batches: CreditHourBatchService) {}

  @Post()
  create(
    @CurrentUser() user: User,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: AdminCreditHourBatchCreateDto,
  ) {
    return this.batches.create(user, idempotencyKey, dto);
  }
}
