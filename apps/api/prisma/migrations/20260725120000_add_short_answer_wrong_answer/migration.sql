-- Only short-answer wrong questions retain the user's latest wrong answer.
ALTER TABLE `QuizWrongQuestion`
    ADD COLUMN `lastWrongAnswer` TEXT NULL AFTER `lastScore`;

-- Backfill the latest available short-answer response from retained attempts.
-- Objective answers remain NULL and are never copied into the materialized row.
UPDATE `QuizWrongQuestion` AS `wrong`
INNER JOIN (
    SELECT
        `ranked`.`userId`,
        `ranked`.`questionId`,
        `ranked`.`wrongAnswer`
    FROM (
        SELECT
            `attempt`.`userId`,
            `resultRow`.`questionId`,
            JSON_UNQUOTE(
                JSON_EXTRACT(
                    `attempt`.`answers`,
                    CONCAT('$."', `resultRow`.`questionId`, '"[0]')
                )
            ) AS `wrongAnswer`,
            ROW_NUMBER() OVER (
                PARTITION BY `attempt`.`userId`, `resultRow`.`questionId`
                ORDER BY `attempt`.`submittedAt` DESC, `attempt`.`id` DESC
            ) AS `recency`
        FROM `QuizAttempt` AS `attempt`
        JOIN JSON_TABLE(
            `attempt`.`results`,
            '$[*]' COLUMNS (
                `questionId` VARCHAR(191) PATH '$.questionId',
                `correct` BOOLEAN PATH '$.correct'
            )
        ) AS `resultRow` ON `resultRow`.`correct` = false
        JOIN JSON_TABLE(
            CASE
                WHEN JSON_TYPE(`attempt`.`snapshot`) = 'ARRAY' THEN `attempt`.`snapshot`
                ELSE JSON_EXTRACT(`attempt`.`snapshot`, '$.questions')
            END,
            '$[*]' COLUMNS (
                `questionId` VARCHAR(191) PATH '$.id',
                `type` VARCHAR(32) PATH '$.type'
            )
        ) AS `questionRow`
            ON `questionRow`.`questionId` COLLATE utf8mb4_unicode_ci =
               `resultRow`.`questionId` COLLATE utf8mb4_unicode_ci
        WHERE `attempt`.`submittedAt` IS NOT NULL
          AND `attempt`.`answers` IS NOT NULL
          AND `attempt`.`results` IS NOT NULL
          AND `questionRow`.`type` = 'SHORT_ANSWER'
    ) AS `ranked`
    WHERE `ranked`.`recency` = 1
) AS `latest`
    ON `latest`.`userId` = `wrong`.`userId`
   AND `latest`.`questionId` COLLATE utf8mb4_unicode_ci =
       `wrong`.`questionId` COLLATE utf8mb4_unicode_ci
SET `wrong`.`lastWrongAnswer` = `latest`.`wrongAnswer`
WHERE `wrong`.`type` = 'SHORT_ANSWER';
