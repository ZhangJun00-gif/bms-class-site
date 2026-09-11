import {
  QuizQuestionOrigin,
  QuizQuestionReviewStatus,
  QuizQuestionSourceReviewStatus,
} from '@prisma/client';
import { markQuestionSourcesReviewRequired } from './question-source-lifecycle';

describe('markQuestionSourcesReviewRequired', () => {
  it('marks only approved AI questions with a valid current source', async () => {
    const transaction = {
      quizQuestionKnowledgeSource: {
        findMany: jest.fn().mockResolvedValue([
          { questionId: 'question-1' },
          { questionId: 'question-2' },
        ]),
      },
      quizQuestion: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    await expect(markQuestionSourcesReviewRequired(
      transaction as never,
      { documentVersionId: 'version-1' },
    )).resolves.toBe(2);

    expect(transaction.quizQuestionKnowledgeSource.findMany).toHaveBeenCalledWith({
      where: { current: true, documentVersionId: 'version-1' },
      select: { questionId: true },
      distinct: ['questionId'],
    });
    expect(transaction.quizQuestion.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['question-1', 'question-2'] },
        origin: QuizQuestionOrigin.AI_GENERATED,
        reviewStatus: QuizQuestionReviewStatus.APPROVED,
        sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
      },
      data: {
        sourceReviewStatus: QuizQuestionSourceReviewStatus.REVIEW_REQUIRED,
        sourceReviewRequiredAt: expect.any(Date),
      },
    });
  });

  it('does not issue an update when no current source matches', async () => {
    const transaction = {
      quizQuestionKnowledgeSource: { findMany: jest.fn().mockResolvedValue([]) },
      quizQuestion: { updateMany: jest.fn() },
    };
    await expect(markQuestionSourcesReviewRequired(
      transaction as never,
      { libraryId: 'library-1' },
    )).resolves.toBe(0);
    expect(transaction.quizQuestion.updateMany).not.toHaveBeenCalled();
  });
});
