import { BadRequestException } from '@nestjs/common';
import {
  QuizQuestionOrigin,
  QuizQuestionReviewAction,
  QuizQuestionReviewStatus,
  QuizQuestionSourceReviewStatus,
  type User,
} from '@prisma/client';
import type { QuestionGenerationSourceSnapshot } from './question-generation-source.service';
import { QuestionReviewService } from './question-review.service';

const user = { id: 'editor-1' } as User;

function snapshot(
  overrides: Partial<QuestionGenerationSourceSnapshot> = {},
): QuestionGenerationSourceSnapshot {
  return {
    ordinal: 0,
    knowledgeNodeId: 'leaf-1',
    libraryId: 'library-1',
    documentId: 'document-1',
    documentVersionId: 'version-1',
    libraryChapterId: 'library-chapter-1',
    nodeTitle: '压力感受性反射',
    nodeTitleMarkdown: '压力感受性反射',
    breadcrumb: '循环调节 > 压力感受性反射',
    nodePath: '循环调节 > 压力感受性反射',
    pathHash: 'a'.repeat(64),
    contentHash: 'c'.repeat(64),
    chunkManifest: [
      { id: 'chunk-1', contentHash: 'c'.repeat(64), tokenCount: 12 },
    ],
    evidenceContent: '证据正文',
    chunkCount: 1,
    tokenCount: 12,
    ...overrides,
  };
}

function pendingQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'question-1',
    subjectId: 'subject-1',
    origin: QuizQuestionOrigin.AI_GENERATED,
    reviewStatus: QuizQuestionReviewStatus.APPROVED,
    sourceReviewStatus: QuizQuestionSourceReviewStatus.REVIEW_REQUIRED,
    knowledgeSources: [
      {
        documentId: 'document-old',
        libraryId: 'library-1',
        nodePathHash: 'a'.repeat(64),
        knowledgeNode: null,
      },
    ],
    ...overrides,
  };
}

function lockedQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'question-1',
    origin: QuizQuestionOrigin.AI_GENERATED,
    reviewStatus: QuizQuestionReviewStatus.APPROVED,
    sourceReviewStatus: QuizQuestionSourceReviewStatus.REVIEW_REQUIRED,
    sourceRevision: 2,
    reviewRevision: 5,
    ...overrides,
  };
}

function createBulkHarness() {
  const loads = new Map<string, unknown>();
  const locked = new Map<string, unknown>();
  const leafNodeByDocumentAndHash = new Map<string, string>();
  const candidatesByPathHash = new Map<string, Array<{ id: string }>>();
  const transaction = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    quizQuestion: {
      findUniqueOrThrow: jest.fn((args: { where: { id: string } }) =>
        Promise.resolve(locked.get(args.where.id)),
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    quizQuestionKnowledgeSource: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    quizQuestionReviewEvent: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    quizQuestion: {
      findFirst: jest.fn((args: { where: { id: string } }) =>
        Promise.resolve(loads.get(args.where.id) ?? null),
      ),
    },
    knowledgeNode: {
      findFirst: jest.fn(
        (args: {
          where: {
            AND: [
              unknown,
              {
                pathHash: string;
                documentVersion: {
                  activeForDocument: { is: { id: string } };
                };
              },
            ];
          };
        }) => {
          const clause = args.where.AND[1];
          const nodeId = leafNodeByDocumentAndHash.get(
            `${clause.documentVersion.activeForDocument.is.id}:${clause.pathHash}`,
          );
          return Promise.resolve(nodeId ? { id: nodeId } : null);
        },
      ),
    },
    knowledgeDocument: {
      findMany: jest.fn(
        (args: {
          where: {
            activeVersion: {
              is: { nodes: { some: { pathHash: string } } };
            };
          };
        }) =>
          Promise.resolve(
            candidatesByPathHash.get(
              args.where.activeVersion.is.nodes.some.pathHash,
            ) ?? [],
          ),
      ),
    },
    $transaction: jest.fn((callback: (client: unknown) => unknown) =>
      callback(transaction),
    ),
  };
  const sourceService = { snapshotSources: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new QuestionReviewService(
    prisma as never,
    sourceService as never,
    audit as never,
  );
  return {
    service,
    prisma,
    sourceService,
    audit,
    transaction,
    loads,
    locked,
    leafNodeByDocumentAndHash,
    candidatesByPathHash,
  };
}

describe('QuestionReviewService.reopen', () => {
  it('moves an approved question back to review draft in the audited transaction', async () => {
    const question = {
      id: 'question-1',
      origin: QuizQuestionOrigin.AI_GENERATED,
      type: 'MULTIPLE',
      typeLabel: '多选题',
      subjectId: 'subject-1',
      category: 'KNOWLEDGE_RECALL',
      prompt: '题干',
      options: [{ id: 'A', text: '选项' }],
      correctAnswer: ['A'],
      gradingRubric: null,
      maxScore: 1,
      explanation: '解析',
      reviewStatus: QuizQuestionReviewStatus.APPROVED,
      reviewRevision: 4,
      sourceRevision: 2,
      chapters: [{ chapterId: 'chapter-1' }],
    };
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'question-1' }]),
      quizQuestion: {
        findFirst: jest.fn().mockResolvedValue(question),
        update: jest.fn().mockResolvedValue({}),
      },
      quizQuestionReviewEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (action: (tx: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new QuestionReviewService(
      prisma as never,
      {} as never,
      audit as never,
    );
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'question-1' } as never);

    await service.reopen(user, 'question-1', 4);

    expect(transaction.quizQuestion.update).toHaveBeenCalledWith({
      where: { id: 'question-1' },
      data: {
        reviewStatus: QuizQuestionReviewStatus.DRAFT_REVIEW,
        reviewRevision: { increment: 1 },
      },
    });
    expect(transaction.quizQuestionReviewEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: QuizQuestionReviewAction.REOPEN,
          expectedRevision: 4,
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'editor-1',
      'ai.question-review.reopen',
      'QuizQuestion',
      'question-1',
      { expectedRevision: 4 },
      transaction,
    );
  });
});

