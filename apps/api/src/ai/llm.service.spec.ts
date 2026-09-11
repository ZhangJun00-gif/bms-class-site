import { LlmService, type RetrievedSource } from './llm.service';

const sources: RetrievedSource[] = [
  {
    id: 'chunk-1',
    libraryName: '组织学知识库',
    breadcrumb: '肝脏 > 肝小叶',
    content: '肝小叶由中央静脉及周围肝板构成。',
  },
];

describe('LlmService upstream SSE', () => {
  const originalEnvironment = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.LLM_PROVIDER = 'deepseek';
    process.env.LLM_BASE_URL = 'https://model.example.test';
    process.env.LLM_API_KEY = 'test-only';
    process.env.LLM_MODEL = 'deepseek-test';
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('forwards content deltas and never exposes reasoning_content', async () => {
    const stream = [
      'data: {"choices":[{"delta":{"reasoning_content":"内部思考"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"依据[1]"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    ) as unknown as typeof fetch;
    const service = new LlmService();
    let answer = '';

    for await (const token of service.stream('肝小叶是什么', sources)) {
      answer += token;
    }

    expect(answer).toBe('依据[1]');
    expect(answer).not.toContain('内部思考');
    const request = JSON.parse(
      String((globalThis.fetch as jest.Mock).mock.calls[0]![1]!.body),
    );
    expect(request.stream).toBe(true);
  });

  it('rejects a truncated upstream stream without persisting it as complete', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response(
        'data: {"choices":[{"delta":{"content":"残缺回答"}}]}\n\n',
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const service = new LlmService();
    const consume = async () => {
      let answer = '';
      for await (const token of service.stream('问题', sources)) answer += token;
      return answer;
    };

    await expect(consume()).rejects.toThrow('模型流意外中断');
  });

  it('propagates caller cancellation', async () => {
    globalThis.fetch = jest.fn(async (_url, init) => {
      if (init?.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      throw new Error('expected cancellation');
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    const service = new LlmService();
    const consume = async () => {
      for await (const _token of service.stream(
        '问题',
        sources,
        controller.signal,
      )) {
        // no-op
      }
    };

    await expect(consume()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
