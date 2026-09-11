-- Phase six is additive. Existing users, attempts, questions, knowledge rows,
-- and AI invocation records remain untouched; all new columns are nullable.

-- AlterTable
ALTER TABLE `AiInvocation`
    ADD COLUMN `usageDate` DATE NULL,
    ADD COLUMN `usageScope` VARCHAR(100) NULL,
    ADD COLUMN `idempotencyKey` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `QuizQuestionKnowledgeSource`
    ADD COLUMN `nodePathHash` CHAR(64) NULL;

-- AlterTable
ALTER TABLE `QuizAttempt`
    ADD COLUMN `knowledgeStateAppliedAt` DATETIME(3) NULL,
    ADD COLUMN `knowledgeStateRevision` INTEGER NULL,
    ADD COLUMN `dailyPracticePlanRevisionId` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `AiInvocation_idempotencyKey_key`
    ON `AiInvocation`(`idempotencyKey`);
CREATE INDEX `AiInvocation_usageDate_usageScope_taskType_idx`
    ON `AiInvocation`(`usageDate`, `usageScope`, `taskType`);
CREATE INDEX `QuizQSource_document_path_current_idx`
    ON `QuizQuestionKnowledgeSource`(`documentId`, `nodePathHash`, `current`);
CREATE UNIQUE INDEX `QuizAttempt_dailyPracticePlanRevisionId_key`
    ON `QuizAttempt`(`dailyPracticePlanRevisionId`);
CREATE INDEX `QuizAttempt_userId_submittedAt_id_idx`
    ON `QuizAttempt`(`userId`, `submittedAt`, `id`);
CREATE INDEX `QuizAttempt_knowledgeStateAppliedAt_submittedAt_id_idx`
    ON `QuizAttempt`(`knowledgeStateAppliedAt`, `submittedAt`, `id`);