describe('QuestionReviewService.revalidateSource', () => {
  it('persists nodePathHash on the new source rows', async () => {
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      quizQuestion: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'question-1',
          origin: QuizQuestionOrigin.AI_GENERATED,
          reviewRevision: 3,
          sourceRevision: 1,
          sourceReviewStatus: QuizQuestionSourceReviewStatus.REVIEW_REQUIRED,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      quizQuestionKnowledgeSource: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quizQuestionReviewEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      quizQuestion: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'question-1',
          subjectId: 'subject-1',
          reviewRevision: 3,
          reviewStatus: QuizQuestionReviewStatus.APPROVED,
          sourceRevision: 1,
        }),
      },
      $transaction: jest.fn((callback: (client: unknown) => unknown) =>
        callback(transaction),
      ),
    };
    const sourceService = {
      expandKnowledgeNodeIds: jest.fn().mockResolvedValue(['leaf-1']),
      snapshotSources: jest.fn().mockResolvedValue([snapshot()]),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new QuestionReviewService(
      prisma as never,
      sourceService as never,
      audit as never,
    );
    jest
      .spyOn(service, 'get')
      .mockResolvedValue({ id: 'question-1' } as never);

    await service.revalidateSource(user, 'question-1', 3, ['node-1']);

    expect(
      transaction.quizQuestionKnowledgeSource.updateMany,
    ).toHaveBeenCalledWith({
      where: { questionId: 'question-1', current: true },
      data: { current: false, supersededAt: expect.any(Date) },
    });
    expect(
      transaction.quizQuestionKnowledgeSource.createMany,
    ).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          questionId: 'question-1',
          sourceRevision: 2,
          ordinal: 0,
          knowledgeNodeId: 'leaf-1',
          nodePathHash: 'a'.repeat(64),
          current: true,
        }),
      ],
    });
    expect(transaction.quizQuestion.update).toHaveBeenCalledWith({
      where: { id: 'question-1' },
      data: {
        sourceRevision: 2,
        sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
        sourceReviewRequiredAt: null,
        reviewRevision: { increment: 1 },
      },
    });
    const event =
      transaction.quizQuestionReviewEvent.create.mock.calls[0][0].data;
    expect(event).toEqual(
      expect.objectContaining({
        action: QuizQuestionReviewAction.SOURCE_REVALIDATE,
        expectedRevision: 3,
        sourceRevision: 2,
        beforeSnapshot: {
          sourceRevision: 1,
          sourceReviewStatus: QuizQuestionSourceReviewStatus.REVIEW_REQUIRED,
        },
        afterSnapshot: {
          sourceRevision: 2,
          sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
          knowledgeNodeIds: ['leaf-1'],
        },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'editor-1',
      'ai.question-review.source-revalidate',
      'QuizQuestion',
      'question-1',
      { expectedRevision: 3, sourceRevision: 2 },
      transaction,
    );
  });
});

