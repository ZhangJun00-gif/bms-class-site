SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `QuizImportJob` (
    `id` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `confirmedById` VARCHAR(191) NULL,
    `fileType` ENUM('CSV', 'ZIP') NOT NULL,
    `mode` ENUM('BANK', 'NEW_PAPER', 'APPEND_PAPER') NOT NULL,
    `sourceObjectKey` VARCHAR(500) NOT NULL,
    `sourceName` VARCHAR(255) NOT NULL,
    `sourceSize` INTEGER NOT NULL,
    `sourceSha256` CHAR(64) NOT NULL,
    `createMissingChapters` BOOLEAN NOT NULL DEFAULT false,
    `targetSubjectId` VARCHAR(191) NULL,
    `targetPastPaperId` VARCHAR(191) NULL,
    `pastPaperTitle` VARCHAR(160) NULL,
    `pastPaperYear` INTEGER NULL,
    `status` ENUM('PREFLIGHT_PENDING', 'PREFLIGHTING', 'AWAITING_CONFIRMATION', 'INVALID', 'IMPORT_PENDING', 'IMPORTING', 'COMPLETED', 'FAILED', 'COMPENSATION_FAILED', 'EXPIRED') NOT NULL DEFAULT 'PREFLIGHT_PENDING',
    `stage` VARCHAR(80) NOT NULL DEFAULT 'QUEUED',
    `progressCurrent` INTEGER NOT NULL DEFAULT 0,
    `progressTotal` INTEGER NOT NULL DEFAULT 0,
    `questionCount` INTEGER NOT NULL DEFAULT 0,
    `imageCount` INTEGER NOT NULL DEFAULT 0,
    `warningCount` INTEGER NOT NULL DEFAULT 0,
    `errorCount` INTEGER NOT NULL DEFAULT 0,
    `summary` JSON NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `leasedUntil` DATETIME(3) NULL,
    `errorCode` VARCHAR(80) NULL,
    `errorMessage` TEXT NULL,
    `importedCount` INTEGER NOT NULL DEFAULT 0,
    `createdChapterCount` INTEGER NOT NULL DEFAULT 0,
    `resultPastPaperId` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `confirmedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `QuizImportJob_sourceObjectKey_key`(`sourceObjectKey`),
    INDEX `QuizImportJob_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `QuizImportJob_createdById_createdAt_idx`(`createdById`, `createdAt`),
    INDEX `QuizImportJob_expiresAt_status_idx`(`expiresAt`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `QuizImportIssue` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `importId` VARCHAR(191) NOT NULL,
    `severity` ENUM('ERROR', 'WARNING') NOT NULL,
    `code` VARCHAR(80) NOT NULL,
    `rowNumber` INTEGER NULL,
    `filePath` VARCHAR(500) NULL,
    `field` VARCHAR(100) NULL,
    `message` VARCHAR(500) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `QuizImportIssue_importId_severity_id_idx`(`importId`, `severity`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `QuizImportAsset` (
    `id` VARCHAR(191) NOT NULL,
    `importId` VARCHAR(191) NOT NULL,
    `rowNumber` INTEGER NOT NULL,
    `filePath` VARCHAR(500) NOT NULL,
    `caption` VARCHAR(300) NOT NULL DEFAULT '',
    `sortOrder` INTEGER NOT NULL,
    `plannedPhotoId` VARCHAR(191) NOT NULL,
    `objectKey` VARCHAR(500) NULL,
    `mimeType` VARCHAR(100) NULL,
    `size` INTEGER NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `status` ENUM('PLANNED', 'UPLOADED', 'LINKED', 'CLEANED', 'ORPHANED') NOT NULL DEFAULT 'PLANNED',
    `cleanupError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `QuizImportAsset_plannedPhotoId_key`(`plannedPhotoId`),
    UNIQUE INDEX `QuizImportAsset_objectKey_key`(`objectKey`),
    UNIQUE INDEX `QuizImportAsset_importId_filePath_key`(`importId`, `filePath`),
    UNIQUE INDEX `QuizImportAsset_importId_rowNumber_sortOrder_key`(`importId`, `rowNumber`, `sortOrder`),
    INDEX `QuizImportAsset_importId_status_idx`(`importId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `QuizQuestion`
    ADD COLUMN `importJobId` VARCHAR(191) NULL,
    ADD COLUMN `importRowNumber` INTEGER NULL,
    ADD UNIQUE INDEX `QuizQuestion_importJobId_importRowNumber_key`(`importJobId`, `importRowNumber`);

ALTER TABLE `QuizImportJob`
    ADD CONSTRAINT `QuizImportJob_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `QuizImportIssue`
    ADD CONSTRAINT `QuizImportIssue_importId_fkey`
    FOREIGN KEY (`importId`) REFERENCES `QuizImportJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `QuizImportAsset`
    ADD CONSTRAINT `QuizImportAsset_importId_fkey`
    FOREIGN KEY (`importId`) REFERENCES `QuizImportJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `QuizQuestion`
    ADD CONSTRAINT `QuizQuestion_importJobId_fkey`
    FOREIGN KEY (`importJobId`) REFERENCES `QuizImportJob`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
