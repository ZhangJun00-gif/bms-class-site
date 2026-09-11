import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const schemaUrl = new URL(
  '../../apps/api/prisma/schema.prisma',
  import.meta.url,
);
const migrationUrl = new URL(
  '../../apps/api/prisma/migrations/20260810090000_add_p2_lifecycle_safety/migration.sql',
  import.meta.url,
);

test('P2 lifecycle migration preserves old rows and adds fenced leases', async () => {
  const [schema, migration] = await Promise.all([
    readFile(schemaUrl, 'utf8'),
    readFile(migrationUrl, 'utf8'),
  ]);

  for (const model of [
    'IndexJob',
    'KnowledgeImportJob',
    'QuizImportJob',
    'AiQuestionGenerationJob',
  ]) {
    const block = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(block, `${model} schema block`);
    assert.match(block, /leaseOwnerToken\s+String\?/);
    assert.match(block, /@@index\(\[leaseOwnerToken, leasedUntil\]\)/);
  }

  assert.match(
    migration,
    /ADD COLUMN `requestHash` CHAR\(64\) NULL/,
    'legacy AI jobs must remain readable without a synthesized request hash',
  );
  assert.match(
    migration,
    /ADD COLUMN `lifecycleStatus` ENUM\([^)]+\) NULL/,
    'legacy unsubmitted attempts must not be silently enrolled as drafts',
  );
  assert.doesNotMatch(
    migration,
    /UPDATE\s+`?QuizAttempt`?/i,
    'the migration must not rewrite historical attempt rows',
  );
  assert.match(
    migration,
    /INSERT INTO `QuizCapacityCounter`[\s\S]*SELECT 1, COUNT\(\*\), 0, CURRENT_TIMESTAMP\(3\) FROM `QuizQuestion`/,
  );
  assert.match(
    migration,
    /ENUM\('RETAINED', 'PENDING', 'IN_PROGRESS', 'CLEANED', 'FAILED'\)/,
  );
  assert.match(migration, /KnowledgeImport_cleanup_due_idx/);
  assert.match(migration, /QuizImport_cleanup_due_idx/);
});
