/*
  Warnings:

  - Made the column `subjectId` on table `QuizPaper` required. This step will fail if there are existing NULL values in that column.
  - Made the column `subjectId` on table `QuizQuestion` required. This step will fail if there are existing NULL values in that column.

*/
-- Refuse to enforce the final contract unless the exact backfill is complete.
CREATE TEMPORARY TABLE `_Phase1ConstraintGuard` (
    `checkName` VARCHAR(100) NOT NULL,
    PRIMARY KEY (`checkName`)
);

INSERT INTO `_Phase1ConstraintGuard` (`checkName`) VALUES ('questions-have-subjects');
INSERT INTO `_Phase1ConstraintGuard` (`checkName`)
SELECT 'questions-have-subjects'
WHERE EXISTS (SELECT 1 FROM `QuizQuestion` WHERE `subjectId` IS NULL);

INSERT INTO `_Phase1ConstraintGuard` (`checkName`) VALUES ('papers-have-subjects');
INSERT INTO `_Phase1ConstraintGuard` (`checkName`)
SELECT 'papers-have-subjects'
WHERE EXISTS (SELECT 1 FROM `QuizPaper` WHERE `subjectId` IS NULL);

INSERT INTO `_Phase1ConstraintGuard` (`checkName`) VALUES ('questions-have-chapters');
INSERT INTO `_Phase1ConstraintGuard` (`checkName`)
SELECT 'questions-have-chapters'
WHERE EXISTS (
    SELECT 1
    FROM `QuizQuestion` AS `question`
    LEFT JOIN `QuizQuestionChapter` AS `link` ON `link`.`questionId` = `question`.`id`
    WHERE `link`.`questionId` IS NULL
);

INSERT INTO `_Phase1ConstraintGuard` (`checkName`) VALUES ('question-chapters-match');
INSERT INTO `_Phase1ConstraintGuard` (`checkName`)
SELECT 'question-chapters-match'
WHERE EXISTS (
    SELECT 1
    FROM `QuizQuestionChapter` AS `link`
    INNER JOIN `QuizQuestion` AS `question` ON `question`.`id` = `link`.`questionId`
    INNER JOIN `SubjectChapter` AS `chapter` ON `chapter`.`id` = `link`.`chapterId`
    WHERE `question`.`subjectId` <> `chapter`.`subjectId`
);

INSERT INTO `_Phase1ConstraintGuard` (`checkName`) VALUES ('paper-questions-match');
INSERT INTO `_Phase1ConstraintGuard` (`checkName`)
SELECT 'paper-questions-match'
WHERE EXISTS (
    SELECT 1
    FROM `QuizQuestion` AS `question`
    INNER JOIN `QuizPaper` AS `paper` ON `paper`.`id` = `question`.`pastPaperId`
    WHERE `question`.`subjectId` <> `paper`.`subjectId`
);

DROP TEMPORARY TABLE `_Phase1ConstraintGuard`;

-- DropForeignKey
ALTER TABLE `QuizPaper` DROP FOREIGN KEY `QuizPaper_subjectId_fkey`;

-- DropForeignKey
ALTER TABLE `QuizQuestion` DROP FOREIGN KEY `QuizQuestion_subjectId_fkey`;

-- AlterTable
ALTER TABLE `QuizPaper` MODIFY `subjectId` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `QuizQuestion` MODIFY `subjectId` VARCHAR(191) NOT NULL;

-- AddForeignKey
ALTER TABLE `QuizQuestion` ADD CONSTRAINT `QuizQuestion_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizPaper` ADD CONSTRAINT `QuizPaper_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
