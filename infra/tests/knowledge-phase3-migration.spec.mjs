import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationUrl = new URL(
  '../../apps/api/prisma/migrations/20260725160000_add_markdown_vector_knowledge_libraries/migration.sql',
  import.meta.url,
);
const renderMigrationUrl = new URL(
  '../../apps/api/prisma/migrations/20260726150000_add_knowledge_render_blocks/migration.sql',
  import.meta.url,
);

test('phase three migration backfills legacy knowledge before enforcing ownership', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const nullable = sql.indexOf('ADD COLUMN `libraryId` VARCHAR(191) NULL');
  const libraries = sql.indexOf('INSERT INTO `KnowledgeLibrary`');
  const backfill = sql.indexOf('UPDATE `KnowledgeDocument` AS document');
  const required = sql.indexOf('MODIFY `libraryId` VARCHAR(191) NOT NULL');

  assert.ok(nullable >= 0);
  assert.ok(libraries > nullable);
  assert.ok(backfill > libraries);
  assert.ok(required > backfill);
  assert.match(sql, /KnowledgeLibrary_scope_owner_check/);
  assert.match(
    sql,
    /KnowledgeLibrary_ownerId_fkey[^;]+ON DELETE RESTRICT ON UPDATE RESTRICT/,
    'MySQL 8.4 forbids cascading updates on the owner column used by the scope check',
  );
  assert.match(sql, /INSERT INTO `KnowledgeCapacityCounter`/);
  assert.match(
    sql,
    /\(SELECT COUNT\(\*\) FROM `KnowledgeChunk`\)/,
    'legacy shared chunks must seed the global capacity cache',
  );
  assert.match(sql, /ADD CONSTRAINT `KnowledgeChunk_documentId_fkey`/);
  assert.doesNotMatch(
    sql,
    /ADD CONSTRAINT `KnowledgeSubject_createdById_fkey`/,
    'the already deployed subject foreign key must not be added twice',
  );
});

test('render-block migration leaves existing knowledge content untouched and pending backfill', async () => {
  const sql = await readFile(renderMigrationUrl, 'utf8');

  assert.match(
    sql,
    /`renderStatus` ENUM\('PENDING', 'READY', 'FAILED'\) NOT NULL DEFAULT 'PENDING'/,
  );
  assert.match(sql, /CREATE TABLE `KnowledgeRenderBlock`/);
  assert.match(
    sql,
    /UNIQUE INDEX `KnowledgeRenderBlock_documentVersionId_nodeId_blockIndex_key`/,
  );
  assert.match(sql, /ADD COLUMN `renderBlockId` VARCHAR\(191\) NULL/);
  assert.match(sql, /ON DELETE SET NULL ON UPDATE CASCADE/);
  assert.doesNotMatch(sql, /UPDATE `KnowledgeDocumentVersion`/);
  assert.doesNotMatch(sql, /UPDATE `KnowledgeNode`/);
  assert.doesNotMatch(sql, /UPDATE `KnowledgeChunk`/);
  assert.doesNotMatch(sql, /UPDATE `KnowledgeImageReference`/);
});
