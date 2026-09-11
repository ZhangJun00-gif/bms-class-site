-- Phase five is additive. Existing questions retain APPROVED visibility and
-- receive NOT_APPLICABLE source status; no user-owned rows are rewritten.

-- AlterTable
ALTER TABLE `QuizQuestion`
    ADD COLUMN `reviewRevision` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `sourceRevision` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `sourceReviewStatus` ENUM('NOT_APPLICABLE', 'VALID', 'REVIEW_REQUIRED') NOT NULL DEFAULT 'NOT_APPLICABLE',
    ADD COLUMN `sourceReviewRequiredAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `AiInvocation` (
    `id` VARCHAR(191) NOT NULL,
    `taskType` ENUM('CHAT_QA', 'QUESTION_GENERATION', 'SHORT_ANSWER_GRADING', 'DAILY_PLAN') NOT NULL,
    `strategy` ENUM('FLASH_NO_THINKING', 'FLASH_HIGH', 'PRO_HIGH', 'PRO_MAX') NOT NULL,
    `provider` VARCHAR(40) NOT NULL,
    `model` VARCHAR(100) NOT NULL,
    `promptVersion` VARCHAR(80) NOT NULL,
    `correlationType` VARCHAR(80) NOT NULL,
    `correlationId` VARCHAR(191) NOT NULL,
    `requestedById` VARCHAR(191) NULL,
    `status` ENUM('RESERVED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'RESERVED',
    `attempt` INTEGER NOT NULL DEFAULT 1,
    `inputHash` CHAR(64) NOT NULL,
    `outputHash` CHAR(64) NULL,
    `inputTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `reservedTokens` INTEGER NOT NULL DEFAULT 0,
    `usageSource` ENUM('PROVIDER', 'ESTIMATED') NOT NULL DEFAULT 'ESTIMATED',
    `pricingVersion` VARCHAR(80) NOT NULL DEFAULT 'unpriced-v1',
    `estimatedCostMicros` BIGINT NOT NULL DEFAULT 0,
    `latencyMs` INTEGER NULL,
    `providerRequestId` VARCHAR(191) NULL,
    `leasedUntil` DATETIME(3) NULL,
    `errorCategory` VARCHAR(80) NULL,
    `errorMessage` VARCHAR(500) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AiInvocation_status_leasedUntil_idx`(`status`, `leasedUntil`),
    INDEX `AiInvocation_taskType_createdAt_idx`(`taskType`, `createdAt`),
    INDEX `AiInvocation_correlationType_correlationId_idx`(`correlationType`, `correlationId`),
    INDEX `AiInvocation_requestedById_createdAt_idx`(`requestedById`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiDailyUsage` (
    `usageDate` DATE NOT NULL,
    `scope` VARCHAR(100) NOT NULL,
    `taskType` ENUM('CHAT_QA', 'QUESTION_GENERATION', 'SHORT_ANSWER_GRADING', 'DAILY_PLAN') NOT NULL,
    `calls` INTEGER NOT NULL DEFAULT 0,
    `activeCalls` INTEGER NOT NULL DEFAULT 0,
    `reservedTokens` BIGINT NOT NULL DEFAULT 0,
    `inputTokens` BIGINT NOT NULL DEFAULT 0,
    `outputTokens` BIGINT NOT NULL DEFAULT 0,
    `estimatedCostMicros` BIGINT NOT NULL DEFAULT 0,
    `failures` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AiDailyUsage_taskType_usageDate_idx`(`taskType`, `usageDate`),
    PRIMARY KEY (`usageDate`, `scope`, `taskType`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiQuestionGenerationJob` (
    `id` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `subjectId` VARCHAR(191) NOT NULL,
    `gradingType` ENUM('SINGLE', 'MULTIPLE', 'TRUE_FALSE', 'SHORT_ANSWER') NOT NULL,
    `typeLabel` VARCHAR(100) NOT NULL,
    `complexity` ENUM('SIMPLE', 'ASSOCIATIVE', 'COMPLEX', 'MAX') NOT NULL,
    `requestedCount` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'INVALID', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `stage` VARCHAR(80) NOT NULL DEFAULT 'QUEUED',
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `promptVersion` VARCHAR(80) NOT NULL,
    `configSnapshot` JSON NOT NULL,
    `validatedPayload` JSON NULL,
    `payloadHash` CHAR(64) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NULL,
    `leasedUntil` DATETIME(3) NULL,
    `cancelRequestedAt` DATETIME(3) NULL,
    `errorCategory` VARCHAR(80) NULL,
    `errorMessage` TEXT NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AiQuestionGenerationJob_createdById_idempotencyKey_key`(`createdById`, `idempotencyKey`),
    INDEX `AiQuestionGenerationJob_status_nextAttemptAt_createdAt_idx`(`status`, `nextAttemptAt`, `createdAt`),
    INDEX `AiQuestionGenerationJob_createdById_status_createdAt_idx`(`createdById`, `status`, `createdAt`),
    INDEX `AiQuestionGenerationJob_subjectId_createdAt_idx`(`subjectId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiQuestionGenerationChapter` (
    `jobId` VARCHAR(191) NOT NULL,
    `chapterId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiQuestionGenerationChapter_chapterId_idx`(`chapterId`),
    PRIMARY KEY (`jobId`, `chapterId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiQuestionGenerationSource` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `knowledgeNodeId` VARCHAR(191) NULL,
    `libraryId` VARCHAR(191) NOT NULL,
    `documentId` VARCHAR(191) NOT NULL,
    `documentVersionId` VARCHAR(191) NOT NULL,
    `libraryChapterId` VARCHAR(191) NOT NULL,
    `nodeTitle` VARCHAR(200) NOT NULL,
    `nodeTitleMarkdown` VARCHAR(4096) NOT NULL,
    `breadcrumb` VARCHAR(1000) NOT NULL,
    `nodePath` VARCHAR(1000) NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `chunkManifest` JSON NOT NULL,
    `evidenceContent` LONGTEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AiQuestionGenerationSource_jobId_ordinal_key`(`jobId`, `ordinal`),
    INDEX `AiQuestionGenerationSource_knowledgeNodeId_idx`(`knowledgeNodeId`),
    INDEX `AiQuestionGenerationSource_documentVersionId_idx`(`documentVersionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiQuestionGenerationItem` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `questionId` VARCHAR(191) NULL,
    `generatedSnapshot` JSON NOT NULL,
    `fingerprint` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AiQuestionGenerationItem_questionId_key`(`questionId`),
    UNIQUE INDEX `AiQuestionGenerationItem_jobId_ordinal_key`(`jobId`, `ordinal`),
    INDEX `AiQuestionGenerationItem_fingerprint_idx`(`fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `QuizQuestionKnowledgeSource` (
    `id` VARCHAR(191) NOT NULL,
    `questionId` VARCHAR(191) NOT NULL,
    `sourceRevision` INTEGER NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `knowledgeNodeId` VARCHAR(191) NULL,
    `generationSourceId` VARCHAR(191) NULL,
    `documentId` VARCHAR(191) NOT NULL,
    `documentVersionId` VARCHAR(191) NOT NULL,
    `libraryId` VARCHAR(191) NOT NULL,
    `libraryChapterId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `breadcrumb` VARCHAR(1000) NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `evidenceContent` LONGTEXT NOT NULL,
    `current` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `supersededAt` DATETIME(3) NULL,

    UNIQUE INDEX `QuizQSource_question_revision_ordinal_key`(`questionId`, `sourceRevision`, `ordinal`),
    INDEX `QuizQuestionKnowledgeSource_knowledgeNodeId_idx`(`knowledgeNodeId`),
    INDEX `QuizQuestionKnowledgeSource_generationSourceId_idx`(`generationSourceId`),
    INDEX `QuizQuestionKnowledgeSource_documentVersionId_current_idx`(`documentVersionId`, `current`),
    INDEX `QuizQuestionKnowledgeSource_libraryId_current_idx`(`libraryId`, `current`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `QuizQuestionReviewEvent` (
    `id` VARCHAR(191) NOT NULL,
    `questionId` VARCHAR(191) NOT NULL,
    `reviewerId` VARCHAR(191) NOT NULL,
    `action` ENUM('SAVE_DRAFT', 'APPROVE', 'REJECT', 'SOURCE_REVALIDATE') NOT NULL,
    `expectedRevision` INTEGER NOT NULL,
    `note` VARCHAR(1000) NULL,
    `beforeSnapshot` JSON NULL,
    `afterSnapshot` JSON NULL,
    `fieldDiff` JSON NULL,
    `sourceRevision` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `QuizQuestionReviewEvent_questionId_createdAt_idx`(`questionId`, `createdAt`),
    INDEX `QuizQuestionReviewEvent_reviewerId_createdAt_idx`(`reviewerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `QuizQuestion_reviewStatus_origin_createdAt_idx` ON `QuizQuestion`(`reviewStatus`, `origin`, `createdAt`);

-- CreateIndex
CREATE INDEX `QuizQuestion_sourceReviewStatus_reviewStatus_enabled_idx` ON `QuizQuestion`(`sourceReviewStatus`, `reviewStatus`, `enabled`);

-- AddForeignKey
ALTER TABLE `AiInvocation` ADD CONSTRAINT `AiInvocation_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiQuestionGenerationJob` ADD CONSTRAINT `AiQuestionGenerationJob_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiQuestionGenerationJob` ADD CONSTRAINT `AiQuestionGenerationJob_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiQuestionGenerationChapter` ADD CONSTRAINT `AiQuestionGenerationChapter_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `AiQuestionGenerationJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiQuestionGenerationChapter` ADD CONSTRAINT `AiQuestionGenerationChapter_chapterId_fkey` FOREIGN KEY (`chapterId`) REFERENCES `SubjectChapter`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiQuestionGenerationSource` ADD CONSTRAINT `AiQuestionGenerationSource_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `AiQuestionGenerationJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiQuestionGenerationSource` ADD CONSTRAINT `AiQuestionGenerationSource_knowledgeNodeId_fkey` FOREIGN KEY (`knowledgeNodeId`) REFERENCES `KnowledgeNode`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiQuestionGenerationItem` ADD CONSTRAINT `AiQuestionGenerationItem_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `AiQuestionGenerationJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiQuestionGenerationItem` ADD CONSTRAINT `AiQuestionGenerationItem_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `QuizQuestion`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizQuestionKnowledgeSource` ADD CONSTRAINT `QuizQuestionKnowledgeSource_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `QuizQuestion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizQuestionKnowledgeSource` ADD CONSTRAINT `QuizQuestionKnowledgeSource_knowledgeNodeId_fkey` FOREIGN KEY (`knowledgeNodeId`) REFERENCES `KnowledgeNode`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizQuestionKnowledgeSource` ADD CONSTRAINT `QuizQuestionKnowledgeSource_generationSourceId_fkey` FOREIGN KEY (`generationSourceId`) REFERENCES `AiQuestionGenerationSource`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizQuestionReviewEvent` ADD CONSTRAINT `QuizQuestionReviewEvent_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `QuizQuestion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizQuestionReviewEvent` ADD CONSTRAINT `QuizQuestionReviewEvent_reviewerId_fkey` FOREIGN KEY (`reviewerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
