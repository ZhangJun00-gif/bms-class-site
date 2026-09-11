import {
  AccountStatus,
  ContentStatus,
  IndexStatus,
  KnowledgeConversationMode,
  KnowledgeKind,
  KnowledgeLibraryScope,
  KnowledgeRenderStatus,
} from '@prisma/client';
import { AiKnowledgeService } from './ai-knowledge.service';

const user = { id: 'user-1', status: AccountStatus.ACTIVE } as never;

function sharedLibrary() {
  return {
    id: 'library-1',
    subjectId: 'subject-1',
    scope: KnowledgeLibraryScope.SHARED,
    ownerId: null,
    aiEnabled: false,
    active: true,
    deletedAt: null,
  };
}

function evidenceRow(id: string) {
  const versionId = `version-${id}`;
  const nodeId = `node-${id}`;
  const blockId = `block-${id}`;
  return {
    id,
    content: `content ${id}`,
    contentHash: `hash-${id}`,
    embeddingStatus: IndexStatus.READY,
    documentVersionId: versionId,
    nodeId,
    primaryRenderBlockId: blockId,
    primaryRenderBlock: { id: blockId, nodeId, documentVersionId: versionId },
    node: {
      id: nodeId,
      parentId: null,
      level: 2,
      title: `title ${id}`,
      titleMarkdown: `title ${id}`,
      breadcrumb: `title ${id}`,
      documentVersionId: versionId,
      libraryChapterId: 'chapter-1',
      libraryChapter: { libraryId: 'library-1', active: true },
    },
    documentVersion: {
      id: versionId,
      indexStatus: IndexStatus.READY,
      renderStatus: KnowledgeRenderStatus.READY,
      embeddingModel: 'embedding-3',
      embeddingDimensions: 2,
    },
    document: {
      id: `document-${id}`,
      kind: KnowledgeKind.MARKDOWN,
      status: ContentStatus.PUBLISHED,
      deletedAt: null,
      subjectId: 'subject-1',
      libraryId: 'library-1',
      activeVersionId: versionId,
      library: { ...sharedLibrary(), name: 'Shared library' },
    },
  };
}

function basePrisma(overrides: Record<string, unknown> = {}) {
  const transaction = {
    aiConversation: {
      create: jest.fn().mockResolvedValue({ id: 'conversation-1' }),
    },
  };
  return {
    subject: { findFirst: jest.fn().mockResolvedValue({ id: 'subject-1' }) },
    knowledgeLibrary: {
      findMany: jest.fn().mockResolvedValue([sharedLibrary()]),
    },
    knowledgeLibraryChapter: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    knowledgeChunk: { findMany: jest.fn().mockResolvedValue([]) },
    knowledgeNode: { findMany: jest.fn().mockResolvedValue([]) },
    knowledgeImageReference: { findMany: jest.fn().mockResolvedValue([]) },
    aiConversation: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    aiMessage: { create: jest.fn() },
    $transaction: jest.fn(async (input: unknown) =>
      typeof input === 'function'
        ? (input as (value: typeof transaction) => unknown)(transaction)
        : input,
    ),
    ...overrides,
  };
}

