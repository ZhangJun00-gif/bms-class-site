import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const schemaUrl = new URL(
  '../../apps/api/prisma/schema.prisma',
  import.meta.url,
);
const migrationUrl = new URL(
  '../../apps/api/prisma/migrations/20260811140000_add_lifecycle_optimizations/migration.sql',
  import.meta.url,
);

test('lifecycle optimization migration is additive and preserves durable records', async () => {
  const [schema, migration] = await Promise.all([
    readFile(schemaUrl, 'utf8'),
    readFile(migrationUrl, 'utf8'),
  ]);

  assert.match(schema, /model Album \{[\s\S]*archivedAt\s+DateTime\?/);
  assert.match(schema, /model Invite \{[\s\S]*revokedAt\s+DateTime\?/);
  assert.match(migration, /ADD COLUMN `archivedAt` DATETIME\(3\) NULL/);
  assert.match(migration, /ADD COLUMN `revokedAt` DATETIME\(3\) NULL/);
  assert.doesNotMatch(migration, /\bUPDATE\b/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);

  for (const index of [
    'Session_expires_id_idx',
    'Invite_active_expires_created_idx',
    'AuditLog_created_id_idx',
    'AuditLog_actor_created_id_idx',
    'AuditLog_action_created_id_idx',
    'AuditLog_target_created_id_idx',
    'Album_archived_created_id_idx',
    'Photo_album_sort_created_id_idx',
    'QuizAttempt_lifecycle_expiry_id_idx',
    'QuizAttempt_lifecycle_abandoned_id_idx',
    'AiConversation_user_updated_id_idx',
    'AiMessage_conversation_created_id_idx',
  ]) {
    assert.match(migration, new RegExp('CREATE INDEX `' + index + '`'));
  }

  assert.doesNotMatch(
    migration,
    /(?:AuditLog|AiConversation|QuizAttempt)[\s\S]*DROP/i,
    'durable logs, conversations, and submitted attempts must not be removed',
  );
});
