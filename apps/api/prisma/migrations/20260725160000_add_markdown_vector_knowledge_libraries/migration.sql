-- DropForeignKey
ALTER TABLE `KnowledgeChunk` DROP FOREIGN KEY `KnowledgeChunk_documentId_fkey`;

-- DropIndex
DROP INDEX `KnowledgeChunk_documentId_chunkIndex_key` ON `KnowledgeChunk`;

-- AlterTable
ALTER TABLE `KnowledgeDocument` ADD COLUMN `activeVersionId` VARCHAR(191) NULL,
    ADD COLUMN `libraryId` VARCHAR(191) NULL,
    ADD COLUMN `nextVersion` INTEGER NOT NULL DEFAULT 1,
    MODIFY `kind` ENUM('ARTICLE', 'PDF', 'DOCX', 'MARKDOWN') NOT NULL;

-- AlterTable
ALTER TABLE `KnowledgeChunk` ADD COLUMN `contentHash` CHAR(64) NULL,
    ADD COLUMN `documentVersionId` VARCHAR(191) NULL,
    ADD COLUMN `embeddedAt` DATETIME(3) NULL,
    ADD COLUMN `embeddingStatus` ENUM('PENDING', 'PROCESSING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
    ADD COLUMN `nodeId` VARCHAR(191) NULL,
    ADD COLUMN `tokenCount` INTEGER NULL,
    ADD COLUMN `versionNumber` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `IndexJob` ADD COLUMN `documentVersionId` VARCHAR(191) NULL,
    ADD COLUMN `idempotencyKey` VARCHAR(191) NULL,
    ADD COLUMN `operation` ENUM('LEGACY_INDEX', 'INDEX_VERSION', 'DELETE_VERSION_VECTORS', 'DELETE_DOCUMENT_VECTORS') NOT NULL DEFAULT 'LEGACY_INDEX',
    ADD COLUMN `progressCurrent` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `progressTotal` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `stage` VARCHAR(80) NOT NULL DEFAULT 'QUEUED';

-- AlterTable
ALTER TABLE `AiConversation` ADD COLUMN `knowledgeMode` ENUM('SHARED', 'PRIVATE', 'COMBINED') NULL,
    ADD COLUMN `subjectId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `AiMessage` ADD COLUMN `attachments` JSON NULL;

-- CreateTable
CREATE TABLE `KnowledgeLibrary` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `scope` ENUM('SHARED', 'PRIVATE') NOT NULL,
    `ownerId` VARCHAR(191) NULL,
    `subjectId` VARCHAR(191) NOT NULL,
    `aiEnabled` BOOLEAN NOT NULL DEFAULT false,
    `aiEnabledAt` DATETIME(3) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `KnowledgeLibrary_scope_subjectId_active_deletedAt_idx`(`scope`, `subjectId`, `active`, `deletedAt`),
    INDEX `KnowledgeLibrary_ownerId_active_deletedAt_idx`(`ownerId`, `active`, `deletedAt`),
    UNIQUE INDEX `KnowledgeLibrary_ownerId_name_key`(`ownerId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Preserve every legacy document by assigning one deterministic shared
-- compatibility library per existing subject. No document content or object
-- metadata is rewritten by this backfill.
INSERT INTO `KnowledgeLibrary` (
    `id`, `name`, `scope`, `ownerId`, `subjectId`, `aiEnabled`,
    `aiEnabledAt`, `active`, `createdAt`, `updatedAt`
)
SELECT
    CONCAT('legacy-shared-', LEFT(SHA2(`id`, 256), 32)),
    CONCAT(`name`, '（兼容知识库）'),
    'SHARED',
    NULL,
    `id`,
    true,
    CURRENT_TIMESTAMP(3),
    true,
    CURRENT_TIMESTAMP(3),
    CURRENT_TIMESTAMP(3)
FROM `KnowledgeSubject`;

UPDATE `KnowledgeDocument` AS document
INNER JOIN `KnowledgeLibrary` AS library
    ON library.`subjectId` = document.`subjectId`
    AND library.`scope` = 'SHARED'
    AND library.`id` = CONCAT('legacy-shared-', LEFT(SHA2(document.`subjectId`, 256), 32))
SET document.`libraryId` = library.`id`
WHERE document.`libraryId` IS NULL;

ALTER TABLE `KnowledgeDocument`
    MODIFY `libraryId` VARCHAR(191) NOT NULL;

ALTER TABLE `KnowledgeLibrary`
    ADD CONSTRAINT `KnowledgeLibrary_scope_owner_check`
    CHECK (
        (`scope` = 'SHARED' AND `ownerId` IS NULL) OR
        (`scope` = 'PRIVATE' AND `ownerId` IS NOT NULL)
    );

-- CreateTable
CREATE TABLE `KnowledgeLibraryChapter` (
    `id` VARCHAR(191) NOT NULL,
    `libraryId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `normalizedName` VARCHAR(100) NOT NULL,
    `slug` VARCHAR(100) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `KnowledgeLibraryChapter_libraryId_active_sortOrder_idx`(`libraryId`, `active`, `sortOrder`),
    UNIQUE INDEX `KnowledgeLibraryChapter_libraryId_normalizedName_key`(`libraryId`, `normalizedName`),
    UNIQUE INDEX `KnowledgeLibraryChapter_libraryId_slug_key`(`libraryId`, `slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeImportJob` (
    `id` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `confirmedById` VARCHAR(191) NULL,
    `libraryId` VARCHAR(191) NOT NULL,
    `targetDocumentId` VARCHAR(191) NULL,
    `fileType` ENUM('MARKDOWN', 'ZIP') NOT NULL,
    `sourceObjectKey` VARCHAR(500) NOT NULL,
    `sourceName` VARCHAR(255) NOT NULL,
    `sourceSize` INTEGER NOT NULL,
    `sourceSha256` CHAR(64) NOT NULL,
    `status` ENUM('PREFLIGHT_PENDING', 'PREFLIGHTING', 'INVALID', 'AWAITING_CONFIRMATION', 'INDEX_PENDING', 'PROCESSING', 'READY', 'FAILED', 'COMPENSATION_FAILED', 'EXPIRED') NOT NULL DEFAULT 'PREFLIGHT_PENDING',
    `stage` VARCHAR(80) NOT NULL DEFAULT 'QUEUED',
    `progressCurrent` INTEGER NOT NULL DEFAULT 0,
    `progressTotal` INTEGER NOT NULL DEFAULT 0,
    `title` VARCHAR(200) NULL,
    `nodeCount` INTEGER NOT NULL DEFAULT 0,
    `estimatedChunkCount` INTEGER NOT NULL DEFAULT 0,
    `imageCount` INTEGER NOT NULL DEFAULT 0,
    `processedImageBytes` BIGINT NOT NULL DEFAULT 0,
    `warningCount` INTEGER NOT NULL DEFAULT 0,
    `errorCount` INTEGER NOT NULL DEFAULT 0,
    `summary` JSON NULL,
    `reservedChunks` INTEGER NOT NULL DEFAULT 0,
    `reservedPoints` INTEGER NOT NULL DEFAULT 0,
    `reservedImages` INTEGER NOT NULL DEFAULT 0,
    `reservedMediaBytes` BIGINT NOT NULL DEFAULT 0,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `leasedUntil` DATETIME(3) NULL,
    `errorCode` VARCHAR(80) NULL,
    `errorMessage` TEXT NULL,
    `cancelRequestedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `confirmedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `confirmedVersionId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `KnowledgeImportJob_sourceObjectKey_key`(`sourceObjectKey`),
    UNIQUE INDEX `KnowledgeImportJob_confirmedVersionId_key`(`confirmedVersionId`),
    INDEX `KnowledgeImportJob_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `KnowledgeImportJob_createdById_status_idx`(`createdById`, `status`),
    INDEX `KnowledgeImportJob_libraryId_status_idx`(`libraryId`, `status`),
    INDEX `KnowledgeImportJob_targetDocumentId_status_idx`(`targetDocumentId`, `status`),
    INDEX `KnowledgeImportJob_expiresAt_status_idx`(`expiresAt`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeImportIssue` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `importId` VARCHAR(191) NOT NULL,
    `severity` ENUM('ERROR', 'WARNING') NOT NULL,
    `code` VARCHAR(80) NOT NULL,
    `message` VARCHAR(500) NOT NULL,
    `entryPath` VARCHAR(500) NULL,
    `nodePath` VARCHAR(500) NULL,
    `line` INTEGER NULL,
    `column` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `KnowledgeImportIssue_importId_severity_id_idx`(`importId`, `severity`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeImportAsset` (
    `id` VARCHAR(191) NOT NULL,
    `importId` VARCHAR(191) NOT NULL,
    `entryPath` VARCHAR(500) NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `sourceSize` INTEGER NOT NULL,
    `mimeType` VARCHAR(100) NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `processedSize` INTEGER NULL,
    `objectKey` VARCHAR(500) NULL,
    `photoId` VARCHAR(191) NULL,
    `status` ENUM('PLANNED', 'PROCESSED', 'UPLOADED', 'LINKED', 'CLEANED', 'ORPHANED') NOT NULL DEFAULT 'PLANNED',
    `cleanupError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `KnowledgeImportAsset_objectKey_key`(`objectKey`),
    UNIQUE INDEX `KnowledgeImportAsset_photoId_key`(`photoId`),
    INDEX `KnowledgeImportAsset_importId_status_idx`(`importId`, `status`),
    UNIQUE INDEX `KnowledgeImportAsset_importId_entryPath_key`(`importId`, `entryPath`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeCapacityCounter` (
    `key` VARCHAR(191) NOT NULL,
    `activeLibraries` INTEGER NOT NULL DEFAULT 0,
    `activeDocuments` INTEGER NOT NULL DEFAULT 0,
    `activeChunks` INTEGER NOT NULL DEFAULT 0,
    `livePoints` INTEGER NOT NULL DEFAULT 0,
    `imageCount` INTEGER NOT NULL DEFAULT 0,
    `mediaBytes` BIGINT NOT NULL DEFAULT 0,
    `reservedChunks` INTEGER NOT NULL DEFAULT 0,
    `reservedPoints` INTEGER NOT NULL DEFAULT 0,
    `reservedImages` INTEGER NOT NULL DEFAULT 0,
    `reservedMediaBytes` BIGINT NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed the transactional cache from legacy shared rows. Qdrant points remain
-- zero because this migration does not create vectors.
INSERT INTO `KnowledgeCapacityCounter` (
    `key`, `activeLibraries`, `activeDocuments`, `activeChunks`,
    `livePoints`, `imageCount`, `mediaBytes`, `reservedChunks`,
    `reservedPoints`, `reservedImages`, `reservedMediaBytes`, `updatedAt`
)
VALUES (
    'GLOBAL',
    (SELECT COUNT(*) FROM `KnowledgeLibrary` WHERE `deletedAt` IS NULL),
    (SELECT COUNT(*) FROM `KnowledgeDocument` WHERE `deletedAt` IS NULL),
    (SELECT COUNT(*) FROM `KnowledgeChunk`),
    0, 0, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP(3)
), (
    'PRIVATE_GLOBAL', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP(3)
);

-- CreateTable
CREATE TABLE `KnowledgeDocumentVersion` (
    `id` VARCHAR(191) NOT NULL,
    `documentId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `origin` ENUM('IMPORT', 'REINDEX') NOT NULL DEFAULT 'IMPORT',
    `title` VARCHAR(200) NOT NULL,
    `markdown` LONGTEXT NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `imageManifestHash` CHAR(64) NOT NULL,
    `indexStatus` ENUM('PENDING', 'PROCESSING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `parserVersion` VARCHAR(40) NOT NULL,
    `chunkerVersion` VARCHAR(40) NOT NULL,
    `embeddingModel` VARCHAR(80) NOT NULL,
    `embeddingDimensions` INTEGER NOT NULL,
    `nodeCount` INTEGER NOT NULL DEFAULT 0,
    `chunkCount` INTEGER NOT NULL DEFAULT 0,
    `vectorCount` INTEGER NOT NULL DEFAULT 0,
    `imageCount` INTEGER NOT NULL DEFAULT 0,
    `error` TEXT NULL,
    `indexedAt` DATETIME(3) NULL,
    `activatedAt` DATETIME(3) NULL,
    `retiredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `KnowledgeDocumentVersion_documentId_indexStatus_idx`(`documentId`, `indexStatus`),
    UNIQUE INDEX `KnowledgeDocumentVersion_documentId_version_key`(`documentId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeNode` (
    `id` VARCHAR(191) NOT NULL,
    `documentVersionId` VARCHAR(191) NOT NULL,
    `libraryChapterId` VARCHAR(191) NOT NULL,
    `parentId` VARCHAR(191) NULL,
    `level` INTEGER NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `path` VARCHAR(1000) NOT NULL,
    `pathHash` CHAR(64) NOT NULL,
    `breadcrumb` VARCHAR(1000) NOT NULL,
    `body` LONGTEXT NOT NULL,
    `sortOrder` INTEGER NOT NULL,

    INDEX `KnowledgeNode_libraryChapterId_sortOrder_idx`(`libraryChapterId`, `sortOrder`),
    INDEX `KnowledgeNode_parentId_sortOrder_idx`(`parentId`, `sortOrder`),
    UNIQUE INDEX `KnowledgeNode_documentVersionId_pathHash_key`(`documentVersionId`, `pathHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeVersionImage` (
    `id` VARCHAR(191) NOT NULL,
    `documentVersionId` VARCHAR(191) NOT NULL,
    `photoId` VARCHAR(191) NOT NULL,
    `importAssetId` VARCHAR(191) NULL,
    `entryPath` VARCHAR(500) NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `altText` VARCHAR(300) NOT NULL,
    `sortOrder` INTEGER NOT NULL,

    UNIQUE INDEX `KnowledgeVersionImage_importAssetId_key`(`importAssetId`),
    INDEX `KnowledgeVersionImage_photoId_idx`(`photoId`),
    INDEX `KnowledgeVersionImage_documentVersionId_sortOrder_idx`(`documentVersionId`, `sortOrder`),
    UNIQUE INDEX `KnowledgeVersionImage_documentVersionId_entryPath_key`(`documentVersionId`, `entryPath`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KnowledgeImageReference` (
    `id` VARCHAR(191) NOT NULL,
    `versionImageId` VARCHAR(191) NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `chunkId` VARCHAR(191) NULL,
    `occurrenceIndex` INTEGER NOT NULL,
    `altText` VARCHAR(300) NOT NULL,
    `sourceLine` INTEGER NULL,
    `sourceColumn` INTEGER NULL,

    INDEX `KnowledgeImageReference_chunkId_idx`(`chunkId`),
    INDEX `KnowledgeImageReference_nodeId_occurrenceIndex_idx`(`nodeId`, `occurrenceIndex`),
    UNIQUE INDEX `KnowledgeImageReference_versionImageId_occurrenceIndex_key`(`versionImageId`, `occurrenceIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiConversationLibrary` (
    `conversationId` VARCHAR(191) NOT NULL,
    `libraryId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiConversationLibrary_libraryId_conversationId_idx`(`libraryId`, `conversationId`),
    PRIMARY KEY (`conversationId`, `libraryId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `KnowledgeDocument_activeVersionId_key` ON `KnowledgeDocument`(`activeVersionId`);

-- CreateIndex
CREATE INDEX `KnowledgeDocument_libraryId_status_deletedAt_idx` ON `KnowledgeDocument`(`libraryId`, `status`, `deletedAt`);

-- CreateIndex
CREATE INDEX `KnowledgeDocument_libraryId_activeVersionId_idx` ON `KnowledgeDocument`(`libraryId`, `activeVersionId`);

-- CreateIndex
CREATE INDEX `KnowledgeChunk_documentVersionId_chunkIndex_idx` ON `KnowledgeChunk`(`documentVersionId`, `chunkIndex`);

-- CreateIndex
CREATE INDEX `KnowledgeChunk_nodeId_chunkIndex_idx` ON `KnowledgeChunk`(`nodeId`, `chunkIndex`);

-- CreateIndex
CREATE UNIQUE INDEX `KnowledgeChunk_documentId_versionNumber_chunkIndex_key` ON `KnowledgeChunk`(`documentId`, `versionNumber`, `chunkIndex`);

-- CreateIndex
CREATE UNIQUE INDEX `IndexJob_idempotencyKey_key` ON `IndexJob`(`idempotencyKey`);

-- CreateIndex
CREATE INDEX `AiConversation_subjectId_knowledgeMode_idx` ON `AiConversation`(`subjectId`, `knowledgeMode`);

-- AddForeignKey
ALTER TABLE `KnowledgeDocument` ADD CONSTRAINT `KnowledgeDocument_libraryId_fkey` FOREIGN KEY (`libraryId`) REFERENCES `KnowledgeLibrary`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeDocument` ADD CONSTRAINT `KnowledgeDocument_activeVersionId_fkey` FOREIGN KEY (`activeVersionId`) REFERENCES `KnowledgeDocumentVersion`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeChunk` ADD CONSTRAINT `KnowledgeChunk_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeChunk` ADD CONSTRAINT `KnowledgeChunk_documentVersionId_fkey` FOREIGN KEY (`documentVersionId`) REFERENCES `KnowledgeDocumentVersion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeChunk` ADD CONSTRAINT `KnowledgeChunk_nodeId_fkey` FOREIGN KEY (`nodeId`) REFERENCES `KnowledgeNode`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `IndexJob` ADD CONSTRAINT `IndexJob_documentVersionId_fkey` FOREIGN KEY (`documentVersionId`) REFERENCES `KnowledgeDocumentVersion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- MySQL 8.4 rejects ON UPDATE CASCADE for a foreign-key column that is also
-- referenced by KnowledgeLibrary_scope_owner_check. User IDs are immutable.
ALTER TABLE `KnowledgeLibrary` ADD CONSTRAINT `KnowledgeLibrary_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `KnowledgeLibrary` ADD CONSTRAINT `KnowledgeLibrary_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeLibraryChapter` ADD CONSTRAINT `KnowledgeLibraryChapter_libraryId_fkey` FOREIGN KEY (`libraryId`) REFERENCES `KnowledgeLibrary`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeImportJob` ADD CONSTRAINT `KnowledgeImportJob_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeImportJob` ADD CONSTRAINT `KnowledgeImportJob_confirmedById_fkey` FOREIGN KEY (`confirmedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeImportJob` ADD CONSTRAINT `KnowledgeImportJob_libraryId_fkey` FOREIGN KEY (`libraryId`) REFERENCES `KnowledgeLibrary`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeImportJob` ADD CONSTRAINT `KnowledgeImportJob_targetDocumentId_fkey` FOREIGN KEY (`targetDocumentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeImportJob` ADD CONSTRAINT `KnowledgeImportJob_confirmedVersionId_fkey` FOREIGN KEY (`confirmedVersionId`) REFERENCES `KnowledgeDocumentVersion`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeImportIssue` ADD CONSTRAINT `KnowledgeImportIssue_importId_fkey` FOREIGN KEY (`importId`) REFERENCES `KnowledgeImportJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeImportAsset` ADD CONSTRAINT `KnowledgeImportAsset_importId_fkey` FOREIGN KEY (`importId`) REFERENCES `KnowledgeImportJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeImportAsset` ADD CONSTRAINT `KnowledgeImportAsset_photoId_fkey` FOREIGN KEY (`photoId`) REFERENCES `Photo`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeDocumentVersion` ADD CONSTRAINT `KnowledgeDocumentVersion_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `KnowledgeDocument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeNode` ADD CONSTRAINT `KnowledgeNode_documentVersionId_fkey` FOREIGN KEY (`documentVersionId`) REFERENCES `KnowledgeDocumentVersion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeNode` ADD CONSTRAINT `KnowledgeNode_libraryChapterId_fkey` FOREIGN KEY (`libraryChapterId`) REFERENCES `KnowledgeLibraryChapter`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeNode` ADD CONSTRAINT `KnowledgeNode_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `KnowledgeNode`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeVersionImage` ADD CONSTRAINT `KnowledgeVersionImage_documentVersionId_fkey` FOREIGN KEY (`documentVersionId`) REFERENCES `KnowledgeDocumentVersion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeVersionImage` ADD CONSTRAINT `KnowledgeVersionImage_photoId_fkey` FOREIGN KEY (`photoId`) REFERENCES `Photo`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeVersionImage` ADD CONSTRAINT `KnowledgeVersionImage_importAssetId_fkey` FOREIGN KEY (`importAssetId`) REFERENCES `KnowledgeImportAsset`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeImageReference` ADD CONSTRAINT `KnowledgeImageReference_versionImageId_fkey` FOREIGN KEY (`versionImageId`) REFERENCES `KnowledgeVersionImage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeImageReference` ADD CONSTRAINT `KnowledgeImageReference_nodeId_fkey` FOREIGN KEY (`nodeId`) REFERENCES `KnowledgeNode`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeImageReference` ADD CONSTRAINT `KnowledgeImageReference_chunkId_fkey` FOREIGN KEY (`chunkId`) REFERENCES `KnowledgeChunk`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiConversation` ADD CONSTRAINT `AiConversation_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiConversationLibrary` ADD CONSTRAINT `AiConversationLibrary_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `AiConversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiConversationLibrary` ADD CONSTRAINT `AiConversationLibrary_libraryId_fkey` FOREIGN KEY (`libraryId`) REFERENCES `KnowledgeLibrary`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
