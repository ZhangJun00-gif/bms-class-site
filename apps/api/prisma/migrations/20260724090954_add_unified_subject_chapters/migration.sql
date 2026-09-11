-- Abort before structural changes when legacy labels cannot be migrated exactly.
-- Run the read-only taxonomy audit for row-level details before retrying.
CREATE TEMPORARY TABLE `_Phase1MigrationGuard` (
    `checkName` VARCHAR(100) NOT NULL,
    PRIMARY KEY (`checkName`)
);

INSERT INTO `_Phase1MigrationGuard` (`checkName`) VALUES ('legacy-labels-valid');
INSERT INTO `_Phase1MigrationGuard` (`checkName`)
SELECT 'legacy-labels-valid'
WHERE EXISTS (
    SELECT 1
    FROM `QuizQuestion`
    WHERE TRIM(`subject`) = ''
       OR TRIM(`chapter`) = ''
       OR BINARY `subject` <> BINARY TRIM(`subject`)
       OR BINARY `chapter` <> BINARY TRIM(`chapter`)
);

INSERT INTO `_Phase1MigrationGuard` (`checkName`) VALUES ('paper-labels-valid');
INSERT INTO `_Phase1MigrationGuard` (`checkName`)
SELECT 'paper-labels-valid'
WHERE EXISTS (
    SELECT 1
    FROM `QuizPaper`
    WHERE TRIM(`subject`) = ''
       OR BINARY `subject` <> BINARY TRIM(`subject`)
);

INSERT INTO `_Phase1MigrationGuard` (`checkName`) VALUES ('paper-subjects-match');
INSERT INTO `_Phase1MigrationGuard` (`checkName`)
SELECT 'paper-subjects-match'
WHERE EXISTS (
    SELECT 1
    FROM `QuizQuestion` AS `question`
    INNER JOIN `QuizPaper` AS `paper` ON `paper`.`id` = `question`.`pastPaperId`
    WHERE BINARY `question`.`subject` <> BINARY `paper`.`subject`
);

INSERT INTO `_Phase1MigrationGuard` (`checkName`) VALUES ('subject-labels-unambiguous');
INSERT INTO `_Phase1MigrationGuard` (`checkName`)
SELECT 'subject-labels-unambiguous'
WHERE EXISTS (
    SELECT 1
    FROM (
        SELECT LOWER(TRIM(`name`)) AS `normalized`, COUNT(DISTINCT BINARY `name`) AS `variants`
        FROM (
            SELECT `name` FROM `KnowledgeSubject`
            UNION ALL
            SELECT `subject` AS `name` FROM `QuizQuestion`
            UNION ALL
            SELECT `subject` AS `name` FROM `QuizPaper`
        ) AS `subjectNames`
        GROUP BY LOWER(TRIM(`name`))
        HAVING `variants` > 1
    ) AS `ambiguousSubjects`
);

INSERT INTO `_Phase1MigrationGuard` (`checkName`) VALUES ('chapter-labels-unambiguous');
INSERT INTO `_Phase1MigrationGuard` (`checkName`)
SELECT 'chapter-labels-unambiguous'
WHERE EXISTS (
    SELECT 1
    FROM (
        SELECT BINARY `subject`, LOWER(TRIM(`chapter`)) AS `normalized`, COUNT(DISTINCT BINARY `chapter`) AS `variants`
        FROM `QuizQuestion`
        GROUP BY BINARY `subject`, LOWER(TRIM(`chapter`))
        HAVING `variants` > 1
    ) AS `ambiguousChapters`
);

DROP TEMPORARY TABLE `_Phase1MigrationGuard`;

-- DropIndex
DROP INDEX `QuizPaper_subject_year_createdAt_idx` ON `QuizPaper`;

-- DropIndex
DROP INDEX `QuizQuestion_enabled_subject_chapter_difficulty_idx` ON `QuizQuestion`;

-- DropIndex
DROP INDEX `QuizQuestion_enabled_subject_typeLabel_difficulty_idx` ON `QuizQuestion`;

-- AlterTable
ALTER TABLE `QuizPaper` ADD COLUMN `subjectId` VARCHAR(191) NULL,
    MODIFY `subject` VARCHAR(100) NULL;

