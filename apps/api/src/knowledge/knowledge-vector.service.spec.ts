import { KnowledgeConversationMode } from '@prisma/client';
import { KnowledgeVectorService } from './knowledge-vector.service';

describe('KnowledgeVectorService search', () => {
  const originalFetch = globalThis.fetch;
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    process.env.QDRANT_URL = 'http://qdrant.test:6333';
    process.env.QDRANT_API_KEY = 'test-key';
    process.env.QDRANT_COLLECTION_ALIAS = 'knowledge-active';
    process.env.QDRANT_REQUEST_TIMEOUT_MS = '10000';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnvironment };
    jest.restoreAllMocks();
  });

  it('uses subject, explicit libraries, active version, schema, model, chapter, and owner filters', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: [
            {
              id: 'point-1',
              score: 0.82,
              payload: { chunkId: 'chunk-1', contentHash: 'hash-1' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const service = new KnowledgeVectorService();

    await expect(
      service.search([1, 0], {
        subjectId: 'subject-1',
        mode: KnowledgeConversationMode.COMBINED,
        libraryIds: ['shared-1', 'private-1'],
        libraryChapterIds: ['chapter-1'],
        userId: 'user-1',
        embeddingModel: 'embedding-3',
      }),
    ).resolves.toEqual([
      { chunkId: 'chunk-1', contentHash: 'hash-1', score: 0.82 },
    ]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'http://qdrant.test:6333/collections/knowledge-active/points/search',
    );
    const body = JSON.parse(String(init.body));
    expect(body).toEqual(
      expect.objectContaining({
        limit: 30,
        with_payload: ['chunkId', 'contentHash'],
        with_vector: false,
      }),
    );
    expect(body.filter.must).toEqual(
      expect.arrayContaining([
        { key: 'subjectId', match: { value: 'subject-1' } },
        { key: 'libraryId', match: { any: ['shared-1', 'private-1'] } },
        { key: 'active', match: { value: true } },
        { key: 'schemaVersion', match: { value: 'knowledge-v1' } },
        { key: 'embeddingModel', match: { value: 'embedding-3' } },
        { key: 'libraryChapterId', match: { any: ['chapter-1'] } },
      ]),
    );
    expect(body.filter.min_should).toEqual({
      min_count: 1,
      conditions: expect.arrayContaining([
        expect.objectContaining({
          must: [{ key: 'scope', match: { value: 'SHARED' } }],
        }),
        expect.objectContaining({
          must: expect.arrayContaining([
            { key: 'scope', match: { value: 'PRIVATE' } },
            { key: 'ownerId', match: { value: 'user-1' } },
          ]),
        }),
      ]),
    });
  });

  it('fails closed when Qdrant returns polluted payload', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ result: [{ score: 0.9, payload: { content: '泄漏正文' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const service = new KnowledgeVectorService();

    await expect(
      service.search([1, 0], {
        subjectId: 'subject-1',
        mode: KnowledgeConversationMode.SHARED,
        libraryIds: ['library-1'],
        libraryChapterIds: [],
        userId: 'user-1',
        embeddingModel: 'embedding-3',
      }),
    ).rejects.toThrow('向量索引暂时不可用');
  });

  it('propagates caller cancellation instead of converting it to a service error', async () => {
    globalThis.fetch = jest.fn(async (_url, init) => {
      if (init?.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      throw new Error('expected an aborted request');
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    const service = new KnowledgeVectorService();

    await expect(
      service.search(
        [1, 0],
        {
          subjectId: 'subject-1',
          mode: KnowledgeConversationMode.SHARED,
          libraryIds: ['library-1'],
          libraryChapterIds: [],
          userId: 'user-1',
          embeddingModel: 'embedding-3',
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fails readiness when the configured alias drifts to another collection', async () => {
    const service = new KnowledgeVectorService();
    jest.spyOn(service, 'collectionInfo').mockResolvedValue({
      collection: 'knowledge-physical',
      count: 0,
      aliases: [
        {
          alias_name: 'knowledge-active',
          collection_name: 'knowledge-old',
        },
      ],
      info: {
        status: 'green',
        config: { params: { vectors: { size: 1024, distance: 'Cosine' } } },
        payload_schema: Object.fromEntries(
          [
            'active',
            'documentVersionId',
            'schemaVersion',
            'embeddingModel',
            'subjectId',
            'libraryId',
            'scope',
            'ownerId',
            'libraryChapterId',
            'documentId',
          ].map((field) => [field, {}]),
        ),
      },
    } as never);

    await expect(service.readiness()).rejects.toThrow(
      'QDRANT_COLLECTION_NOT_READY',
    );
  });
});