-- CreateTable
CREATE TABLE `DailyPracticeSettings` (
    `singletonId` INTEGER NOT NULL DEFAULT 1,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `reason` VARCHAR(200) NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DailyPracticeSettings_updatedById_updatedAt_idx`(`updatedById`, `updatedAt`),
    PRIMARY KEY (`singletonId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyPracticeServicePause` (
    `id` VARCHAR(191) NOT NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `reason` VARCHAR(200) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelledById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DailyPracticeServicePause_cancelledAt_startsAt_endsAt_idx`(`cancelledAt`, `startsAt`, `endsAt`),
    INDEX `DailyPracticeServicePause_startsAt_endsAt_idx`(`startsAt`, `endsAt`),
    INDEX `DailyPracticeServicePause_createdAt_id_idx`(`createdAt`, `id`),
    INDEX `DailyPracticeServicePause_createdById_createdAt_idx`(`createdById`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TeachingProgress` (
    `id` VARCHAR(191) NOT NULL,
    `subjectId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `effectivePracticeDate` DATE NOT NULL,
    `basedOnProgressId` VARCHAR(191) NULL,
    `changeType` ENUM('INITIAL', 'ADD', 'CORRECTION') NOT NULL,
    `scopeHash` CHAR(64) NOT NULL,
    `note` VARCHAR(1000) NULL,
    `correctionReason` VARCHAR(1000) NULL,
    `publishedById` VARCHAR(191) NOT NULL,
    `publishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TeachingProgress_subjectId_version_key`(`subjectId`, `version`),
    INDEX `TeachingProgress_effective_subject_published_idx`(`effectivePracticeDate`, `subjectId`, `publishedAt`),
    INDEX `TeachingProgress_basedOnProgressId_idx`(`basedOnProgressId`),
    INDEX `TeachingProgress_publishedById_publishedAt_idx`(`publishedById`, `publishedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TeachingProgressNode` (
    `id` VARCHAR(191) NOT NULL,
    `progressId` VARCHAR(191) NOT NULL,
    `libraryId` VARCHAR(191) NOT NULL,
    `documentId` VARCHAR(191) NOT NULL,
    `nodePathHash` CHAR(64) NOT NULL,
    `currentKnowledgeNodeId` VARCHAR(191) NULL,
    `titleSnapshot` VARCHAR(200) NOT NULL,
    `breadcrumbSnapshot` VARCHAR(1000) NOT NULL,
    `firstTaughtDate` DATE NOT NULL,
    `sourceDocumentVersionId` VARCHAR(191) NOT NULL,
    `contentHashSnapshot` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TeachingProgressNode_progress_document_path_key`(`progressId`, `documentId`, `nodePathHash`),
    INDEX `TeachingProgressNode_documentId_nodePathHash_idx`(`documentId`, `nodePathHash`),
    INDEX `TeachingProgressNode_libraryId_documentId_idx`(`libraryId`, `documentId`),
    INDEX `TeachingProgressNode_currentKnowledgeNodeId_idx`(`currentKnowledgeNodeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyPracticeFixedAssignment` (
    `id` VARCHAR(191) NOT NULL,
    `practiceDate` DATE NOT NULL,
    `revision` INTEGER NOT NULL,
    `basedOnAssignmentId` VARCHAR(191) NULL,
    `assignmentHash` CHAR(64) NOT NULL,
    `note` VARCHAR(1000) NULL,
    `publishedById` VARCHAR(191) NOT NULL,
    `publishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DailyPracticeFixedAssignment_practiceDate_revision_key`(`practiceDate`, `revision`),
    INDEX `DailyPracticeFixedAssignment_practiceDate_publishedAt_idx`(`practiceDate`, `publishedAt`),
    INDEX `DailyPracticeFixedAssignment_basedOnAssignmentId_idx`(`basedOnAssignmentId`),
    INDEX `DailyPracticeFixedAssignment_publishedById_publishedAt_idx`(`publishedById`, `publishedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyPracticeFixedQuestion` (
    `id` VARCHAR(191) NOT NULL,
    `assignmentId` VARCHAR(191) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `questionId` VARCHAR(191) NOT NULL,
    `questionReviewRevision` INTEGER NOT NULL,
    `promptHash` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DailyPracticeFixedQuestion_assignmentId_ordinal_key`(`assignmentId`, `ordinal`),
    UNIQUE INDEX `DailyPracticeFixedQuestion_assignmentId_questionId_key`(`assignmentId`, `questionId`),
    INDEX `DailyPracticeFixedQuestion_questionId_assignmentId_idx`(`questionId`, `assignmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserPracticeProfile` (
    `userId` VARCHAR(191) NOT NULL,
    `stateRevision` INTEGER NOT NULL DEFAULT 0,
    `initializationStatus` ENUM('PENDING', 'PROCESSING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `initializedThroughAttemptId` VARCHAR(191) NULL,
    `initializedThroughAttemptAt` DATETIME(3) NULL,
    `lastAppliedAttemptAt` DATETIME(3) NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `questionCount` INTEGER NOT NULL DEFAULT 0,
    `correctCount` INTEGER NOT NULL DEFAULT 0,
    `wrongCount` INTEGER NOT NULL DEFAULT 0,
    `initializationError` VARCHAR(500) NULL,
    `leaseOwnerToken` VARCHAR(191) NULL,
    `leasedUntil` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `UserPracticeProfile_initializedThroughAttemptId_key`(`initializedThroughAttemptId`),
    INDEX `UserPracticeProfile_status_lease_updated_idx`(`initializationStatus`, `leasedUntil`, `updatedAt`),
    INDEX `UserPracticeProfile_leaseOwnerToken_leasedUntil_idx`(`leaseOwnerToken`, `leasedUntil`),
    INDEX `UserPracticeProfile_lastAppliedAttemptAt_idx`(`lastAppliedAttemptAt`),
    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserKnowledgeState` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `documentId` VARCHAR(191) NOT NULL,
    `nodePathHash` CHAR(64) NOT NULL,
    `currentKnowledgeNodeId` VARCHAR(191) NULL,
    `subjectId` VARCHAR(191) NOT NULL,
    `libraryId` VARCHAR(191) NOT NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `correctCount` INTEGER NOT NULL DEFAULT 0,
    `wrongCount` INTEGER NOT NULL DEFAULT 0,
    `masteryBps` INTEGER NOT NULL DEFAULT 0,
    `correctStreak` INTEGER NOT NULL DEFAULT 0,
    `lastScoreBps` INTEGER NULL,
    `lastPracticedAt` DATETIME(3) NULL,
    `lastWrongAt` DATETIME(3) NULL,
    `nextReviewAt` DATETIME(3) NULL,
    `missingRubricPoints` JSON NULL,
    `lastQuestionId` VARCHAR(191) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `UserKnowledgeState_user_document_path_key`(`userId`, `documentId`, `nodePathHash`),
    INDEX `UserKnowledgeState_userId_nextReviewAt_idx`(`userId`, `nextReviewAt`),
    INDEX `UserKnowledgeState_userId_lastWrongAt_idx`(`userId`, `lastWrongAt`),
    INDEX `UserKnowledgeState_documentId_nodePathHash_idx`(`documentId`, `nodePathHash`),
    INDEX `UserKnowledgeState_currentKnowledgeNodeId_idx`(`currentKnowledgeNodeId`),
    INDEX `UserKnowledgeState_lastQuestionId_idx`(`lastQuestionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserChapterState` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `subjectChapterId` VARCHAR(191) NOT NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `correctCount` INTEGER NOT NULL DEFAULT 0,
    `wrongCount` INTEGER NOT NULL DEFAULT 0,
    `masteryBps` INTEGER NOT NULL DEFAULT 0,
    `correctStreak` INTEGER NOT NULL DEFAULT 0,
    `lastScoreBps` INTEGER NULL,
    `lastPracticedAt` DATETIME(3) NULL,
    `lastWrongAt` DATETIME(3) NULL,
    `nextReviewAt` DATETIME(3) NULL,
    `missingRubricPoints` JSON NULL,
    `lastQuestionId` VARCHAR(191) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `UserChapterState_userId_subjectChapterId_key`(`userId`, `subjectChapterId`),
    INDEX `UserChapterState_userId_nextReviewAt_idx`(`userId`, `nextReviewAt`),
    INDEX `UserChapterState_userId_lastWrongAt_idx`(`userId`, `lastWrongAt`),
    INDEX `UserChapterState_subjectChapterId_masteryBps_idx`(`subjectChapterId`, `masteryBps`),
    INDEX `UserChapterState_lastQuestionId_idx`(`lastQuestionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyPracticeCycle` (
    `id` VARCHAR(191) NOT NULL,
    `practiceDate` DATE NOT NULL,
    `baselineAt` DATETIME(3) NOT NULL,
    `deadlineAt` DATETIME(3) NOT NULL,
    `candidateCutoffAt` DATETIME(3) NOT NULL,
    `status` ENUM('BUILDING', 'GENERATING', 'READY', 'PAUSED', 'DEGRADED', 'FAILED') NOT NULL DEFAULT 'BUILDING',
    `settingsRevision` INTEGER NOT NULL,
    `progressSetHash` CHAR(64) NOT NULL,
    `progressSnapshot` JSON NOT NULL,
    `fixedAssignmentId` VARCHAR(191) NULL,
    `frozenFixedAssignmentHash` CHAR(64) NOT NULL,
    `poolStats` JSON NULL,
    `counts` JSON NULL,
    `leaseOwnerToken` VARCHAR(191) NULL,
    `leasedUntil` DATETIME(3) NULL,
    `lastErrorCategory` VARCHAR(80) NULL,
    `lastErrorMessage` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DailyPracticeCycle_practiceDate_key`(`practiceDate`),
    INDEX `DailyPracticeCycle_status_leasedUntil_baselineAt_idx`(`status`, `leasedUntil`, `baselineAt`),
    INDEX `DailyPracticeCycle_leaseOwnerToken_leasedUntil_idx`(`leaseOwnerToken`, `leasedUntil`),
    INDEX `DailyPracticeCycle_fixedAssignmentId_idx`(`fixedAssignmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyPracticeDay` (
    `id` VARCHAR(191) NOT NULL,
    `cycleId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `practiceDate` DATE NOT NULL,
    `scheduledAt` DATETIME(3) NOT NULL,
    `deadlineAt` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'READY', 'LIMITED_CONTENT', 'NO_CONTENT', 'DEGRADED_READY', 'FAILED', 'PAUSED', 'STARTED', 'COMPLETED', 'STALE') NOT NULL DEFAULT 'PENDING',
    `profileRevision` INTEGER NOT NULL,
    `progressSetHash` CHAR(64) NOT NULL,
    `candidateSnapshot` JSON NULL,
    `fixedQuestionSnapshot` JSON NULL,
    `candidateHash` CHAR(64) NULL,
    `activeRevisionId` VARCHAR(191) NULL,
    `leaseOwnerToken` VARCHAR(191) NULL,
    `leasedUntil` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `lastErrorCategory` VARCHAR(80) NULL,
    `lastErrorMessage` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DailyPracticeDay_activeRevisionId_key`(`activeRevisionId`),
    UNIQUE INDEX `DailyPracticeDay_userId_practiceDate_key`(`userId`, `practiceDate`),
    INDEX `DailyPracticeDay_status_schedule_lease_idx`(`status`, `scheduledAt`, `leasedUntil`),
    INDEX `DailyPracticeDay_cycleId_status_idx`(`cycleId`, `status`),
    INDEX `DailyPracticeDay_userId_status_practiceDate_idx`(`userId`, `status`, `practiceDate`),
    INDEX `DailyPracticeDay_leaseOwnerToken_leasedUntil_idx`(`leaseOwnerToken`, `leasedUntil`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyPracticePlanRevision` (
    `id` VARCHAR(191) NOT NULL,
    `dayId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `trigger` ENUM('AUTO', 'ADMIN_REGENERATE', 'ADMIN_PREVIEW') NOT NULL,
    `promptVersion` VARCHAR(80) NOT NULL,
    `generationSource` ENUM('PRO_MAX', 'PRO_HIGH', 'FLASH_HIGH', 'DETERMINISTIC', 'NO_MODEL') NOT NULL DEFAULT 'NO_MODEL',
    `inputHash` CHAR(64) NULL,
    `outputHash` CHAR(64) NULL,
    `previousSummarySourceRevisionId` VARCHAR(191) NULL,
    `previousLearningSummarySnapshot` JSON NULL,
    `validatedOutput` JSON NULL,
    `summarySnapshot` JSON NULL,
    `suggestionEvaluation` JSON NULL,
    `degradedReason` VARCHAR(500) NULL,
    `createdById` VARCHAR(191) NULL,
    `generatedAt` DATETIME(3) NULL,
    `publishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DailyPracticePlanRevision_dayId_revision_key`(`dayId`, `revision`),
    INDEX `DailyPracticePlanRevision_dayId_trigger_generatedAt_idx`(`dayId`, `trigger`, `generatedAt`),
    INDEX `DailyPracticePlanRevision_generationSource_generatedAt_idx`(`generationSource`, `generatedAt`),
    INDEX `DailyPracticePlanRevision_previousSummarySourceRevisionId_idx`(`previousSummarySourceRevisionId`),
    INDEX `DailyPracticePlanRevision_createdById_createdAt_idx`(`createdById`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyPracticePlanItem` (
    `id` VARCHAR(191) NOT NULL,
    `revisionId` VARCHAR(191) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `source` ENUM('PERSONALIZED', 'ADMIN_FIXED') NOT NULL,
    `questionId` VARCHAR(191) NOT NULL,
    `questionReviewRevision` INTEGER NOT NULL,
    `sourceRevision` INTEGER NULL,
    `reason` VARCHAR(500) NOT NULL,
    `evidenceRefs` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DailyPracticePlanItem_revisionId_ordinal_key`(`revisionId`, `ordinal`),
    UNIQUE INDEX `DailyPracticePlanItem_revisionId_questionId_key`(`revisionId`, `questionId`),
    INDEX `DailyPracticePlanItem_questionId_revisionId_idx`(`questionId`, `revisionId`),
    INDEX `DailyPracticePlanItem_revisionId_source_idx`(`revisionId`, `source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyPracticeSuggestion` (
    `id` VARCHAR(191) NOT NULL,
    `targetUserId` VARCHAR(191) NOT NULL,
    `submittedById` VARCHAR(191) NOT NULL,
    `targetPracticeDate` DATE NOT NULL,
    `userQuotaKey` VARCHAR(191) NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'APPLIED', 'PARTIALLY_APPLIED', 'NOT_APPLIED', 'SUPERSEDED', 'EXPIRED_SERVICE_PAUSED') NOT NULL DEFAULT 'PENDING',
    `supersedesId` VARCHAR(191) NULL,
    `appliedRevisionId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DailyPracticeSuggestion_userQuotaKey_key`(`userQuotaKey`),
    INDEX `DailySuggestion_target_date_created_idx`(`targetUserId`, `targetPracticeDate`, `createdAt`),
    INDEX `DailyPracticeSuggestion_status_targetPracticeDate_createdAt_idx`(`status`, `targetPracticeDate`, `createdAt`),
    INDEX `DailyPracticeSuggestion_submittedById_createdAt_idx`(`submittedById`, `createdAt`),
    INDEX `DailyPracticeSuggestion_supersedesId_idx`(`supersedesId`),
    INDEX `DailyPracticeSuggestion_appliedRevisionId_idx`(`appliedRevisionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyPracticeStrategyAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `dayId` VARCHAR(191) NOT NULL,
    `planRevisionId` VARCHAR(191) NOT NULL,
    `strategy` ENUM('FLASH_NO_THINKING', 'FLASH_HIGH', 'PRO_HIGH', 'PRO_MAX') NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `aiInvocationId` VARCHAR(191) NULL,
    `errorCategory` VARCHAR(80) NULL,
    `errorMessage` VARCHAR(500) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DailyPracticeStrategyAttempt_aiInvocationId_key`(`aiInvocationId`),
    UNIQUE INDEX `DailyStrategyAttempt_day_revision_strategy_key`(`dayId`, `planRevisionId`, `strategy`),
    INDEX `DailyPracticeStrategyAttempt_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `DailyPracticeStrategyAttempt_planRevisionId_status_idx`(`planRevisionId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Default closed. The first management update advances this singleton's
-- revision and records the acting administrator or editor.
INSERT INTO `DailyPracticeSettings` (
    `singletonId`, `enabled`, `revision`, `createdAt`, `updatedAt`
) VALUES (
    1, false, 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
);

-- AddForeignKey
ALTER TABLE `DailyPracticeSettings`
    ADD CONSTRAINT `DailyPracticeSettings_updatedById_fkey`
    FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `DailyPracticeServicePause`
    ADD CONSTRAINT `DailyPracticeServicePause_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `DailyPracticeServicePause`
    ADD CONSTRAINT `DailyPracticeServicePause_cancelledById_fkey`
    FOREIGN KEY (`cancelledById`) REFERENCES `User`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `TeachingProgress`
    ADD CONSTRAINT `TeachingProgress_subjectId_fkey`
    FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `TeachingProgress`
    ADD CONSTRAINT `TeachingProgress_basedOnProgressId_fkey`
    FOREIGN KEY (`basedOnProgressId`) REFERENCES `TeachingProgress`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `TeachingProgress`
    ADD CONSTRAINT `TeachingProgress_publishedById_fkey`
    FOREIGN KEY (`publishedById`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `TeachingProgressNode`
    ADD CONSTRAINT `TeachingProgressNode_progressId_fkey`
    FOREIGN KEY (`progressId`) REFERENCES `TeachingProgress`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TeachingProgressNode`
    ADD CONSTRAINT `TeachingProgressNode_libraryId_fkey`
    FOREIGN KEY (`libraryId`) REFERENCES `KnowledgeLibrary`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `TeachingProgressNode`
    ADD CONSTRAINT `TeachingProgressNode_documentId_fkey`
    FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `TeachingProgressNode`
    ADD CONSTRAINT `TeachingProgressNode_currentKnowledgeNodeId_fkey`
    FOREIGN KEY (`currentKnowledgeNodeId`) REFERENCES `KnowledgeNode`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `DailyPracticeFixedAssignment`
    ADD CONSTRAINT `DailyPracticeFixedAssignment_basedOnAssignmentId_fkey`
    FOREIGN KEY (`basedOnAssignmentId`) REFERENCES `DailyPracticeFixedAssignment`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `DailyPracticeFixedAssignment`
    ADD CONSTRAINT `DailyPracticeFixedAssignment_publishedById_fkey`
    FOREIGN KEY (`publishedById`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `DailyPracticeFixedQuestion`
    ADD CONSTRAINT `DailyPracticeFixedQuestion_assignmentId_fkey`
    FOREIGN KEY (`assignmentId`) REFERENCES `DailyPracticeFixedAssignment`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `DailyPracticeFixedQuestion`
    ADD CONSTRAINT `DailyPracticeFixedQuestion_questionId_fkey`
    FOREIGN KEY (`questionId`) REFERENCES `QuizQuestion`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `UserPracticeProfile`
    ADD CONSTRAINT `UserPracticeProfile_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `UserPracticeProfile`
    ADD CONSTRAINT `UserPracticeProfile_initializedThroughAttemptId_fkey`
    FOREIGN KEY (`initializedThroughAttemptId`) REFERENCES `QuizAttempt`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `UserKnowledgeState`
    ADD CONSTRAINT `UserKnowledgeState_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `UserKnowledgeState`
    ADD CONSTRAINT `UserKnowledgeState_documentId_fkey`
    FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `UserKnowledgeState`
    ADD CONSTRAINT `UserKnowledgeState_currentKnowledgeNodeId_fkey`
    FOREIGN KEY (`currentKnowledgeNodeId`) REFERENCES `KnowledgeNode`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `UserKnowledgeState`
    ADD CONSTRAINT `UserKnowledgeState_subjectId_fkey`
    FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `UserKnowledgeState`
    ADD CONSTRAINT `UserKnowledgeState_libraryId_fkey`
    FOREIGN KEY (`libraryId`) REFERENCES `KnowledgeLibrary`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `UserKnowledgeState`
    ADD CONSTRAINT `UserKnowledgeState_lastQuestionId_fkey`
    FOREIGN KEY (`lastQuestionId`) REFERENCES `QuizQuestion`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `UserChapterState`
    ADD CONSTRAINT `UserChapterState_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `UserChapterState`
    ADD CONSTRAINT `UserChapterState_subjectChapterId_fkey`
    FOREIGN KEY (`subjectChapterId`) REFERENCES `SubjectChapter`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `UserChapterState`
    ADD CONSTRAINT `UserChapterState_lastQuestionId_fkey`
    FOREIGN KEY (`lastQuestionId`) REFERENCES `QuizQuestion`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `DailyPracticeCycle`
    ADD CONSTRAINT `DailyPracticeCycle_fixedAssignmentId_fkey`
    FOREIGN KEY (`fixedAssignmentId`) REFERENCES `DailyPracticeFixedAssignment`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `DailyPracticeDay`
    ADD CONSTRAINT `DailyPracticeDay_cycleId_fkey`
    FOREIGN KEY (`cycleId`) REFERENCES `DailyPracticeCycle`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `DailyPracticeDay`
    ADD CONSTRAINT `DailyPracticeDay_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `DailyPracticePlanRevision`
    ADD CONSTRAINT `DailyPracticePlanRevision_dayId_fkey`
    FOREIGN KEY (`dayId`) REFERENCES `DailyPracticeDay`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `DailyPracticePlanRevision`
    ADD CONSTRAINT `DailyPracticePlanRevision_previousSummarySourceRevisionId_fkey`
    FOREIGN KEY (`previousSummarySourceRevisionId`) REFERENCES `DailyPracticePlanRevision`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `DailyPracticePlanRevision`
    ADD CONSTRAINT `DailyPracticePlanRevision_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `DailyPracticeDay`
    ADD CONSTRAINT `DailyPracticeDay_activeRevisionId_fkey`
    FOREIGN KEY (`activeRevisionId`) REFERENCES `DailyPracticePlanRevision`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `DailyPracticePlanItem`
    ADD CONSTRAINT `DailyPracticePlanItem_revisionId_fkey`
    FOREIGN KEY (`revisionId`) REFERENCES `DailyPracticePlanRevision`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `DailyPracticePlanItem`
    ADD CONSTRAINT `DailyPracticePlanItem_questionId_fkey`
    FOREIGN KEY (`questionId`) REFERENCES `QuizQuestion`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `DailyPracticeSuggestion`
    ADD CONSTRAINT `DailyPracticeSuggestion_targetUserId_fkey`
    FOREIGN KEY (`targetUserId`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `DailyPracticeSuggestion`
    ADD CONSTRAINT `DailyPracticeSuggestion_submittedById_fkey`
    FOREIGN KEY (`submittedById`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `DailyPracticeSuggestion`
    ADD CONSTRAINT `DailyPracticeSuggestion_supersedesId_fkey`
    FOREIGN KEY (`supersedesId`) REFERENCES `DailyPracticeSuggestion`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `DailyPracticeSuggestion`
    ADD CONSTRAINT `DailyPracticeSuggestion_appliedRevisionId_fkey`
    FOREIGN KEY (`appliedRevisionId`) REFERENCES `DailyPracticePlanRevision`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `DailyPracticeStrategyAttempt`
    ADD CONSTRAINT `DailyPracticeStrategyAttempt_dayId_fkey`
    FOREIGN KEY (`dayId`) REFERENCES `DailyPracticeDay`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `DailyPracticeStrategyAttempt`
    ADD CONSTRAINT `DailyPracticeStrategyAttempt_planRevisionId_fkey`
    FOREIGN KEY (`planRevisionId`) REFERENCES `DailyPracticePlanRevision`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `DailyPracticeStrategyAttempt`
    ADD CONSTRAINT `DailyPracticeStrategyAttempt_aiInvocationId_fkey`
    FOREIGN KEY (`aiInvocationId`) REFERENCES `AiInvocation`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `QuizAttempt`
    ADD CONSTRAINT `QuizAttempt_dailyPracticePlanRevisionId_fkey`
    FOREIGN KEY (`dailyPracticePlanRevisionId`) REFERENCES `DailyPracticePlanRevision`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
