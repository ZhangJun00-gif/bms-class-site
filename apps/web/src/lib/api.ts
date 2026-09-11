import { createSseParser } from './sse';
import type {
  Citation,
  KnowledgeChatRequest,
  KnowledgeImageAttachment,
} from '../types';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1';
let csrfToken = '';
let unauthorizedHandler: ((context: { path: string }) => void) | null = null;

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}

export function setCsrfToken(value: string) {
  csrfToken = value;
}

export function setUnauthorizedHandler(
  handler: ((context: { path: string }) => void) | null,
) {
  unauthorizedHandler = handler;
}

function notifyUnauthorized(path: string) {
  try {
    unauthorizedHandler?.({ path });
  } catch {
    // 会话清理失败不得覆盖原始 401 错误
  }
}

/** 判断是否为请求中止错误（调用方通常应忽略，不展示错误） */
export function isAbortError(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
}

/** 将任意异常格式化为可展示的中文信息 */
export function formatError(
  caught: unknown,
  fallback = '操作失败，请稍后重试',
): string {
  if (caught instanceof ApiClientError) return caught.message;
  if (isAbortError(caught)) return '请求已取消';
  if (caught instanceof TypeError) {
    // 仅 fetch/XHR 网络层失败视为网络问题；其余 TypeError 多为代码缺陷，不冒充网络错误
    return /failed to fetch|network|load failed/i.test(caught.message)
      ? '网络连接失败，请检查网络后重试'
      : fallback;
  }
  if (caught instanceof Error && caught.message) return caught.message;
  return fallback;
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
  config: { skipUnauthorizedHandler?: boolean } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set('content-type', 'application/json');
  const method = options.method ?? 'GET';
  if (csrfToken && !['GET', 'HEAD'].includes(method))
    headers.set('x-csrf-token', csrfToken);
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string | string[];
      code?: string;
      [key: string]: unknown;
    } | null;
    const message = Array.isArray(payload?.message)
      ? payload.message.join('；')
      : payload?.message;
    if (response.status === 401 && !config.skipUnauthorizedHandler)
      notifyUnauthorized(path);
    throw new ApiClientError(
      message ?? `请求失败 (${response.status})`,
      response.status,
      payload?.code,
      payload ?? undefined,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export interface ApiFileResponse {
  blob: Blob;
  headers: Headers;
}

/** Download an authenticated API response while preserving result metadata headers. */
export async function apiFile(
  path: string,
  options: RequestInit = {},
): Promise<ApiFileResponse> {
  const headers = new Headers(options.headers);
  const method = options.method ?? 'GET';
  if (csrfToken && !['GET', 'HEAD'].includes(method))
    headers.set('x-csrf-token', csrfToken);
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string | string[];
      code?: string;
      [key: string]: unknown;
    } | null;
    const message = Array.isArray(payload?.message)
      ? payload.message.join('；')
      : payload?.message;
    if (response.status === 401) notifyUnauthorized(path);
    throw new ApiClientError(
      message ?? `请求失败 (${response.status})`,
      response.status,
      payload?.code,
      payload ?? undefined,
    );
  }
  return { blob: await response.blob(), headers: response.headers };
}

export interface UploadProgress {
  loaded: number;
  total: number | null;
  percent: number | null;
}

export interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  headers?: HeadersInit;
}

function responseMessage(payload: unknown, fallback: string) {
  const message = (payload as { message?: string | string[] } | null)?.message;
  if (Array.isArray(message)) return message.join('；');
  return message ?? fallback;
}

/** XMLHttpRequest is used only for uploads because fetch has no upload progress. */
export function uploadForm<T>(
  path: string,
  form: FormData,
  options: UploadOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => request.abort();

    request.open('POST', `${API_BASE}${path}`);
    request.withCredentials = true;
    request.responseType = 'json';
    if (csrfToken) request.setRequestHeader('x-csrf-token', csrfToken);
    const extraHeaders = new Headers(options.headers);
    extraHeaders.forEach((value, name) => request.setRequestHeader(name, value));
    request.upload.onprogress = (event) => {
      options.onProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : null,
        percent:
          event.lengthComputable && event.total > 0
            ? Math.min(100, Math.round((event.loaded / event.total) * 100))
            : null,
      });
    };
    request.onload = () => {
      const payload = request.response as unknown;
      if (request.status >= 200 && request.status < 300) {
        finish(() => resolve(payload as T));
        return;
      }
      if (request.status === 401) notifyUnauthorized(path);
      finish(() =>
        reject(
          new ApiClientError(
            responseMessage(payload, `请求失败 (${request.status})`),
            request.status,
          ),
        ),
      );
    };
    request.onerror = () =>
      finish(() => reject(new TypeError('Network request failed')));
    request.onabort = () =>
      finish(() => reject(new DOMException('上传已取消', 'AbortError')));

    if (options.signal?.aborted) {
      finish(() => reject(new DOMException('上传已取消', 'AbortError')));
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    request.send(form);
  });
}

export interface ChatStreamHandlers {
  onMeta: (meta: {
    conversationId: string;
    citations: Citation[];
    images?: KnowledgeImageAttachment[];
  }) => void;
  onToken: (text: string) => void;
  onDone?: () => void;
  signal?: AbortSignal;
}

/**
 * AI 流式问答。SSE 事件通过增量解析器处理跨数据块事件与残余 buffer；
 * 服务端 error 事件与非 JSON 数据不会导致未捕获异常。
 */
export async function streamChat(
  request: KnowledgeChatRequest,
  handlers: ChatStreamHandlers,
): Promise<void> {
  const response = await fetch(`${API_BASE}/ai/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(request),
    signal: handlers.signal ?? null,
  });
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string | string[];
      code?: string;
      [key: string]: unknown;
    } | null;
    const message = Array.isArray(payload?.message)
      ? payload.message.join('；')
      : payload?.message;
    if (response.status === 401) notifyUnauthorized('/ai/chat');
    throw new ApiClientError(
      message ?? 'AI 服务暂不可用',
      response.status,
      payload?.code,
      payload ?? undefined,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let doneReceived = false;
  const parser = createSseParser(({ event, data }) => {
    if (event === 'meta' || event === 'token') {
      try {
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (event === 'meta')
          handlers.onMeta(
            payload as { conversationId: string; citations: Citation[] },
          );
        else if (typeof payload.text === 'string')
          handlers.onToken(payload.text);
      } catch {
        // 非 JSON 数据行：忽略，不中断流
      }
      return;
    }
    if (event === 'done') {
      doneReceived = true;
      handlers.onDone?.();
      return;
    }
    if (event === 'error') {
      let message = 'AI 服务返回错误';
      try {
        const payload = JSON.parse(data) as { message?: string };
        if (payload.message) message = payload.message;
      } catch {
        // 保留默认错误信息
      }
      throw new ApiClientError(message, 502);
    }
  });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.end();
    if (!doneReceived) {
      throw new ApiClientError('AI 回答流意外中断，请重新提问', 502);
    }
  } catch (error) {
    // 服务端 error 事件或读取异常：主动取消底层流，不依赖服务端收尾
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