-- AlterTable
ALTER TABLE `QuizQuestion` ADD COLUMN `category` ENUM('STANDARD', 'KNOWLEDGE_RECALL') NOT NULL DEFAULT 'STANDARD',
    ADD COLUMN `origin` ENUM('MANUAL', 'CSV', 'AI_GENERATED') NOT NULL DEFAULT 'MANUAL',
    ADD COLUMN `reviewStatus` ENUM('DRAFT_REVIEW', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'APPROVED',
    ADD COLUMN `subjectId` VARCHAR(191) NULL,
    MODIFY `subject` VARCHAR(100) NULL,
    MODIFY `chapter` VARCHAR(100) NULL;

-- CreateTable
CREATE TABLE `SubjectChapter` (
    `id` VARCHAR(191) NOT NULL,
    `subjectId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `slug` VARCHAR(100) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SubjectChapter_subjectId_active_sortOrder_idx`(`subjectId`, `active`, `sortOrder`),
    UNIQUE INDEX `SubjectChapter_subjectId_name_key`(`subjectId`, `name`),
    UNIQUE INDEX `SubjectChapter_subjectId_slug_key`(`subjectId`, `slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `QuizQuestionChapter` (
    `questionId` VARCHAR(191) NOT NULL,
    `chapterId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `QuizQuestionChapter_chapterId_questionId_idx`(`chapterId`, `questionId`),
    PRIMARY KEY (`questionId`, `chapterId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Preserve exact legacy names. Deterministic ids and slugs make a restored
-- migration repeatable without guessing or transliterating medical labels.
INSERT INTO `KnowledgeSubject` (
    `id`,
    `name`,
    `slug`,
    `sortOrder`,
    `active`,
    `createdAt`,
    `updatedAt`
)
SELECT
    CONCAT('subject-', LEFT(SHA2(CONCAT('quiz-subject:', `legacy`.`name`), 256), 32)),
    `legacy`.`name`,
    CONCAT('legacy-', LEFT(SHA2(CONCAT('quiz-subject-slug:', `legacy`.`name`), 256), 48)),
    1000,
    true,
    CURRENT_TIMESTAMP(3),
    CURRENT_TIMESTAMP(3)
FROM (
    SELECT `subject` AS `name` FROM `QuizQuestion`
    UNION
    SELECT `subject` AS `name` FROM `QuizPaper`
) AS `legacy`
WHERE NOT EXISTS (
    SELECT 1
    FROM `KnowledgeSubject` AS `subject`
    WHERE BINARY `subject`.`name` = BINARY `legacy`.`name`
);

UPDATE `QuizQuestion` AS `question`
INNER JOIN `KnowledgeSubject` AS `subject`
    ON BINARY `subject`.`name` = BINARY `question`.`subject`
SET `question`.`subjectId` = `subject`.`id`;

UPDATE `QuizPaper` AS `paper`
INNER JOIN `KnowledgeSubject` AS `subject`
    ON BINARY `subject`.`name` = BINARY `paper`.`subject`
SET `paper`.`subjectId` = `subject`.`id`;

INSERT INTO `SubjectChapter` (
    `id`,
    `subjectId`,
    `name`,
    `slug`,
    `sortOrder`,
    `active`,
    `createdAt`,
    `updatedAt`
)
SELECT
    CONCAT('chapter-', LEFT(SHA2(CONCAT('quiz-chapter:', `legacy`.`subjectId`, ':', `legacy`.`name`), 256), 32)),
    `legacy`.`subjectId`,
    `legacy`.`name`,
    CONCAT('legacy-', LEFT(SHA2(CONCAT('quiz-chapter-slug:', `legacy`.`subjectId`, ':', `legacy`.`name`), 256), 48)),
    1000,
    true,
    CURRENT_TIMESTAMP(3),
    CURRENT_TIMESTAMP(3)
FROM (
    SELECT DISTINCT `subjectId`, `chapter` AS `name`
    FROM `QuizQuestion`
) AS `legacy`;

INSERT INTO `QuizQuestionChapter` (`questionId`, `chapterId`, `createdAt`)
SELECT `question`.`id`, `chapter`.`id`, CURRENT_TIMESTAMP(3)
FROM `QuizQuestion` AS `question`
INNER JOIN `SubjectChapter` AS `chapter`
    ON `chapter`.`subjectId` = `question`.`subjectId`
   AND BINARY `chapter`.`name` = BINARY `question`.`chapter`;

-- CreateIndex
CREATE INDEX `QuizPaper_subjectId_year_createdAt_idx` ON `QuizPaper`(`subjectId`, `year`, `createdAt`);

-- CreateIndex
CREATE INDEX `QuizQuestion_subjectId_difficulty_category_origin_enabled_idx` ON `QuizQuestion`(`subjectId`, `difficulty`, `category`, `origin`, `enabled`);

-- CreateIndex
CREATE INDEX `QuizQuestion_enabled_subjectId_typeLabel_difficulty_idx` ON `QuizQuestion`(`enabled`, `subjectId`, `typeLabel`, `difficulty`);

-- AddForeignKey
ALTER TABLE `SubjectChapter` ADD CONSTRAINT `SubjectChapter_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizQuestion` ADD CONSTRAINT `QuizQuestion_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizPaper` ADD CONSTRAINT `QuizPaper_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizQuestionChapter` ADD CONSTRAINT `QuizQuestionChapter_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `QuizQuestion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizQuestionChapter` ADD CONSTRAINT `QuizQuestionChapter_chapterId_fkey` FOREIGN KEY (`chapterId`) REFERENCES `SubjectChapter`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
