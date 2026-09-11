import {
  Prisma,
  QuizQuestionOrigin,
  QuizQuestionReviewStatus,
  QuizQuestionSourceReviewStatus,
} from '@prisma/client';

export async function markQuestionSourcesReviewRequired(
  transaction: Prisma.TransactionClient,
  input: {
    documentVersionId?: string;
    documentId?: string;
    libraryId?: string;
  },
) {
  const sourceWhere: Prisma.QuizQuestionKnowledgeSourceWhereInput = {
    current: true,
    ...(input.documentVersionId
      ? { documentVersionId: input.documentVersionId }
      : {}),
    ...(input.documentId ? { documentId: input.documentId } : {}),
    ...(input.libraryId ? { libraryId: input.libraryId } : {}),
  };
  const questionIds = await transaction.quizQuestionKnowledgeSource.findMany({
    where: sourceWhere,
    select: { questionId: true },
    distinct: ['questionId'],
  });
  if (!questionIds.length) return 0;
  const result = await transaction.quizQuestion.updateMany({
    where: {
      id: { in: questionIds.map(({ questionId }) => questionId) },
      origin: QuizQuestionOrigin.AI_GENERATED,
      reviewStatus: QuizQuestionReviewStatus.APPROVED,
      sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
    },
    data: {
      sourceReviewStatus: QuizQuestionSourceReviewStatus.REVIEW_REQUIRED,
      sourceReviewRequiredAt: new Date(),
    },
  });
  return result.count;
}
