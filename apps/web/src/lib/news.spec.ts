import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearNewsDetailCache,
  fetchNewsDetail,
  fetchNewsSummaries,
  invalidateNewsDetail,
} from './news';

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const item = {
  id: 'news-1',
  title: '动态标题',
  summary: '摘要',
  body: '<p>正文</p>',
  bodyFormat: 'HTML_V1',
  visibility: 'PUBLIC',
  status: 'PUBLISHED',
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T01:00:00.000Z',
  publishedAt: '2026-07-22T01:00:00.000Z',
  author: { id: 'admin-1', displayName: '管理员' },
};

describe('news helpers', () => {
  afterEach(() => {
    clearNewsDetailCache();
    vi.restoreAllMocks();
  });

  it('selects the public or member endpoint for summaries and details', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        response({ items: [], total: 0, page: 1, pageSize: 10 }),
      );
    await fetchNewsSummaries(false, 2, 10);
    await fetchNewsSummaries(true, 1, 10);
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls[0]).toBe('/api/v1/news?page=2&pageSize=10&includeBody=false');
    expect(urls[1]).toBe(
      '/api/v1/news/members?page=1&pageSize=10&includeBody=false',
    );

    fetchMock.mockImplementation(async () => response(item));
    await fetchNewsDetail(true, 'news-1');
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      '/api/v1/news/members/news-1',
    );
  });

  it('serves repeated detail reads from cache and refetches after invalidation', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response(item));
    await fetchNewsDetail(false, 'news-1');
    await fetchNewsDetail(false, 'news-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invalidateNewsDetail('news-1');
    await fetchNewsDetail(false, 'news-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not repopulate a cleared cache with a late in-flight response', async () => {
    let resolveRequest!: (value: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Promise<Response>((resolve) => (resolveRequest = resolve)),
    );
    const pending = fetchNewsDetail(true, 'news-1');
    clearNewsDetailCache();
    resolveRequest(response(item));
    await pending;

    // 缓存未被迟到响应重写：再次读取会发起新请求
    fetchMock.mockResolvedValue(response(item));
    await fetchNewsDetail(true, 'news-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
