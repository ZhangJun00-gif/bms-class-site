-- Additive metadata for the continuous knowledge reader and scoped conversations.
-- Every DDL statement is conditional because MySQL commits ALTER TABLE operations
-- independently. This also allows migrate resolve --rolled-back to recover a
-- deployment interrupted after only part of this migration was applied.

SET @bmc3_migration_sql = IF(
    EXISTS(
        SELECT 1
        FROM `information_schema`.`COLUMNS`
        WHERE `TABLE_SCHEMA` = DATABASE()
          AND `TABLE_NAME` = 'KnowledgeDocumentVersion'
          AND `COLUMN_NAME` = 'titleMarkdown'
    ),
    'SELECT 1',
    'ALTER TABLE `KnowledgeDocumentVersion` ADD COLUMN `titleMarkdown` VARCHAR(4096) NULL'
);
PREPARE bmc3_migration_statement FROM @bmc3_migration_sql;
EXECUTE bmc3_migration_statement;
DEALLOCATE PREPARE bmc3_migration_statement;

SET @bmc3_migration_sql = IF(
    EXISTS(
        SELECT 1
        FROM `information_schema`.`COLUMNS`
        WHERE `TABLE_SCHEMA` = DATABASE()
          AND `TABLE_NAME` = 'KnowledgeNode'
          AND `COLUMN_NAME` = 'titleMarkdown'
    ),
    'SELECT 1',
    'ALTER TABLE `KnowledgeNode` ADD COLUMN `titleMarkdown` VARCHAR(4096) NULL'
);
PREPARE bmc3_migration_statement FROM @bmc3_migration_sql;
EXECUTE bmc3_migration_statement;
DEALLOCATE PREPARE bmc3_migration_statement;

SET @bmc3_migration_sql = IF(
    EXISTS(
        SELECT 1
        FROM `information_schema`.`COLUMNS`
        WHERE `TABLE_SCHEMA` = DATABASE()
          AND `TABLE_NAME` = 'KnowledgeChunk'
          AND `COLUMN_NAME` = 'primaryRenderBlockId'
    ),
    'SELECT 1',
    'ALTER TABLE `KnowledgeChunk` ADD COLUMN `primaryRenderBlockId` VARCHAR(191) NULL'
);
PREPARE bmc3_migration_statement FROM @bmc3_migration_sql;
EXECUTE bmc3_migration_statement;
DEALLOCATE PREPARE bmc3_migration_statement;

SET @bmc3_migration_sql = IF(
    EXISTS(
        SELECT 1
        FROM `information_schema`.`STATISTICS`
        WHERE `TABLE_SCHEMA` = DATABASE()
          AND `TABLE_NAME` = 'KnowledgeChunk'
          AND `INDEX_NAME` = 'KnowledgeChunk_primaryRenderBlockId_idx'
    ),
    'SELECT 1',
    'CREATE INDEX `KnowledgeChunk_primaryRenderBlockId_idx` ON `KnowledgeChunk`(`primaryRenderBlockId`)'
);
PREPARE bmc3_migration_statement FROM @bmc3_migration_sql;
EXECUTE bmc3_migration_statement;
DEALLOCATE PREPARE bmc3_migration_statement;

SET @bmc3_migration_sql = IF(
    EXISTS(
        SELECT 1
        FROM `information_schema`.`TABLE_CONSTRAINTS`
        WHERE `CONSTRAINT_SCHEMA` = DATABASE()
          AND `TABLE_NAME` = 'KnowledgeChunk'
          AND `CONSTRAINT_NAME` = 'KnowledgeChunk_primaryRenderBlockId_fkey'
          AND `CONSTRAINT_TYPE` = 'FOREIGN KEY'
    ),
    'SELECT 1',
    'ALTER TABLE `KnowledgeChunk` ADD CONSTRAINT `KnowledgeChunk_primaryRenderBlockId_fkey` FOREIGN KEY (`primaryRenderBlockId`) REFERENCES `KnowledgeRenderBlock`(`id`) ON DELETE SET NULL ON UPDATE CASCADE'
);
PREPARE bmc3_migration_statement FROM @bmc3_migration_sql;
EXECUTE bmc3_migration_statement;
DEALLOCATE PREPARE bmc3_migration_statement;

CREATE TABLE IF NOT EXISTS `AiConversationLibraryChapter` (
    `conversationId` VARCHAR(191) NOT NULL,
    `libraryChapterId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiConversationLibraryChapter_libraryChapterId_conversationId_idx`(`libraryChapterId`, `conversationId`),
    PRIMARY KEY (`conversationId`, `libraryChapterId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @bmc3_migration_sql = IF(
    EXISTS(
        SELECT 1
        FROM `information_schema`.`TABLE_CONSTRAINTS`
        WHERE `CONSTRAINT_SCHEMA` = DATABASE()
          AND `TABLE_NAME` = 'AiConversationLibraryChapter'
          AND `CONSTRAINT_NAME` = 'AiConversationLibraryChapter_conversationId_fkey'
          AND `CONSTRAINT_TYPE` = 'FOREIGN KEY'
    ),
    'SELECT 1',
    'ALTER TABLE `AiConversationLibraryChapter` ADD CONSTRAINT `AiConversationLibraryChapter_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `AiConversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'
);
PREPARE bmc3_migration_statement FROM @bmc3_migration_sql;
EXECUTE bmc3_migration_statement;
DEALLOCATE PREPARE bmc3_migration_statement;

SET @bmc3_migration_sql = IF(
    EXISTS(
        SELECT 1
        FROM `information_schema`.`TABLE_CONSTRAINTS`
        WHERE `CONSTRAINT_SCHEMA` = DATABASE()
          AND `TABLE_NAME` = 'AiConversationLibraryChapter'
          AND `CONSTRAINT_NAME` = 'AiConversationLibraryChapter_libraryChapterId_fkey'
          AND `CONSTRAINT_TYPE` = 'FOREIGN KEY'
    ),
    'SELECT 1',
    'ALTER TABLE `AiConversationLibraryChapter` ADD CONSTRAINT `AiConversationLibraryChapter_libraryChapterId_fkey` FOREIGN KEY (`libraryChapterId`) REFERENCES `KnowledgeLibraryChapter`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE'
);
PREPARE bmc3_migration_statement FROM @bmc3_migration_sql;
EXECUTE bmc3_migration_statement;
DEALLOCATE PREPARE bmc3_migration_statement;
