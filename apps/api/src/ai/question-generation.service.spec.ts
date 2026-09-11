import { ConflictException } from '@nestjs/common';
import {
  AiQuestionGenerationComplexity,
  AiQuestionGenerationStatus,
  QuestionType,
} from '@prisma/client';
import { QuestionGenerationService } from './question-generation.service';

const user = { id: 'editor-1' } as never;

function source(knowledgeNodeId: string, ordinal: number) {
  return {
    ordinal,
    knowledgeNodeId,
    libraryId: 'library-1',
    documentId: `document-${knowledgeNodeId}`,
    documentVersionId: `version-${knowledgeNodeId}`,
    libraryChapterId: 'library-chapter-1',
    nodeTitle: knowledgeNodeId,
    nodeTitleMarkdown: knowledgeNodeId,
    breadcrumb: `教材 > ${knowledgeNodeId}`,
    nodePath: `教材 > ${knowledgeNodeId}`,
    pathHash: knowledgeNodeId.padEnd(64, '0').slice(0, 64),
    contentHash: knowledgeNodeId.padEnd(64, 'a').slice(0, 64),
    chunkManifest: [],
    evidenceContent: `evidence-${knowledgeNodeId}`,
    chunkCount: 1,
    tokenCount: 10,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    subjectId: 'subject-1',
    chapterIds: ['chapter-b', 'chapter-a'],
    knowledgeNodeIds: ['node-b', 'node-a'],
    gradingType: QuestionType.MULTIPLE,
    typeLabel: '多选题',
    complexity: AiQuestionGenerationComplexity.SIMPLE,
    requestedCount: 1,
    ...overrides,
  };
}

function preflight(value: ReturnType<typeof input>) {
  return {
    input: value,
    sources: value.knowledgeNodeIds.map((id, ordinal) => source(id, ordinal)),
    summary: {
      chapterCount: value.chapterIds.length,
      nodeCount: value.knowledgeNodeIds.length,
      chunkCount: value.knowledgeNodeIds.length,
      evidenceTokens: 20,
      dedupCandidates: 0,
      requestedCount: value.requestedCount,
      strategy: 'FLASH',
      model: 'deepseek-v4-flash',
      sourceRevision: 'source-revision',
      promptVersion: 'ai-question-generation-v1',
      maxOutputTokens: 8_000,
    },
  };
}

function job(requestHash: string | null) {
  const now = new Date('2026-08-10T00:00:00.000Z');
  return {
    id: 'job-1',
    subjectId: 'subject-1',
    gradingType: QuestionType.MULTIPLE,
    typeLabel: '多选题',
    complexity: AiQuestionGenerationComplexity.SIMPLE,
    requestedCount: 1,
    status: AiQuestionGenerationStatus.PENDING,
    stage: 'QUEUED',
    requestHash,
    promptVersion: 'ai-question-generation-v1',
    configSnapshot: {},
    attempts: 0,
    nextAttemptAt: null,
    cancelRequestedAt: null,
    errorCategory: null,
    errorMessage: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    subject: { id: 'subject-1', name: '生理学', slug: 'physiology' },
    createdBy: { id: 'editor-1', displayName: '测试编辑' },
    chapters: [
      {
        chapter: {
          id: 'chapter-a',
          name: '章节 A',
          slug: 'chapter-a',
        },
      },
    ],
    _count: { sources: 2, items: 0 },
  };
}

describe('QuestionGenerationService idempotency', () => {
  it('reuses the same key when only chapter and source ordering differs', async () => {
    let persisted: ReturnType<typeof job> | null = null;
    const transaction = {
      aiQuestionGenerationJob: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(async (args) => {
          persisted = job(args.data.requestHash);
          return persisted;
        }),
      },
    };
    const prisma = {
      aiQuestionGenerationJob: {
        findUnique: jest.fn().mockImplementation(async () => persisted),
      },
      $transaction: jest.fn(
        async (action: (tx: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const sources = {
      preflight: jest.fn().mockImplementation(async (value) => preflight(value)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new QuestionGenerationService(
      prisma as never,
      sources as never,
      audit as never,
    );

    await service.create(user, 'stable-key', input() as never);
    const result = await service.create(
      user,
      'stable-key',
      input({
        chapterIds: ['chapter-a', 'chapter-b'],
        knowledgeNodeIds: ['node-a', 'node-b'],
      }) as never,
    );

    expect(result).toMatchObject({ id: 'job-1' });
    expect(transaction.aiQuestionGenerationJob.create).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when the same key is reused for a different request', async () => {
    const existing = job('f'.repeat(64));
    const prisma = {
      aiQuestionGenerationJob: {
        findUnique: jest.fn().mockResolvedValue(existing),
      },
    };
    const sources = {
      preflight: jest.fn().mockResolvedValue(preflight(input({ requestedCount: 2 }))),
    };
    const service = new QuestionGenerationService(
      prisma as never,
      sources as never,
      {} as never,
    );

    await expect(
      service.create(user, 'stable-key', input({ requestedCount: 2 }) as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('never silently reuses a legacy row whose request hash is null', async () => {
    const prisma = {
      aiQuestionGenerationJob: {
        findUnique: jest.fn().mockResolvedValue(job(null)),
      },
    };
    const sources = { preflight: jest.fn().mockResolvedValue(preflight(input())) };
    const service = new QuestionGenerationService(
      prisma as never,
      sources as never,
      {} as never,
    );

    await expect(
      service.create(user, 'legacy-key', input() as never),
    ).rejects.toThrow('该幂等键属于旧任务');
  });
});
