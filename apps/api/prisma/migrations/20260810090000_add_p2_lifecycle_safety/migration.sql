-- AlterTable
ALTER TABLE `IndexJob`
    MODIFY `operation` ENUM('LEGACY_INDEX', 'INDEX_VERSION', 'DELETE_VERSION_VECTORS', 'DELETE_DOCUMENT_VECTORS', 'SYNC_VERSION_ACTIVITY') NOT NULL DEFAULT 'LEGACY_INDEX',
    ADD COLUMN `leaseOwnerToken` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `KnowledgeImportJob`
    ADD COLUMN `leaseOwnerToken` VARCHAR(191) NULL,
    ADD COLUMN `sourceCleanupStatus` ENUM('RETAINED', 'PENDING', 'IN_PROGRESS', 'CLEANED', 'FAILED') NOT NULL DEFAULT 'RETAINED',
    ADD COLUMN `sourceCleanupAttempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `sourceCleanupNextAttemptAt` DATETIME(3) NULL,
    ADD COLUMN `sourceCleanupError` TEXT NULL,
    ADD COLUMN `sourceCleanedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `QuizImportJob`
    ADD COLUMN `reservedQuestionCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `leaseOwnerToken` VARCHAR(191) NULL,
    ADD COLUMN `cancelRequestedAt` DATETIME(3) NULL,
    ADD COLUMN `sourceCleanupStatus` ENUM('RETAINED', 'PENDING', 'IN_PROGRESS', 'CLEANED', 'FAILED') NOT NULL DEFAULT 'RETAINED',
    ADD COLUMN `sourceCleanupAttempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `sourceCleanupNextAttemptAt` DATETIME(3) NULL,
    ADD COLUMN `sourceCleanupError` TEXT NULL,
    ADD COLUMN `sourceCleanedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `AiQuestionGenerationJob`
    ADD COLUMN `requestHash` CHAR(64) NULL,
    ADD COLUMN `leaseOwnerToken` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `QuizAttempt`
    ADD COLUMN `lifecycleStatus` ENUM('DRAFT', 'SCORING', 'SUBMITTED', 'SCORING_FAILED', 'ABANDONED') NULL,
    ADD COLUMN `draftRevision` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `position` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `savedAt` DATETIME(3) NULL,
    ADD COLUMN `expiresAt` DATETIME(3) NULL,
    ADD COLUMN `abandonedAt` DATETIME(3) NULL,
    ADD COLUMN `gradingOwnerToken` VARCHAR(191) NULL,
    ADD COLUMN `gradingLeasedUntil` DATETIME(3) NULL,
    ADD COLUMN `submissionHash` CHAR(64) NULL,
    ADD COLUMN `gradingError` VARCHAR(500) NULL;

-- AlterTable
ALTER TABLE `QuizQuestionReviewEvent`
    MODIFY `action` ENUM('SAVE_DRAFT', 'APPROVE', 'REJECT', 'SOURCE_REVALIDATE', 'REOPEN') NOT NULL;

-- CreateTable
CREATE TABLE `QuizCapacityCounter` (
    `singletonId` INTEGER NOT NULL DEFAULT 1,
    `activeQuestions` INTEGER NOT NULL DEFAULT 0,
    `reservedQuestions` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`singletonId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed the singleton without modifying existing business rows.
INSERT INTO `QuizCapacityCounter` (`singletonId`, `activeQuestions`, `reservedQuestions`, `updatedAt`)
SELECT 1, COUNT(*), 0, CURRENT_TIMESTAMP(3) FROM `QuizQuestion`;

-- CreateIndex
CREATE INDEX `IndexJob_leaseOwnerToken_leasedUntil_idx` ON `IndexJob`(`leaseOwnerToken`, `leasedUntil`);
CREATE INDEX `KnowledgeImportJob_leaseOwnerToken_leasedUntil_idx` ON `KnowledgeImportJob`(`leaseOwnerToken`, `leasedUntil`);
CREATE INDEX `KnowledgeImport_cleanup_due_idx` ON `KnowledgeImportJob`(`sourceCleanupStatus`, `sourceCleanupNextAttemptAt`);
CREATE INDEX `QuizImportJob_leaseOwnerToken_leasedUntil_idx` ON `QuizImportJob`(`leaseOwnerToken`, `leasedUntil`);
CREATE INDEX `QuizImport_cleanup_due_idx` ON `QuizImportJob`(`sourceCleanupStatus`, `sourceCleanupNextAttemptAt`);
CREATE INDEX `AiQuestionGenerationJob_leaseOwnerToken_leasedUntil_idx` ON `AiQuestionGenerationJob`(`leaseOwnerToken`, `leasedUntil`);
CREATE INDEX `QuizAttempt_userId_lifecycleStatus_expiresAt_idx` ON `QuizAttempt`(`userId`, `lifecycleStatus`, `expiresAt`);
CREATE INDEX `QuizAttempt_gradingOwnerToken_gradingLeasedUntil_idx` ON `QuizAttempt`(`gradingOwnerToken`, `gradingLeasedUntil`);
