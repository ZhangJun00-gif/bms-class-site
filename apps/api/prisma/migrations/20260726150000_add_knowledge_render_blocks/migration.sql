-- AlterTable
ALTER TABLE `KnowledgeDocumentVersion`
    ADD COLUMN `renderStatus` ENUM('PENDING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
    ADD COLUMN `renderBlockVersion` VARCHAR(40) NULL,
    ADD COLUMN `renderBlockCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `mathCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `renderError` TEXT NULL;

-- CreateTable
CREATE TABLE `KnowledgeRenderBlock` (
    `id` VARCHAR(191) NOT NULL,
    `documentVersionId` VARCHAR(191) NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `blockIndex` INTEGER NOT NULL,
    `markdown` LONGTEXT NOT NULL,
    `sourceHash` CHAR(64) NOT NULL,
    `plainTextLength` INTEGER NOT NULL,
    `markdownBytes` INTEGER NOT NULL,
    `imageCount` INTEGER NOT NULL,
    `mathCount` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `KnowledgeRenderBlock_documentVersionId_nodeId_blockIndex_key`(`documentVersionId`, `nodeId`, `blockIndex`),
    INDEX `KnowledgeRenderBlock_documentVersionId_sourceHash_blockIndex_idx`(`documentVersionId`, `sourceHash`, `blockIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `KnowledgeImageReference`
    ADD COLUMN `renderBlockId` VARCHAR(191) NULL;

CREATE INDEX `KnowledgeImageReference_renderBlockId_idx`
    ON `KnowledgeImageReference`(`renderBlockId`);

-- AddForeignKey
ALTER TABLE `KnowledgeRenderBlock`
    ADD CONSTRAINT `KnowledgeRenderBlock_documentVersionId_fkey`
    FOREIGN KEY (`documentVersionId`) REFERENCES `KnowledgeDocumentVersion`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `KnowledgeRenderBlock`
    ADD CONSTRAINT `KnowledgeRenderBlock_nodeId_fkey`
    FOREIGN KEY (`nodeId`) REFERENCES `KnowledgeNode`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `KnowledgeImageReference`
    ADD CONSTRAINT `KnowledgeImageReference_renderBlockId_fkey`
    FOREIGN KEY (`renderBlockId`) REFERENCES `KnowledgeRenderBlock`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
