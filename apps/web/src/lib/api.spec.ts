import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  api,
  apiFile,
  formatError,
  isAbortError,
  setCsrfToken,
  setUnauthorizedHandler,
  streamChat,
  uploadForm,
} from './api';

class FakeXmlHttpRequest {
  static instances: FakeXmlHttpRequest[] = [];

  status = 0;
  response: unknown = null;
  responseType = '';
  withCredentials = false;
  method = '';
  url = '';
  body: Document | XMLHttpRequestBodyInit | null = null;
  headers = new Map<string, string>();
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXmlHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
  }

  abort() {
    this.onabort?.();
  }
}

describe('api client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeXmlHttpRequest.instances = [];
    setCsrfToken('');
    setUnauthorizedHandler(null);
  });

  it('adds the CSRF header to mutations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    setCsrfToken('test-token');
    await api('/example', {
      method: 'POST',
      body: JSON.stringify({ value: 1 }),
    });
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get('x-csrf-token')).toBe(
      'test-token',
    );
    expect(request?.credentials).toBe('include');
  });

  it('notifies the session handler on 401 responses', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: '请先登录' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(api('/users')).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledWith({ path: '/users' });
  });

  it('downloads authenticated files and preserves export metadata headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('id,action\n1,login\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'x-result-limit': '5000',
          'x-result-truncated': 'true',
        },
      }),
    );

    const result = await apiFile('/admin/audit-logs.csv');

    const exportedText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(result.blob);
    });
    expect(exportedText).toContain('1,login');
    expect(result.headers.get('x-result-limit')).toBe('5000');
    expect(result.headers.get('x-result-truncated')).toBe('true');
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('include');
  });

  it('keeps network failures distinct from server errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('failed to fetch'),
    );
    let networkError: unknown;
    try {
      await api('/health');
    } catch (caught) {
      networkError = caught;
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ message: '服务异常' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    let serverError: unknown;
    try {
      await api('/health');
    } catch (caught) {
      serverError = caught;
    }

    expect(formatError(networkError)).toBe('网络连接失败，请检查网络后重试');
    expect(serverError).toBeInstanceOf(ApiClientError);
    expect(serverError).toMatchObject({ status: 500, message: '服务异常' });
  });

  it('uploads FormData with cookies and CSRF without setting multipart content-type', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
    setCsrfToken('upload-token');
    const form = new FormData();
    form.append('file', new File(['pdf'], 'notes.pdf', { type: 'application/pdf' }));
    const onProgress = vi.fn();
    const promise = uploadForm<{ id: string }>('/knowledge/files', form, {
      onProgress,
    });
    const request = FakeXmlHttpRequest.instances[0]!;

    request.upload.onprogress?.({
      loaded: 25,
      total: 100,
      lengthComputable: true,
    } as ProgressEvent);
    request.status = 201;
    request.response = { id: 'document-1' };
    request.onload?.();

    await expect(promise).resolves.toEqual({ id: 'document-1' });
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/v1/knowledge/files');
    expect(request.withCredentials).toBe(true);
    expect(request.body).toBe(form);
    expect(request.headers.get('x-csrf-token')).toBe('upload-token');
    expect(request.headers.has('content-type')).toBe(false);
    expect(onProgress).toHaveBeenCalledWith({
      loaded: 25,
      total: 100,
      percent: 25,
    });
  });

  it('reports indeterminate progress when total upload length is unavailable', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
    const onProgress = vi.fn();
    void uploadForm('/knowledge/files', new FormData(), { onProgress });
    const request = FakeXmlHttpRequest.instances[0]!;

    request.upload.onprogress?.({
      loaded: 12,
      total: 0,
      lengthComputable: false,
    } as ProgressEvent);

    expect(onProgress).toHaveBeenCalledWith({
      loaded: 12,
      total: null,
      percent: null,
    });
  });

  it('distinguishes cancellation, network errors, 401 and 413 upload responses', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);

    const controller = new AbortController();
    const cancelled = uploadForm('/knowledge/files', new FormData(), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    const network = uploadForm('/knowledge/files', new FormData());
    FakeXmlHttpRequest.instances[1]!.onerror?.();
    await expect(network).rejects.toBeInstanceOf(TypeError);

    const unauthorizedUpload = uploadForm('/knowledge/files', new FormData());
    const unauthorizedRequest = FakeXmlHttpRequest.instances[2]!;
    unauthorizedRequest.status = 401;
    unauthorizedRequest.response = { message: '请先登录' };
    unauthorizedRequest.onload?.();
    await expect(unauthorizedUpload).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledWith({ path: '/knowledge/files' });

    const tooLarge = uploadForm('/knowledge/files', new FormData());
    const tooLargeRequest = FakeXmlHttpRequest.instances[3]!;
    tooLargeRequest.status = 413;
    tooLargeRequest.response = { message: '文件超过 200 MiB 限制' };
    tooLargeRequest.onload?.();
    await expect(tooLarge).rejects.toMatchObject({
      status: 413,
      message: '文件超过 200 MiB 限制',
    });
  });

  it('sends discriminated new and continued AI requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('event: done\ndata: {}\n\n'),
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    );
    const handlers = { onMeta: vi.fn(), onToken: vi.fn() };

    await streamChat({
      question: '问题一',
      subjectId: 'subject/one',
      knowledgeMode: 'COMBINED',
      libraryIds: ['library-shared', 'library-private'],
      libraryChapterIds: ['chapter-1'],
    }, handlers);
    await streamChat({ question: '问题二', conversationId: 'conversation-1' }, handlers);

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      question: '问题一',
      subjectId: 'subject/one',
      knowledgeMode: 'COMBINED',
      libraryIds: ['library-shared', 'library-private'],
      libraryChapterIds: ['chapter-1'],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({
      question: '问题二',
      conversationId: 'conversation-1',
    });
  });

  it('formats aborts and code-bug TypeErrors without masking them as network failures', () => {
    expect(formatError(new DOMException('aborted', 'AbortError'))).toBe(
      '请求已取消',
    );
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new TypeError('failed to fetch'))).toBe(false);
    expect(
      formatError(
        new TypeError("Cannot read properties of undefined (reading 'id')"),
        '操作失败',
      ),
    ).toBe('操作失败');
    expect(formatError(new TypeError('Network request failed'))).toBe(
      '网络连接失败，请检查网络后重试',
    );
  });

  it('cancels the underlying stream when the server sends an error event', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: error\ndata: {"message":"模型失败"}\n\n'),
        );
        // 不关闭流，模拟服务端保持连接
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    await expect(
      streamChat({
        question: '问题',
        subjectId: 'subject-1',
        knowledgeMode: 'SHARED',
        libraryIds: ['library-1'],
      }, {
        onMeta: vi.fn(),
        onToken: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 502, message: '模型失败' });
    expect(cancelled).toBe(true);
  });

  it('rejects an EOF that arrives without a persisted done event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('event: token\ndata: {"text":"残缺"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    await expect(
      streamChat(
        { question: '问题', conversationId: 'conversation-1' },
        { onMeta: vi.fn(), onToken: vi.fn() },
      ),
    ).rejects.toMatchObject({
      status: 502,
      message: 'AI 回答流意外中断，请重新提问',
    });
  });
});
