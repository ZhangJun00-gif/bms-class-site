import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationUrl = new URL(
  '../../apps/api/prisma/migrations/20260728090000_add_phase5_ai_question_generation/migration.sql',
  import.meta.url,
);

test('phase five AI question migration is additive and preserves existing visibility', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /`reviewRevision` INTEGER NOT NULL DEFAULT 1/);
  assert.match(sql, /`sourceRevision` INTEGER NOT NULL DEFAULT 1/);
  assert.match(
    sql,
    /`sourceReviewStatus` ENUM\('NOT_APPLICABLE', 'VALID', 'REVIEW_REQUIRED'\) NOT NULL DEFAULT 'NOT_APPLICABLE'/,
  );
  assert.match(sql, /CREATE TABLE `AiInvocation`/);
  assert.match(sql, /'PRO_MAX'/);
  assert.match(sql, /CREATE TABLE `AiQuestionGenerationJob`/);
  assert.match(sql, /AiQuestionGenerationJob_createdById_idempotencyKey_key/);
  assert.match(sql, /CREATE TABLE `QuizQuestionKnowledgeSource`/);
  assert.match(sql, /`evidenceContent` LONGTEXT NOT NULL/);
  assert.match(
    sql,
    /AiQuestionGenerationSource_knowledgeNodeId_fkey[^;]+ON DELETE SET NULL/,
  );
  assert.match(
    sql,
    /QuizQuestionKnowledgeSource_knowledgeNodeId_fkey[^;]+ON DELETE SET NULL/,
  );
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\s+`?QuizQuestion`?\b/i);
});
