-- AlterTable
ALTER TABLE `DailyPracticeCycle` ADD COLUMN `refreezeRequestedAt` DATETIME(3) NULL,
    ADD COLUMN `refreezeRequestedById` VARCHAR(191) NULL;
