UPDATE `KnowledgeSubject`
SET
  `name` = '人体形态与功能总论',
  `updatedAt` = CURRENT_TIMESTAMP(3)
WHERE
  `id` = 'knowledge-subject-human-01'
  AND `name` = '人体形态与功能功能总论';
