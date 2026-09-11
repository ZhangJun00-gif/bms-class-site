import { createKnowledgeEmbeddingProvider } from './index';

describe('knowledge embedding provider', () => {
  it('creates stable normalized mock vectors and honors cancellation', async () => {
    const provider = createKnowledgeEmbeddingProvider({
      provider: 'mock',
      model: 'embedding-3',
      dimensions: 8,
    });

    const [first, second] = await Promise.all([
      provider.embed(['同一问题']),
      provider.embed(['同一问题']),
    ]);
    expect(first).toEqual(second);
    expect(first[0]).toHaveLength(8);
    expect(
      Math.sqrt(first[0]!.reduce((sum, value) => sum + value ** 2, 0)),
    ).toBeCloseTo(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.embed(['问题'], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('sorts provider rows and retries retryable responses', async () => {
    const fetchImplementation = jest
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const provider = createKnowledgeEmbeddingProvider({
      provider: 'zhipu',
      model: 'embedding-3',
      dimensions: 2,
      baseUrl: 'https://example.test/embeddings',
      apiKey: 'test-only',
      retryDelayMs: 0,
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
    });

    await expect(provider.embed(['a', 'b'])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('rejects count, dimension, and non-finite provider output', async () => {
    const response = (data: unknown) =>
      jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const create = (fetchImplementation: typeof fetch) =>
      createKnowledgeEmbeddingProvider({
        provider: 'zhipu',
        model: 'embedding-3',
        dimensions: 2,
        baseUrl: 'https://example.test/embeddings',
        apiKey: 'test-only',
        fetchImplementation: fetchImplementation as unknown as typeof fetch,
      });

    await expect(create(response([])).embed(['a'])).rejects.toThrow(
      'EMBEDDING_COUNT_MISMATCH',
    );
    await expect(
      create(response([{ index: 0, embedding: [1] }])).embed(['a']),
    ).rejects.toThrow('EMBEDDING_VECTOR_INVALID');
    await expect(
      create(response([{ index: 0, embedding: [Number.NaN, 0] }])).embed([
        'a',
      ]),
    ).rejects.toThrow('EMBEDDING_VECTOR_INVALID');
  });
});
