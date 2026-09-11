import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const seed = readFileSync(fileURLToPath(new URL('../../apps/api/prisma/seed.ts', import.meta.url)), 'utf8');
const javascript = ts.transpileModule(seed, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function runSeed(env, existingUsers) {
  const created = [];
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const process = { env, exitCode: 0 };
  class PrismaClient {
    async $transaction(task, options) {
      assert.equal(options.isolationLevel, 'Serializable');
      return task({ user: { count: async () => existingUsers, create: async ({ data }) => { created.push(data); } } });
    }
    async $disconnect() { finish(); }
  }
  runInNewContext(javascript, {
    exports: {}, Buffer, process,
    console: { log() {}, error() {} },
    require(name) {
      if (name === '@prisma/client') return { PrismaClient, Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } }, Role: { ADMIN: 'ADMIN' }, AccountStatus: { ACTIVE: 'ACTIVE' } };
      if (name === '@node-rs/argon2') return { hash: async () => 'synthetic-password-hash' };
      return require(name);
    },
  });
  await done;
  return { created, exitCode: process.exitCode };
}

const valid = {
  ALLOW_INITIAL_ADMIN_SEED: 'true',
  INITIAL_ADMIN_NAME: 'Test Administrator',
  INITIAL_ADMIN_STUDENT_NUMBER: 'synthetic-admin',
  INITIAL_ADMIN_PASSWORD: 'SyntheticBootstrap42!',
  STUDENT_DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
};

test('bootstrap never creates users without explicit opt-in or strong configured credentials', async () => {
  for (const env of [{}, { ...valid, ALLOW_INITIAL_ADMIN_SEED: 'false' }, { ...valid, INITIAL_ADMIN_PASSWORD: 'change-this-password' }, { ...valid, STUDENT_DATA_KEY: '' }]) {
    const result = await runSeed(env, 0);
    assert.equal(result.exitCode, 1);
    assert.equal(result.created.length, 0);
  }
});

test('bootstrap refuses an existing user table', async () => {
  const result = await runSeed(valid, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(result.created.length, 0);
});

test('empty bootstrap writes one encrypted administrator record', async () => {
  const result = await runSeed(valid, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].role, 'ADMIN');
  assert.equal(result.created[0].status, 'ACTIVE');
  assert.notEqual(result.created[0].studentNumberEncrypted, valid.INITIAL_ADMIN_STUDENT_NUMBER);
  assert.equal(result.created[0].passwordHash, 'synthetic-password-hash');
});
