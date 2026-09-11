import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migrationRoot = new URL(
  "../../apps/api/prisma/migrations/",
  import.meta.url,
);

async function migration(name) {
  return readFile(new URL(`${name}/migration.sql`, migrationRoot), "utf8");
}

test("phase one taxonomy migration uses exact guarded backfill", async () => {
  const source = await migration("20260724090954_add_unified_subject_chapters");

  for (const guard of [
    "legacy-labels-valid",
    "paper-subjects-match",
    "subject-labels-unambiguous",
    "chapter-labels-unambiguous",
  ]) {
    assert.match(source, new RegExp(guard));
  }
  assert.match(source, /BINARY `subject`\.`name` = BINARY `legacy`\.`name`/);
  assert.match(source, /PRIMARY KEY \(`questionId`, `chapterId`\)/);
  assert.match(source, /ON DELETE RESTRICT/);
  assert.doesNotMatch(source, /LEVENSHTEIN|SOUNDEX|db push/i);
});

test("phase one constraint migration verifies invariants before non-null fields", async () => {
  const source = await migration(
    "20260724091540_enforce_unified_quiz_taxonomy",
  );
  const guardPosition = source.indexOf("questions-have-chapters");
  const nonNullPosition = source.indexOf(
    "MODIFY `subjectId` VARCHAR(191) NOT NULL",
  );

  assert.ok(guardPosition >= 0);
  assert.ok(nonNullPosition > guardPosition);
  for (const guard of [
    "questions-have-subjects",
    "papers-have-subjects",
    "questions-have-chapters",
    "question-chapters-match",
    "paper-questions-match",
  ]) {
    assert.match(source, new RegExp(guard));
  }
});

test("difficulty removal replaces foreign-key-supporting indexes before dropping the column", async () => {
  const source = await migration(
    "20260724150000_remove_quiz_question_difficulty",
  );
  const replacementPosition = source.indexOf(
    "CREATE INDEX `QuizQuestion_subjectId_category_origin_enabled_idx`",
  );
  const oldIndexDropPosition = source.indexOf(
    "DROP INDEX `QuizQuestion_subjectId_difficulty_category_origin_enabled_idx`",
  );
  const columnDropPosition = source.indexOf(
    "ALTER TABLE `QuizQuestion` DROP COLUMN `difficulty`",
  );

  assert.ok(replacementPosition >= 0);
  assert.ok(oldIndexDropPosition > replacementPosition);
  assert.ok(columnDropPosition > oldIndexDropPosition);
});

test("wrong-question index migration materializes counts and latest feedback", async () => {
  const source = await migration(
    "20260724193000_add_quiz_wrong_question_index",
  );

  assert.match(source, /CREATE TABLE `QuizWrongQuestion`/);
  assert.match(
    source,
    /UNIQUE INDEX `QuizWrongQuestion_userId_questionId_key`/,
  );
  assert.match(source, /CREATE TABLE `QuizWrongQuestionChapter`/);
  assert.match(source, /COUNT\(\*\) OVER/);
  assert.match(source, /ROW_NUMBER\(\) OVER/);
  assert.match(source, /JSON_TABLE/);
  assert.match(source, /`lastFeedback` TEXT NULL/);
  assert.match(source, /ON DELETE CASCADE/);
  assert.doesNotMatch(
    source,
    /DROP TABLE `QuizAttempt`|DELETE FROM `QuizAttempt`/,
  );
});

test("short-answer wrong-answer migration excludes objective answers", async () => {
  const source = await migration(
    "20260725120000_add_short_answer_wrong_answer",
  );

  assert.match(source, /ADD COLUMN `lastWrongAnswer` TEXT NULL/);
  assert.match(source, /JSON_EXTRACT\(\s*`attempt`\.`answers`/);
  assert.match(source, /ROW_NUMBER\(\) OVER/);
  assert.match(source, /`questionRow`\.`type` = 'SHORT_ANSWER'/);
  assert.match(source, /`wrong`\.`type` = 'SHORT_ANSWER'/);
  assert.doesNotMatch(source, /DROP TABLE|DELETE FROM|TRUNCATE|db push/i);
});

test("phase two quiz import migration is additive and task-scoped", async () => {
  const source = await migration("20260725090000_add_quiz_import_jobs");

  for (const table of ["QuizImportJob", "QuizImportIssue", "QuizImportAsset"]) {
    assert.ok(source.includes(`CREATE TABLE \`${table}\``));
  }
  assert.match(
    source,
    /UNIQUE INDEX `QuizQuestion_importJobId_importRowNumber_key`/,
  );
  assert.match(source, /ON DELETE SET NULL/);
  assert.match(source, /ON DELETE CASCADE/);
  assert.doesNotMatch(source, /DROP TABLE|DELETE FROM|TRUNCATE|db push/i);
});
