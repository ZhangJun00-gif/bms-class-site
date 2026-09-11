import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationUrl = new URL(
  '../../apps/api/prisma/migrations/20260728130000_add_phase6_daily_practice/migration.sql',
  import.meta.url,
);

async function loadMigration() {
  return readFile(migrationUrl, 'utf8');
}

test('phase six migration creates the complete daily-practice data model', async () => {
  const sql = await loadMigration();
  const tables = [
    'DailyPracticeSettings',
    'DailyPracticeServicePause',
    'TeachingProgress',
    'TeachingProgressNode',
    'DailyPracticeFixedAssignment',
    'DailyPracticeFixedQuestion',
    'UserPracticeProfile',
    'UserKnowledgeState',
    'UserChapterState',
    'DailyPracticeCycle',
    'DailyPracticeDay',
    'DailyPracticePlanRevision',
    'DailyPracticePlanItem',
    'DailyPracticeSuggestion',
    'DailyPracticeStrategyAttempt',
  ];

  for (const table of tables) {
    assert.match(sql, new RegExp('CREATE TABLE `' + table + '`'), table);
  }

  assert.match(sql, /`enabled` BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /INSERT INTO `DailyPracticeSettings`[\s\S]+1, false, 0/);
  assert.match(sql, /DailyPracticeDay_activeRevisionId_fkey/);
  assert.match(sql, /DailyPracticePlanRevision_previousSummarySourceRevisionId_fkey/);
  assert.match(sql, /DailyStrategyAttempt_day_revision_strategy_key/);
  assert.match(sql, /DailyPracticeSuggestion_userQuotaKey_key/);
  assert.match(sql, /DailyPracticeFixedQuestion_questionId_assignmentId_idx/);
});

test('phase six migration adds resumable leases, idempotency, and indexed replay without rewriting existing rows', async () => {
  const sql = await loadMigration();

  assert.match(sql, /ALTER TABLE `AiInvocation`[\s\S]+`usageDate` DATE NULL/);
  assert.match(sql, /`usageScope` VARCHAR\(100\) NULL/);
  assert.match(sql, /`idempotencyKey` VARCHAR\(191\) NULL/);
  assert.match(sql, /AiInvocation_idempotencyKey_key/);
  assert.match(sql, /ALTER TABLE `QuizQuestionKnowledgeSource`[\s\S]+`nodePathHash` CHAR\(64\) NULL/);
  assert.match(sql, /QuizQSource_document_path_current_idx/);
  assert.match(sql, /`knowledgeStateAppliedAt` DATETIME\(3\) NULL/);
  assert.match(sql, /`knowledgeStateRevision` INTEGER NULL/);
  assert.match(sql, /`dailyPracticePlanRevisionId` VARCHAR\(191\) NULL/);
  assert.match(sql, /QuizAttempt_userId_submittedAt_id_idx/);
  assert.match(sql, /QuizAttempt_knowledgeStateAppliedAt_submittedAt_id_idx/);

  for (const table of [
    'UserPracticeProfile',
    'DailyPracticeCycle',
    'DailyPracticeDay',
  ]) {
    const definition = sql.match(
      new RegExp(
        'CREATE TABLE `' + table + '` \\(([\\s\\S]+?)\\n\\) DEFAULT',
      ),
    )?.[1];
    assert.ok(definition, table);
    assert.match(definition, /`leaseOwnerToken` VARCHAR\(191\) NULL/);
    assert.match(definition, /`leasedUntil` DATETIME\(3\) NULL/);
  }

  assert.ok(
    sql.indexOf('CREATE TABLE `DailyPracticePlanRevision`') <
      sql.indexOf('DailyPracticeDay_activeRevisionId_fkey'),
    'the cyclic active-revision foreign key must be added after both tables',
  );
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN|INDEX|FOREIGN\s+KEY)\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\s+`(?:User|QuizAttempt|QuizQuestion|Knowledge)/i);
});
