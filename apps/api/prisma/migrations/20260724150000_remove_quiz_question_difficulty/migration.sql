-- Difficulty is no longer part of the question taxonomy or filtering contract.
-- Create replacement indexes first because MySQL may use the old subjectId-led
-- composite index to enforce the subject foreign key.
CREATE INDEX `QuizQuestion_subjectId_category_origin_enabled_idx`
    ON `QuizQuestion`(`subjectId`, `category`, `origin`, `enabled`);
CREATE INDEX `QuizQuestion_enabled_subjectId_typeLabel_idx`
    ON `QuizQuestion`(`enabled`, `subjectId`, `typeLabel`);

DROP INDEX `QuizQuestion_subjectId_difficulty_category_origin_enabled_idx` ON `QuizQuestion`;
DROP INDEX `QuizQuestion_enabled_subjectId_typeLabel_difficulty_idx` ON `QuizQuestion`;

ALTER TABLE `QuizQuestion` DROP COLUMN `difficulty`;