describe('AiKnowledgeService scoped retrieval', () => {
  it('creates an immutable scope and sends all hard filters to Qdrant', async () => {
    const prisma = basePrisma();
    const embedding = {
      model: 'embedding-3',
      embedQuestion: jest.fn().mockResolvedValue([1, 0]),
    };
    const vectors = { search: jest.fn().mockResolvedValue([]) };
    const llm = { model: 'mock', stream: jest.fn() };
    const service = new AiKnowledgeService(
      prisma as never,
      embedding as never,
      vectors as never,
      llm as never,
    );

    const result = await service.prepare(
      {
        question: '细胞膜如何运输',
        subjectId: 'subject-1',
        knowledgeMode: KnowledgeConversationMode.SHARED,
        libraryIds: ['library-1'],
      },
      user,
    );

    expect(result.scope).toEqual({
      conversationId: 'conversation-1',
      subjectId: 'subject-1',
      mode: 'SHARED',
      libraryIds: ['library-1'],
      libraryChapterIds: [],
    });
    expect(vectors.search).toHaveBeenCalledWith(
      [1, 0],
      {
        subjectId: 'subject-1',
        mode: 'SHARED',
        libraryIds: ['library-1'],
        libraryChapterIds: [],
        userId: 'user-1',
        embeddingModel: 'embedding-3',
      },
      undefined,
    );
  });

  it('rejects scope fields on continuation and legacy conversations', async () => {
    const prisma = basePrisma();
    const service = new AiKnowledgeService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.prepare(
        {
          question: '继续',
          conversationId: 'conversation-1',
          subjectId: 'subject-2',
        },
        user,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CONVERSATION_SCOPE_IMMUTABLE' }),
    });

    prisma.aiConversation.findFirst.mockResolvedValue({
      id: 'conversation-legacy',
      subjectId: null,
      knowledgeMode: null,
      libraries: [],
      libraryChapters: [],
    });
    await expect(
      service.prepare(
        { question: '继续', conversationId: 'conversation-legacy' },
        user,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LEGACY_CONVERSATION_READ_ONLY' }),
    });
  });

  it('fails before embedding when private AI access has been revoked', async () => {
    const prisma = basePrisma({
      knowledgeLibrary: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...sharedLibrary(),
            scope: KnowledgeLibraryScope.PRIVATE,
            ownerId: 'user-1',
            aiEnabled: false,
          },
        ]),
      },
    });
    const embedding = { embedQuestion: jest.fn(), model: 'embedding-3' };
    const service = new AiKnowledgeService(
      prisma as never,
      embedding as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.prepare(
        {
          question: '私有资料问题',
          subjectId: 'subject-1',
          knowledgeMode: KnowledgeConversationMode.PRIVATE,
          libraryIds: ['library-1'],
        },
        user,
      ),
    ).rejects.toThrow('会话知识范围当前不可用');
    expect(embedding.embedQuestion).not.toHaveBeenCalled();
  });

  it('uses a deterministic refusal and never calls the LLM without evidence', async () => {
    const prisma = basePrisma();
    const llm = { model: 'mock', stream: jest.fn() };
    const service = new AiKnowledgeService(
      prisma as never,
      {
        model: 'embedding-3',
        embedQuestion: jest.fn().mockResolvedValue([1, 0]),
      } as never,
      { search: jest.fn().mockResolvedValue([]) } as never,
      llm as never,
    );
    const prepared = await service.prepare(
      {
        question: '没有答案的问题',
        subjectId: 'subject-1',
        knowledgeMode: KnowledgeConversationMode.SHARED,
        libraryIds: ['library-1'],
      },
      user,
    );
    let answer = '';
    for await (const token of service.stream(prepared, user)) answer += token;

    expect(answer).toContain('没有足够证据');
    expect(llm.stream).not.toHaveBeenCalled();
  });

  it('drops polluted Qdrant candidates during MySQL authorization and preserves candidate order', async () => {
    const validA = evidenceRow('chunk-a');
    const validB = evidenceRow('chunk-b');
    const stale = evidenceRow('chunk-stale');
    stale.document.activeVersionId = 'version-new';
    const foreignLibrary = evidenceRow('chunk-foreign-library');
    foreignLibrary.document.libraryId = 'library-2';
    foreignLibrary.document.library = {
      ...foreignLibrary.document.library,
      id: 'library-2',
    };
    const wrongChapter = evidenceRow('chunk-wrong-chapter');
    wrongChapter.node.libraryChapterId = 'chapter-2';
    const hashMismatch = evidenceRow('chunk-hash-mismatch');
    const rows = [
      validA,
      stale,
      foreignLibrary,
      wrongChapter,
      hashMismatch,
      validB,
    ];
    const prisma = basePrisma({
      knowledgeLibraryChapter: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'chapter-1', libraryId: 'library-1', active: true },
        ]),
      },
      knowledgeChunk: { findMany: jest.fn().mockResolvedValue(rows) },
    });
    const candidates = [
      { chunkId: 'chunk-b', contentHash: 'hash-chunk-b', score: 0.95 },
      { chunkId: 'chunk-a', contentHash: 'hash-chunk-a', score: 0.95 },
      {
        chunkId: 'chunk-stale',
        contentHash: 'hash-chunk-stale',
        score: 0.99,
      },
      {
        chunkId: 'chunk-foreign-library',
        contentHash: 'hash-chunk-foreign-library',
        score: 0.99,
      },
      {
        chunkId: 'chunk-wrong-chapter',
        contentHash: 'hash-chunk-wrong-chapter',
        score: 0.99,
      },
      {
        chunkId: 'chunk-hash-mismatch',
        contentHash: 'polluted-hash',
        score: 0.99,
      },
    ];
    const service = new AiKnowledgeService(
      prisma as never,
      {
        model: 'embedding-3',
        dimensions: 2,
        embedQuestion: jest.fn().mockResolvedValue([1, 0]),
      } as never,
      { search: jest.fn().mockResolvedValue(candidates) } as never,
      { model: 'mock', stream: jest.fn() } as never,
    );

    const prepared = await service.prepare(
      {
        question: 'question without lexical tie breakers',
        subjectId: 'subject-1',
        knowledgeMode: KnowledgeConversationMode.SHARED,
        libraryIds: ['library-1'],
        libraryChapterIds: ['chapter-1'],
      },
      user,
    );

    expect(prepared.evidence.map((item) => item.id)).toEqual([
      'chunk-b',
      'chunk-a',
    ]);
    expect(prepared.citations.map((item) => item.documentId)).toEqual([
      'document-chunk-b',
      'document-chunk-a',
    ]);
    expect(prisma.knowledgeImageReference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chunkId: { in: ['chunk-b', 'chunk-a'] } },
      }),
    );
  });
});
