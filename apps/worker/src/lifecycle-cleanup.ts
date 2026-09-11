import { Prisma, PrismaClient, QuizAttemptStatus } from '@prisma/client';
import {
  expireKnowledgeImports,
  processKnowledgeImportSourceCleanup,
} from './knowledge-import';
import {
  expireQuizImports,
  processQuizImportSourceCleanup,
} from './quiz-import';

interface CleanupOptions {
  now?: Date;
  batchSize?: number;
  sourceBatchSize?: number;
}

interface ImportCleanupHooks {
  expireKnowledge: typeof expireKnowledgeImports;
  expireQuiz: typeof expireQuizImports;
  cleanKnowledgeSource: typeof processKnowledgeImportSourceCleanup;
  cleanQuizSource: typeof processQuizImportSourceCleanup;
}

const defaultHooks: ImportCleanupHooks = {
  expireKnowledge: expireKnowledgeImports,
  expireQuiz: expireQuizImports,
  cleanKnowledgeSource: processKnowledgeImportSourceCleanup,
  cleanQuizSource: processQuizImportSourceCleanup,
};

export async function processLifecycleCleanupBatch(
  prisma: PrismaClient,
  options: CleanupOptions = {},
  hooks: ImportCleanupHooks = defaultHooks,
) {
  const now = options.now ?? new Date();
  const batchSize = bounded(options.batchSize ?? 100, 1, 1_000);
  const sourceBatchSize = bounded(options.sourceBatchSize ?? 10, 1, 100);

  await hooks.expireKnowledge(prisma, now);
  await hooks.expireQuiz(prisma, now);

  let knowledgeSources = 0;
  let quizSources = 0;
  for (let index = 0; index < sourceBatchSize; index += 1) {
    const [knowledgeProcessed, quizProcessed] = await Promise.all([
      hooks.cleanKnowledgeSource(prisma, now),
      hooks.cleanQuizSource(prisma, now),
    ]);
    if (knowledgeProcessed) knowledgeSources += 1;
    if (quizProcessed) quizSources += 1;
    if (!knowledgeProcessed && !quizProcessed) break;
  }

  const expiredSessions = await cleanupExpiredSessions(prisma, now, batchSize);
  const expiredQuizDrafts = await cleanupExpiredQuizDrafts(
    prisma,
    now,
    batchSize,
  );
  return {
    expiredSessions,
    expiredQuizDrafts,
    knowledgeSources,
    quizSources,
  };
}

export async function cleanupExpiredSessions(
  prisma: PrismaClient,
  now: Date,
  batchSize: number,
) {
  const rows = await prisma.session.findMany({
    where: { expiresAt: { lte: now } },
    select: { id: true },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: bounded(batchSize, 1, 1_000),
  });
  if (!rows.length) return 0;
  const deleted = await prisma.session.deleteMany({
    where: {
      id: { in: rows.map((row) => row.id) },
      expiresAt: { lte: now },
    },
  });
  return deleted.count;
}

export async function cleanupExpiredQuizDrafts(
  prisma: PrismaClient,
  now: Date,
  batchSize: number,
) {
  const cleanupWhere: Prisma.QuizAttemptWhereInput = {
    submittedAt: null,
    OR: [
      {
        lifecycleStatus: {
          in: [QuizAttemptStatus.DRAFT, QuizAttemptStatus.SCORING_FAILED],
        },
        expiresAt: { lte: now },
      },
      {
        lifecycleStatus: QuizAttemptStatus.ABANDONED,
        abandonedAt: { lte: now },
      },
    ],
  };
  const rows = await prisma.quizAttempt.findMany({
    where: cleanupWhere,
    select: { id: true },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: bounded(batchSize, 1, 1_000),
  });
  if (!rows.length) return 0;
  const deleted = await prisma.quizAttempt.deleteMany({
    where: {
      id: { in: rows.map((row) => row.id) },
      ...cleanupWhere,
    },
  });
  return deleted.count;
}

function bounded(value: number, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`cleanup batch must be ${minimum}-${maximum}`);
  }
  return value;
}