describe('QuestionReviewService.bulkRevalidateSources', () => {
  it('rebinds sources through a replacement document and persists nodePathHash', async () => {
    const harness = createBulkHarness();
    const pathHash = 'a'.repeat(64);
    harness.loads.set('question-1', pendingQuestion());
    harness.locked.set('question-1', lockedQuestion());
    harness.candidatesByPathHash.set(pathHash, [{ id: 'document-new' }]);
    harness.leafNodeByDocumentAndHash.set(
      `document-new:${pathHash}`,
      'leaf-new',
    );
    harness.sourceService.snapshotSources.mockResolvedValue([
      snapshot({
        knowledgeNodeId: 'leaf-new',
        documentId: 'document-new',
        documentVersionId: 'version-2',
        pathHash,
      }),
    ]);

    const result = await harness.service.bulkRevalidateSources(user, [
      'question-1',
    ]);

    expect(result).toEqual({
      results: [
        { questionId: 'question-1', status: 'REVALIDATED', sourceRevision: 3 },
      ],
    });
    expect(harness.sourceService.snapshotSources).toHaveBeenCalledWith(
      'subject-1',
      ['leaf-new'],
    );
    expect(
      harness.transaction.quizQuestionKnowledgeSource.updateMany,
    ).toHaveBeenCalledWith({
      where: { questionId: 'question-1', current: true },
      data: { current: false, supersededAt: expect.any(Date) },
    });
    expect(
      harness.transaction.quizQuestionKnowledgeSource.createMany,
    ).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          questionId: 'question-1',
          sourceRevision: 3,
          ordinal: 0,
          knowledgeNodeId: 'leaf-new',
          documentId: 'document-new',
          documentVersionId: 'version-2',
          nodePathHash: pathHash,
          current: true,
        }),
      ],
    });
    expect(harness.transaction.quizQuestion.update).toHaveBeenCalledWith({
      where: { id: 'question-1' },
      data: {
        sourceRevision: 3,
        sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
        sourceReviewRequiredAt: null,
        reviewRevision: { increment: 1 },
      },
    });
    const event =
      harness.transaction.quizQuestionReviewEvent.create.mock.calls[0][0].data;
    expect(event).toEqual(
      expect.objectContaining({
        questionId: 'question-1',
        reviewerId: 'editor-1',
        action: QuizQuestionReviewAction.SOURCE_REVALIDATE,
        expectedRevision: 5,
        sourceRevision: 3,
        beforeSnapshot: {
          sourceRevision: 2,
          sourceReviewStatus: QuizQuestionSourceReviewStatus.REVIEW_REQUIRED,
        },
        afterSnapshot: {
          sourceRevision: 3,
          sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
          knowledgeNodeIds: ['leaf-new'],
          bulk: true,
        },
      }),
    );
    expect(harness.audit.record).toHaveBeenCalledWith(
      'editor-1',
      'ai.question-review.source-revalidate',
      'QuizQuestion',
      'question-1',
      { expectedRevision: 5, sourceRevision: 3, bulk: true },
      harness.transaction,
    );
  });

  it('prefers the same document active version and skips replacement lookup', async () => {
    const harness = createBulkHarness();
    const pathHash = 'b'.repeat(64);
    harness.loads.set(
      'question-1',
      pendingQuestion({
        knowledgeSources: [
          {
            documentId: 'document-old',
            libraryId: 'library-1',
            nodePathHash: null,
            knowledgeNode: { pathHash },
          },
        ],
      }),
    );
    harness.locked.set('question-1', lockedQuestion());
    harness.leafNodeByDocumentAndHash.set(
      `document-old:${pathHash}`,
      'leaf-same',
    );
    harness.sourceService.snapshotSources.mockResolvedValue([
      snapshot({ knowledgeNodeId: 'leaf-same', pathHash }),
    ]);

    const result = await harness.service.bulkRevalidateSources(user, [
      'question-1',
    ]);

    expect(result.results).toEqual([
      { questionId: 'question-1', status: 'REVALIDATED', sourceRevision: 3 },
    ]);
    expect(harness.prisma.knowledgeDocument.findMany).not.toHaveBeenCalled();
    expect(harness.sourceService.snapshotSources).toHaveBeenCalledWith(
      'subject-1',
      ['leaf-same'],
    );
  });

  it('fails with SOURCE_NODE_AMBIGUOUS when two replacement documents match', async () => {
    const harness = createBulkHarness();
    const pathHash = 'a'.repeat(64);
    harness.loads.set('question-1', pendingQuestion());
    harness.candidatesByPathHash.set(pathHash, [
      { id: 'document-a' },
      { id: 'document-b' },
    ]);

    const result = await harness.service.bulkRevalidateSources(user, [
      'question-1',
    ]);

    expect(result.results).toEqual([
      {
        questionId: 'question-1',
        status: 'FAILED',
        reason: 'SOURCE_NODE_AMBIGUOUS',
      },
    ]);
    expect(harness.sourceService.snapshotSources).not.toHaveBeenCalled();
    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails with SOURCE_NODE_NOT_FOUND when no replacement document matches', async () => {
    const harness = createBulkHarness();
    harness.loads.set('question-1', pendingQuestion());

    const result = await harness.service.bulkRevalidateSources(user, [
      'question-1',
    ]);

    expect(result.results).toEqual([
      {
        questionId: 'question-1',
        status: 'FAILED',
        reason: 'SOURCE_NODE_NOT_FOUND',
      },
    ]);
    expect(harness.sourceService.snapshotSources).not.toHaveBeenCalled();
    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails with SOURCE_PATH_UNKNOWN when a source has no resolvable path hash', async () => {
    const harness = createBulkHarness();
    harness.loads.set(
      'question-1',
      pendingQuestion({
        knowledgeSources: [
          {
            documentId: 'document-old',
            libraryId: 'library-1',
            nodePathHash: null,
            knowledgeNode: null,
          },
        ],
      }),
    );

    const result = await harness.service.bulkRevalidateSources(user, [
      'question-1',
    ]);

    expect(result.results).toEqual([
      {
        questionId: 'question-1',
        status: 'FAILED',
        reason: 'SOURCE_PATH_UNKNOWN',
      },
    ]);
    expect(harness.prisma.knowledgeNode.findFirst).not.toHaveBeenCalled();
    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips questions that are missing or not pending source review', async () => {
    const harness = createBulkHarness();
    harness.loads.set(
      'question-valid',
      pendingQuestion({
        id: 'question-valid',
        sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
      }),
    );

    const result = await harness.service.bulkRevalidateSources(user, [
      'question-valid',
      'question-missing',
    ]);

    expect(result.results).toEqual([
      {
        questionId: 'question-valid',
        status: 'SKIPPED',
        reason: 'NOT_PENDING_SOURCE_REVIEW',
      },
      {
        questionId: 'question-missing',
        status: 'SKIPPED',
        reason: 'NOT_FOUND',
      },
    ]);
    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('isolates per-question snapshot failures from successful revalidations', async () => {
    const harness = createBulkHarness();
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    harness.loads.set(
      'question-fail',
      pendingQuestion({ id: 'question-fail' }),
    );
    harness.loads.set(
      'question-ok',
      pendingQuestion({
        id: 'question-ok',
        knowledgeSources: [
          {
            documentId: 'document-old-2',
            libraryId: 'library-1',
            nodePathHash: hashB,
            knowledgeNode: null,
          },
        ],
      }),
    );
    harness.locked.set('question-ok', lockedQuestion({ id: 'question-ok' }));
    harness.candidatesByPathHash.set(hashA, [{ id: 'document-new' }]);
    harness.leafNodeByDocumentAndHash.set(
      `document-new:${hashA}`,
      'leaf-fail',
    );
    harness.leafNodeByDocumentAndHash.set(
      `document-old-2:${hashB}`,
      'leaf-ok',
    );
    harness.sourceService.snapshotSources.mockImplementation(
      (subjectId: string, leafNodeIds: string[]) => {
        if (leafNodeIds[0] === 'leaf-fail') {
          return Promise.reject(
            new BadRequestException({
              statusCode: 400,
              code: 'AI_GENERATION_SCOPE_INVALID',
              message: '知识节点“旧证据”没有可用于出题的正文',
            }),
          );
        }
        return Promise.resolve([
          snapshot({ knowledgeNodeId: 'leaf-ok', pathHash: hashB }),
        ]);
      },
    );

    const result = await harness.service.bulkRevalidateSources(user, [
      'question-fail',
      'question-ok',
    ]);

    expect(result.results).toEqual([
      {
        questionId: 'question-fail',
        status: 'FAILED',
        reason: 'AI_GENERATION_SCOPE_INVALID',
      },
      { questionId: 'question-ok', status: 'REVALIDATED', sourceRevision: 3 },
    ]);
    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(harness.transaction.quizQuestion.update).toHaveBeenCalledTimes(1);
  });
});
