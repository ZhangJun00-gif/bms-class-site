import { QuizAttemptStatus } from '@prisma/client';
import {
  cleanupExpiredQuizDrafts,
  cleanupExpiredSessions,
  processLifecycleCleanupBatch,
} from './lifecycle-cleanup';

const now = new Date('2026-08-11T06:00:00.000Z');

describe('lifecycle cleanup', () => {
  it('deletes only a bounded set of sessions that are still expired', async () => {
    const session = {
      findMany: jest.fn().mockResolvedValue([{ id: 'session-1' }]),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };

    await expect(
      cleanupExpiredSessions({ session } as never, now, 25),
    ).resolves.toBe(1);

    expect(session.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now } },
      select: { id: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: 25,
    });
    expect(session.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['session-1'] }, expiresAt: { lte: now } },
    });
  });

  it('never enrolls legacy or submitted attempts in automatic cleanup', async () => {
    const quizAttempt = {
      findMany: jest.fn().mockResolvedValue([{ id: 'draft-1' }]),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };

    await expect(
      cleanupExpiredQuizDrafts({ quizAttempt } as never, now, 50),
    ).resolves.toBe(1);

    const selectionWhere = quizAttempt.findMany.mock.calls[0]![0].where;
    expect(selectionWhere.submittedAt).toBeNull();
    expect(selectionWhere.OR).toEqual([
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
    ]);
    expect(JSON.stringify(selectionWhere)).not.toContain('SUBMITTED');
    expect(JSON.stringify(selectionWhere)).not.toContain('lifecycleStatus":null');
    expect(quizAttempt.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: { in: ['draft-1'] },
        submittedAt: null,
      }),
    });
  });

  it('expires imports and bounds source cleanup work per completed tick', async () => {
    const prisma = {
      session: { findMany: jest.fn().mockResolvedValue([]) },
      quizAttempt: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const hooks = {
      expireKnowledge: jest.fn().mockResolvedValue(undefined),
      expireQuiz: jest.fn().mockResolvedValue(undefined),
      cleanKnowledgeSource: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      cleanQuizSource: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    };

    await expect(
      processLifecycleCleanupBatch(
        prisma as never,
        { now, batchSize: 10, sourceBatchSize: 5 },
        hooks,
      ),
    ).resolves.toEqual({
      expiredSessions: 0,
      expiredQuizDrafts: 0,
      knowledgeSources: 1,
      quizSources: 1,
    });
    expect(hooks.expireKnowledge).toHaveBeenCalledWith(prisma, now);
    expect(hooks.expireQuiz).toHaveBeenCalledWith(prisma, now);
    expect(hooks.cleanKnowledgeSource).toHaveBeenCalledTimes(2);
    expect(hooks.cleanQuizSource).toHaveBeenCalledTimes(2);
  });
});
