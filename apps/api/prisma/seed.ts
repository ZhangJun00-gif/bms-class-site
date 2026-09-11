import { hash } from '@node-rs/argon2';
import { PrismaClient, Prisma, Role, AccountStatus } from '@prisma/client';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

function studentHash(value: string) {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

function encryptStudentNumber(value: string) {
  const configured = process.env.STUDENT_DATA_KEY;
  const key = Buffer.from(configured ?? '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== configured) {
    throw new Error('STUDENT_DATA_KEY must be a canonical 32-byte Base64 key');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

async function main() {
  if (process.env.ALLOW_INITIAL_ADMIN_SEED !== 'true') {
    throw new Error('Explicit empty-database bootstrap is required');
  }
  const studentNumber = process.env.INITIAL_ADMIN_STUDENT_NUMBER?.trim();
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  const displayName = process.env.INITIAL_ADMIN_NAME?.trim();
  if (!studentNumber || studentNumber.length < 2 || studentNumber.length > 40 ||
      !displayName || displayName.length < 2 || displayName.length > 80 ||
      !password || password.length < 16 || password.length > 128 ||
      !/[A-Za-z]/.test(password) || !/\d/.test(password) ||
      /change-this|replace-with|password123/i.test(password)) {
    throw new Error('Provide a name, login identifier and unique strong bootstrap password');
  }
  const studentNumberEncrypted = encryptStudentNumber(studentNumber);
  const passwordHash = await hash(password);
  await prisma.$transaction(async (tx) => {
    if (await tx.user.count() !== 0) {
      throw new Error('Refusing to bootstrap a non-empty User table');
    }
    await tx.user.create({ data: {
      displayName,
      studentNumberHash: studentHash(studentNumber),
      studentNumberEncrypted,
      passwordHash,
      role: Role.ADMIN,
      status: AccountStatus.ACTIVE,
      approvedAt: new Date(),
    } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  console.log('Initial administrator is ready. Change the bootstrap password immediately.');
}

main().catch(() => {
  console.error('Bootstrap failed: verify explicit authorization, empty database and configuration.');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
