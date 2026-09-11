import {
  AiQuestionGenerationStatus,
  PrismaClient,
  QuizQuestionOrigin,
  QuizQuestionReviewAction,
  QuizQuestionReviewStatus,
  QuizQuestionSourceReviewStatus,
} from '@prisma/client';

const prisma = new PrismaClient();
const sampleLimit = 100;

async function main() {
  const [
    legacyAiQuestions,
    withoutCurrentSource,
    detachedCurrentSources,
    approvedWithoutApproveEvent,
    approvedSourceStateMismatch,
    orphanGenerationItems,
    completedJobs,
  ] = await Promise.all([
    questionIds({
      origin: QuizQuestionOrigin.AI_GENERATED,
      generationItem: null,
    }),
    questionIds({
      origin: QuizQuestionOrigin.AI_GENERATED,
      knowledgeSources: { none: { current: true } },
    }),
    prisma.quizQuestionKnowledgeSource.findMany({
      where: { current: true, knowledgeNodeId: null },
      select: { id: true, questionId: true, documentVersionId: true },
      orderBy: { id: 'asc' },
      take: sampleLimit,
    }),
    questionIds({
      origin: QuizQuestionOrigin.AI_GENERATED,
      reviewStatus: QuizQuestionReviewStatus.APPROVED,
      reviewEvents: { none: { action: QuizQuestionReviewAction.APPROVE } },
    }),
    questionIds({
      origin: QuizQuestionOrigin.AI_GENERATED,
      reviewStatus: QuizQuestionReviewStatus.APPROVED,
      sourceReviewStatus: QuizQuestionSourceReviewStatus.NOT_APPLICABLE,
    }),
    prisma.aiQuestionGenerationItem.findMany({
      where: { questionId: null },
      select: { id: true, jobId: true, ordinal: true },
      orderBy: { id: 'asc' },
      take: sampleLimit,
    }),
    prisma.aiQuestionGenerationJob.findMany({
      where: { status: AiQuestionGenerationStatus.COMPLETED },
      select: { id: true, requestedCount: true, _count: { select: { items: true } } },
      orderBy: { id: 'asc' },
    }),
  ]);

  const completedJobCountMismatches = completedJobs
    .filter((job) => job.requestedCount !== job._count.items)
    .slice(0, sampleLimit)
    .map((job) => ({
      id: job.id,
      requestedCount: job.requestedCount,
      itemCount: job._count.items,
    }));
  const consistent =
    withoutCurrentSource.total === 0 &&
    detachedCurrentSources.length === 0 &&
    approvedWithoutApproveEvent.total === 0 &&
    approvedSourceStateMismatch.total === 0 &&
    orphanGenerationItems.length === 0 &&
    completedJobCountMismatches.length === 0;

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    readOnly: true,
    legacyAiQuestions,
    withoutCurrentSource,
    detachedCurrentSources,
    approvedWithoutApproveEvent,
    approvedSourceStateMismatch,
    orphanGenerationItems,
    completedJobCountMismatches,
    consistent,
  }, null, 2));
}

async function questionIds(where: Parameters<typeof prisma.quizQuestion.count>[0]['where']) {
  const [total, samples] = await Promise.all([
    prisma.quizQuestion.count({ where }),
    prisma.quizQuestion.findMany({
      where,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: sampleLimit,
    }),
  ]);
  return { total, sampleIds: samples.map(({ id }) => id) };
}

void main()
  .finally(() => prisma.$disconnect());
