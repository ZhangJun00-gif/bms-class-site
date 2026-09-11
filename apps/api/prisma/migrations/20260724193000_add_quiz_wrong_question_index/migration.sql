-- Keep one materialized wrong-question record per user and question. This
-- replaces request-time scans of every historical attempt while retaining the
-- original attempts for score history and duplicate-submit protection.
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `QuizWrongQuestion` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `questionId` VARCHAR(191) NOT NULL,
    `type` ENUM('SINGLE', 'MULTIPLE', 'TRUE_FALSE', 'SHORT_ANSWER') NOT NULL,
    `typeLabel` VARCHAR(100) NOT NULL,
    `subjectId` VARCHAR(191) NOT NULL,
    `category` ENUM('STANDARD', 'KNOWLEDGE_RECALL') NOT NULL,
    `origin` ENUM('MANUAL', 'CSV', 'AI_GENERATED') NOT NULL,
    `prompt` TEXT NOT NULL,
    `crossChapter` BOOLEAN NOT NULL DEFAULT false,
    `isPastPaper` BOOLEAN NOT NULL DEFAULT false,
    `snapshot` JSON NOT NULL,
    `wrongCount` INTEGER NOT NULL DEFAULT 1,
    `lastScore` INTEGER NULL,
    `lastFeedback` TEXT NULL,
    `lastCriterionScores` JSON NULL,
    `lastWrongAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `QuizWrongQuestion_userId_questionId_key`(`userId`, `questionId`),
    INDEX `QuizWrongQuestion_userId_lastWrongAt_idx`(`userId`, `lastWrongAt`),
    INDEX `QuizWrongQuestion_userId_subjectId_typeLabel_idx`(`userId`, `subjectId`, `typeLabel`),
    INDEX `QuizWrongQuestion_userId_origin_lastWrongAt_idx`(`userId`, `origin`, `lastWrongAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `QuizWrongQuestionChapter` (
    `wrongQuestionId` VARCHAR(191) NOT NULL,
    `chapterId` VARCHAR(191) NOT NULL,

    INDEX `QuizWrongQuestionChapter_chapterId_wrongQuestionId_idx`(`chapterId`, `wrongQuestionId`),
    PRIMARY KEY (`wrongQuestionId`, `chapterId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `QuizWrongQuestion`
    ADD CONSTRAINT `QuizWrongQuestion_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `QuizWrongQuestionChapter`
    ADD CONSTRAINT `QuizWrongQuestionChapter_wrongQuestionId_fkey`
    FOREIGN KEY (`wrongQuestionId`) REFERENCES `QuizWrongQuestion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing wrong answers once during migration. Window functions keep
-- the newest snapshot/result while COUNT(*) preserves the complete wrong count.
INSERT INTO `QuizWrongQuestion` (
    `id`, `userId`, `questionId`, `type`, `typeLabel`, `subjectId`,
    `category`, `origin`, `prompt`, `crossChapter`, `isPastPaper`,
    `snapshot`, `wrongCount`, `lastScore`, `lastFeedback`,
    `lastCriterionScores`, `lastWrongAt`, `createdAt`, `updatedAt`
)
WITH extracted AS (
    SELECT
        attempt.`id` AS attemptId,
        attempt.`userId`,
        attempt.`submittedAt`,
        resultRow.`questionId`,
        resultRow.`score`,
        resultRow.`feedback`,
        resultRow.`criterionScores`,
        questionRow.`question` AS snapshot,
        ROW_NUMBER() OVER (
            PARTITION BY attempt.`userId`, resultRow.`questionId`
            ORDER BY attempt.`submittedAt` DESC, attempt.`id` DESC
        ) AS recency,
        COUNT(*) OVER (
            PARTITION BY attempt.`userId`, resultRow.`questionId`
        ) AS wrongCount
    FROM `QuizAttempt` AS attempt
    JOIN JSON_TABLE(
        attempt.`results`,
        '$[*]' COLUMNS (
            `questionId` VARCHAR(191) PATH '$.questionId',
            `correct` BOOLEAN PATH '$.correct',
            `score` INTEGER PATH '$.score' NULL ON EMPTY,
            `feedback` TEXT PATH '$.feedback' NULL ON EMPTY,
            `criterionScores` JSON PATH '$.criterionScores' NULL ON EMPTY
        )
    ) AS resultRow ON resultRow.`correct` = false
    JOIN JSON_TABLE(
        CASE
            WHEN JSON_TYPE(attempt.`snapshot`) = 'ARRAY' THEN attempt.`snapshot`
            ELSE JSON_EXTRACT(attempt.`snapshot`, '$.questions')
        END,
        '$[*]' COLUMNS (
            `questionId` VARCHAR(191) PATH '$.id',
            `question` JSON PATH '$'
        )
    ) AS questionRow ON questionRow.`questionId` COLLATE utf8mb4_unicode_ci = resultRow.`questionId` COLLATE utf8mb4_unicode_ci
    WHERE attempt.`submittedAt` IS NOT NULL
      AND attempt.`results` IS NOT NULL
), latest AS (
    SELECT * FROM extracted WHERE recency = 1
)
SELECT
    CONCAT('backfill_', LEFT(SHA2(CONCAT(latest.`userId`, CHAR(0), latest.`questionId`), 256), 48)),
    latest.`userId`,
    latest.`questionId`,
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(latest.`snapshot`, '$.type')), question.`type`),
    COALESCE(
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(latest.`snapshot`, '$.typeLabel')), ''),
        question.`typeLabel`,
        JSON_UNQUOTE(JSON_EXTRACT(latest.`snapshot`, '$.type'))
    ),
    COALESCE(
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(latest.`snapshot`, '$.subject.id')), ''),
        question.`subjectId`
    ),
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(latest.`snapshot`, '$.category')), question.`category`, 'STANDARD'),
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(latest.`snapshot`, '$.origin')), question.`origin`, 'MANUAL'),
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(latest.`snapshot`, '$.prompt')), question.`prompt`),
    COALESCE(
        JSON_LENGTH(JSON_EXTRACT(latest.`snapshot`, '$.chapters')) > 1,
        (SELECT COUNT(*) FROM `QuizQuestionChapter` AS link WHERE link.`questionId` = latest.`questionId` COLLATE utf8mb4_unicode_ci) > 1,
        false
    ),
    COALESCE(JSON_TYPE(JSON_EXTRACT(latest.`snapshot`, '$.pastPaper')) = 'OBJECT', question.`pastPaperId` IS NOT NULL),
    latest.`snapshot`,
    latest.`wrongCount`,
    latest.`score`,
    latest.`feedback`,
    latest.`criterionScores`,
    latest.`submittedAt`,
    latest.`submittedAt`,
    latest.`submittedAt`
FROM latest
LEFT JOIN `QuizQuestion` AS question ON question.`id` = latest.`questionId` COLLATE utf8mb4_unicode_ci
WHERE COALESCE(
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(latest.`snapshot`, '$.subject.id')), ''),
        question.`subjectId`
      ) IS NOT NULL;

-- Prefer chapter ids captured by v2 snapshots; legacy snapshots fall back to
-- the question's current normalized chapter links.
INSERT IGNORE INTO `QuizWrongQuestionChapter` (`wrongQuestionId`, `chapterId`)
SELECT wrong.`id`, snapshotChapter.`chapterId`
FROM `QuizWrongQuestion` AS wrong
JOIN JSON_TABLE(
    JSON_EXTRACT(wrong.`snapshot`, '$.chapters'),
    '$[*]' COLUMNS (`chapterId` VARCHAR(191) PATH '$.id')
) AS snapshotChapter
WHERE snapshotChapter.`chapterId` IS NOT NULL;

INSERT IGNORE INTO `QuizWrongQuestionChapter` (`wrongQuestionId`, `chapterId`)
SELECT wrong.`id`, link.`chapterId`
FROM `QuizWrongQuestion` AS wrong
JOIN `QuizQuestionChapter` AS link ON link.`questionId` = wrong.`questionId`
WHERE NOT EXISTS (
    SELECT 1
    FROM `QuizWrongQuestionChapter` AS existing
    WHERE existing.`wrongQuestionId` = wrong.`id`
);
