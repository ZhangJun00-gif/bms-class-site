import { Module } from '@nestjs/common';
import {
  AdminCreditHoursController,
  CreditHoursController,
} from './credit-hours.controller';
import { CreditHourExportService } from './credit-hour-export.service';
import { CreditHoursService } from './credit-hours.service';
import { CreditHourStorageRecoveryService } from './credit-hour-storage-recovery.service';
import { CreditHourBatchController } from './credit-hour-batch.controller';
import { CreditHourBatchService } from './credit-hour-batch.service';

@Module({
  controllers: [CreditHoursController, AdminCreditHoursController, CreditHourBatchController],
  providers: [CreditHoursService, CreditHourExportService, CreditHourStorageRecoveryService, CreditHourBatchService],
})
export class CreditHoursModule {}
