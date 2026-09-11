CREATE TABLE `CreditHourSubmissionBatch` (
  `id` VARCHAR(191) NOT NULL,
  `actorId` VARCHAR(191) NOT NULL,
  `idempotencyKey` VARCHAR(191) NOT NULL,
  `requestHash` CHAR(64) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `CreditHourSubmissionBatch_actorId_idempotencyKey_key`(`actorId`, `idempotencyKey`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CreditHourSubmission` ADD COLUMN `batchId` VARCHAR(191) NULL;

ALTER TABLE `CreditHourSubmission`
  ADD CONSTRAINT `CreditHourSubmission_batchId_fkey`
  FOREIGN KEY (`batchId`) REFERENCES `CreditHourSubmissionBatch`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CreditHourSubmissionBatch`
  ADD CONSTRAINT `CreditHourSubmissionBatch_actorId_fkey`
  FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
