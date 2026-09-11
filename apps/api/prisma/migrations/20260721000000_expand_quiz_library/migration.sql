ALTER TABLE `QuizQuestion`
  ADD COLUMN `typeLabel` VARCHAR(100) NULL,
  ADD COLUMN `pastPaperId` VARCHAR(191) NULL,
  ADD COLUMN `paperOrder` INTEGER NULL;

UPDATE `QuizQuestion`
SET `typeLabel` = CASE `type`
  WHEN 'SINGLE' THEN '单选题'
  WHEN 'MULTIPLE' THEN '多选题'
  WHEN 'TRUE_FALSE' THEN '判断题'
  WHEN 'SHORT_ANSWER' THEN '简答题'
  ELSE `type`
END
WHERE `typeLabel` IS NULL;

ALTER TABLE `QuizQuestion`
  MODIFY `typeLabel` VARCHAR(100) NOT NULL;

CREATE TABLE `QuizPaper` (
  `id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(160) NOT NULL,
  `subject` VARCHAR(100) NOT NULL,
  `year` INTEGER NULL,
  `authorId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `QuizPaper_subject_year_createdAt_idx`(`subject`, `year`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `QuizQuestionPhoto` (
  `questionId` VARCHAR(191) NOT NULL,
  `photoId` VARCHAR(191) NOT NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `QuizQuestionPhoto_photoId_idx`(`photoId`),
  PRIMARY KEY (`questionId`, `photoId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `QuizQuestion_enabled_subject_typeLabel_difficulty_idx`
  ON `QuizQuestion`(`enabled`, `subject`, `typeLabel`, `difficulty`);
CREATE UNIQUE INDEX `QuizQuestion_pastPaperId_paperOrder_key`
  ON `QuizQuestion`(`pastPaperId`, `paperOrder`);

ALTER TABLE `QuizQuestion`
  ADD CONSTRAINT `QuizQuestion_pastPaperId_fkey`
    FOREIGN KEY (`pastPaperId`) REFERENCES `QuizPaper`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `QuizPaper`
  ADD CONSTRAINT `QuizPaper_authorId_fkey`
    FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `QuizQuestionPhoto`
  ADD CONSTRAINT `QuizQuestionPhoto_questionId_fkey`
    FOREIGN KEY (`questionId`) REFERENCES `QuizQuestion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `QuizQuestionPhoto_photoId_fkey`
    FOREIGN KEY (`photoId`) REFERENCES `Photo`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
