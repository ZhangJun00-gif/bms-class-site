import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationUrl = new URL(
  '../../apps/api/prisma/migrations/20260806040000_add_daily_practice_cycle_refreeze/migration.sql',
  import.meta.url,
);

test('cycle refreeze migration adds nullable request markers without rewriting existing rows', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /ALTER TABLE `DailyPracticeCycle`/);
  assert.match(sql, /`refreezeRequestedAt` DATETIME\(3\) NULL/);
  assert.match(sql, /`refreezeRequestedById` VARCHAR\(191\) NULL/);
  assert.doesNotMatch(sql, /NOT NULL/);
});
