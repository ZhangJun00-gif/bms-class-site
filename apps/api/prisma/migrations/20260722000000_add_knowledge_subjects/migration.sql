CREATE TABLE `KnowledgeSubject` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `slug` VARCHAR(100) NOT NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `KnowledgeSubject_name_key`(`name`),
  UNIQUE INDEX `KnowledgeSubject_slug_key`(`slug`),
  INDEX `KnowledgeSubject_active_sortOrder_idx`(`active`, `sortOrder`),
  INDEX `KnowledgeSubject_createdById_idx`(`createdById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `KnowledgeSubject` (`id`, `name`, `slug`, `sortOrder`, `active`, `updatedAt`)
VALUES
  ('knowledge-subject-human-01', '人体形态与功能功能总论', 'human-morphology-function', 10, true, CURRENT_TIMESTAMP(3)),
  ('knowledge-subject-molecular-01', '医学分子细胞遗传', 'medical-molecular-cell-genetics', 20, true, CURRENT_TIMESTAMP(3));

ALTER TABLE `KnowledgeDocument`
  ADD COLUMN `mimeType` VARCHAR(120) NULL,
  ADD COLUMN `fileSize` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `subjectId` VARCHAR(191) NULL;

UPDATE `KnowledgeDocument`
SET `subjectId` = 'knowledge-subject-human-01'
WHERE `subjectId` IS NULL;

ALTER TABLE `KnowledgeDocument`
  MODIFY `subjectId` VARCHAR(191) NOT NULL,
  ADD INDEX `KnowledgeDocument_subjectId_status_indexStatus_idx`(`subjectId`, `status`, `indexStatus`),
  ADD CONSTRAINT `KnowledgeDocument_subjectId_fkey`
    FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `KnowledgeSubject`
  ADD CONSTRAINT `KnowledgeSubject_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `IndexJob_documentId_status_idx` ON `IndexJob`(`documentId`, `status`);
