-- Extend the shared AI enums for the isolated credit-hour vision lane.
ALTER TABLE `AiInvocation`
  MODIFY `taskType` ENUM('CHAT_QA', 'QUESTION_GENERATION', 'SHORT_ANSWER_GRADING', 'DAILY_PLAN', 'CREDIT_HOUR_REVIEW') NOT NULL,
  MODIFY `strategy` ENUM('FLASH_NO_THINKING', 'FLASH_HIGH', 'PRO_HIGH', 'PRO_MAX', 'VISION_HIGH') NOT NULL;

ALTER TABLE `AiDailyUsage`
  MODIFY `taskType` ENUM('CHAT_QA', 'QUESTION_GENERATION', 'SHORT_ANSWER_GRADING', 'DAILY_PLAN', 'CREDIT_HOUR_REVIEW') NOT NULL;

CREATE TABLE `CreditHourSubmission` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `type` ENUM('QUALITY', 'VOLUNTEER') NOT NULL,
  `status` ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN') NOT NULL DEFAULT 'PENDING_REVIEW',
  `revision` INTEGER NOT NULL DEFAULT 1,
  `currentReviewCycle` INTEGER NOT NULL DEFAULT 1,
  `idempotencyKey` VARCHAR(191) NOT NULL,
  `requestHash` CHAR(64) NOT NULL,
  `replacesSubmissionId` VARCHAR(191) NULL,
  `generation` INTEGER NOT NULL DEFAULT 1,
  `decisionSource` ENUM('AI', 'ADMIN_OVERRIDE') NULL,
  `decisionReason` VARCHAR(500) NULL,
  `decidedAt` DATETIME(3) NULL,
  `deletedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `CreditHourSubmission_user_key`(`userId`, `idempotencyKey`),
  INDEX `CreditHourSubmission_user_history_idx`(`userId`, `type`, `deletedAt`, `createdAt`, `id`),
  INDEX `CreditHourSubmission_public_history_idx`(`userId`, `type`, `status`, `deletedAt`, `decidedAt`, `id`),
  INDEX `CreditHourSubmission_admin_queue_idx`(`type`, `status`, `deletedAt`, `createdAt`, `id`),
  INDEX `CreditHourSubmission_decided_idx`(`decidedAt`, `id`),
  INDEX `CreditHourSubmission_replaces_idx`(`replacesSubmissionId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CreditHourSubmissionRevision` (
  `id` VARCHAR(191) NOT NULL,
  `submissionId` VARCHAR(191) NOT NULL,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `activityName` VARCHAR(160) NOT NULL,
  `halfHours` INTEGER NOT NULL,
  `sourceDescription` TEXT NOT NULL,
  `requestHash` CHAR(64) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `CreditHourRevision_submission_revision_key`(`submissionId`, `revision`),
  INDEX `CreditHourRevision_half_hours_idx`(`halfHours`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CreditHourEvidence` (
  `id` VARCHAR(191) NOT NULL,
  `revisionId` VARCHAR(191) NOT NULL,
  `sortOrder` INTEGER NOT NULL,
  `originalObjectKey` VARCHAR(500) NULL,
  `originalData` LONGBLOB NULL,
  `originalMimeType` VARCHAR(100) NOT NULL,
  `originalSize` INTEGER NOT NULL,
  `originalWidth` INTEGER NOT NULL,
  `originalHeight` INTEGER NOT NULL,
  `originalSha256` CHAR(64) NOT NULL,
  `displayObjectKey` VARCHAR(500) NULL,
  `displayData` LONGBLOB NULL,
  `displayMimeType` VARCHAR(100) NOT NULL DEFAULT 'image/webp',
  `displaySize` INTEGER NOT NULL,
  `displayWidth` INTEGER NOT NULL,
  `displayHeight` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `CreditHourEvidence_original_key_key`(`originalObjectKey`),
  UNIQUE INDEX `CreditHourEvidence_display_key_key`(`displayObjectKey`),
  UNIQUE INDEX `CreditHourEvidence_revision_order_key`(`revisionId`, `sortOrder`),
  INDEX `CreditHourEvidence_sha_idx`(`originalSha256`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CreditHourReviewJob` (
  `id` VARCHAR(191) NOT NULL,
  `submissionId` VARCHAR(191) NOT NULL,
  `reviewCycle` INTEGER NOT NULL,
  `contentRevision` INTEGER NOT NULL,
  `generation` INTEGER NOT NULL,
  `status` ENUM('PENDING', 'RUNNING', 'RETRY_PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE') NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `nextAttemptAt` DATETIME(3) NULL,
  `leaseOwnerToken` VARCHAR(191) NULL,
  `leasedUntil` DATETIME(3) NULL,
  `errorCategory` VARCHAR(80) NULL,
  `errorMessage` VARCHAR(500) NULL,
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `CreditHourReviewJob_cycle_key`(`submissionId`, `reviewCycle`),
  INDEX `CreditHourReviewJob_queue_idx`(`status`, `nextAttemptAt`, `createdAt`),
  INDEX `CreditHourReviewJob_lease_idx`(`leaseOwnerToken`, `leasedUntil`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CreditHourReviewAttempt` (
  `id` VARCHAR(191) NOT NULL,
  `jobId` VARCHAR(191) NOT NULL,
  `attempt` INTEGER NOT NULL,
  `aiInvocationId` VARCHAR(191) NULL,
  `model` VARCHAR(100) NOT NULL,
  `strategy` ENUM('FLASH_NO_THINKING', 'FLASH_HIGH', 'PRO_HIGH', 'PRO_MAX', 'VISION_HIGH') NOT NULL DEFAULT 'VISION_HIGH',
  `promptVersion` VARCHAR(80) NOT NULL,
  `decision` VARCHAR(20) NULL,
  `userReason` VARCHAR(500) NULL,
  `fieldSummary` JSON NULL,
  `riskCodes` JSON NULL,
  `inputHash` CHAR(64) NOT NULL,
  `outputHash` CHAR(64) NULL,
  `errorCategory` VARCHAR(80) NULL,
  `errorMessage` VARCHAR(500) NULL,
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `CreditHourReviewAttempt_job_attempt_key`(`jobId`, `attempt`),
  INDEX `CreditHourReviewAttempt_invocation_idx`(`aiInvocationId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CreditHourProviderFile` (
  `id` VARCHAR(191) NOT NULL,
  `attemptId` VARCHAR(191) NOT NULL,
  `evidenceId` VARCHAR(191) NOT NULL,
  `providerFileId` VARCHAR(191) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `deleteStatus` ENUM('PENDING', 'DELETED', 'FAILED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
  `deleteAttempts` INTEGER NOT NULL DEFAULT 0,
  `deleteError` VARCHAR(500) NULL,
  `deletedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `CreditHourProviderFile_attempt_evidence_key`(`attemptId`, `evidenceId`),
  INDEX `CreditHourProviderFile_cleanup_idx`(`deleteStatus`, `expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CreditHourDecisionEvent` (
  `id` VARCHAR(191) NOT NULL,
  `submissionId` VARCHAR(191) NOT NULL,
  `reviewCycle` INTEGER NOT NULL,
  `contentRevision` INTEGER NOT NULL,
  `source` ENUM('AI', 'ADMIN_OVERRIDE') NULL,
  `actorId` VARCHAR(191) NULL,
  `fromStatus` ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN') NOT NULL,
  `toStatus` ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN') NOT NULL,
  `reason` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `CreditHourDecisionEvent_submission_idx`(`submissionId`, `createdAt`),
  INDEX `CreditHourDecisionEvent_actor_idx`(`actorId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CreditHourCleanupOperation` (
  `id` VARCHAR(191) NOT NULL,
  `submissionId` VARCHAR(191) NOT NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `status` ENUM('PENDING', 'RUNNING', 'PARTIAL', 'COMPLETE', 'FAILED') NOT NULL DEFAULT 'PENDING',
  `manifest` JSON NOT NULL,
  `totalObjects` INTEGER NOT NULL DEFAULT 0,
  `deletedObjects` INTEGER NOT NULL DEFAULT 0,
  `errorMessage` VARCHAR(500) NULL,
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `CreditHourCleanup_submission_idx`(`submissionId`, `createdAt`),
  INDEX `CreditHourCleanup_status_idx`(`status`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CreditHourSubmission` ADD CONSTRAINT `CreditHourSubmission_user_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `CreditHourSubmission` ADD CONSTRAINT `CreditHourSubmission_replaces_fkey` FOREIGN KEY (`replacesSubmissionId`) REFERENCES `CreditHourSubmission`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `CreditHourSubmissionRevision` ADD CONSTRAINT `CreditHourRevision_submission_fkey` FOREIGN KEY (`submissionId`) REFERENCES `CreditHourSubmission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CreditHourEvidence` ADD CONSTRAINT `CreditHourEvidence_revision_fkey` FOREIGN KEY (`revisionId`) REFERENCES `CreditHourSubmissionRevision`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CreditHourReviewJob` ADD CONSTRAINT `CreditHourReviewJob_submission_fkey` FOREIGN KEY (`submissionId`) REFERENCES `CreditHourSubmission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CreditHourReviewAttempt` ADD CONSTRAINT `CreditHourReviewAttempt_job_fkey` FOREIGN KEY (`jobId`) REFERENCES `CreditHourReviewJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CreditHourProviderFile` ADD CONSTRAINT `CreditHourProviderFile_attempt_fkey` FOREIGN KEY (`attemptId`) REFERENCES `CreditHourReviewAttempt`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CreditHourProviderFile` ADD CONSTRAINT `CreditHourProviderFile_evidence_fkey` FOREIGN KEY (`evidenceId`) REFERENCES `CreditHourEvidence`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CreditHourDecisionEvent` ADD CONSTRAINT `CreditHourDecisionEvent_submission_fkey` FOREIGN KEY (`submissionId`) REFERENCES `CreditHourSubmission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CreditHourDecisionEvent` ADD CONSTRAINT `CreditHourDecisionEvent_actor_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `CreditHourCleanupOperation` ADD CONSTRAINT `CreditHourCleanup_submission_fkey` FOREIGN KEY (`submissionId`) REFERENCES `CreditHourSubmission`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `CreditHourCleanupOperation` ADD CONSTRAINT `CreditHourCleanup_actor_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
