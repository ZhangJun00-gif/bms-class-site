import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQuizFilters } from './useQuizFilters';

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const group = {
  subject: '生理学',
  chapters: [],
  types: [
    { label: '单选题', questionCount: 10, randomEligibleCount: 8, pastPaperCount: 2 },
  ],
  pastPaperCount: 2,
};

describe('useQuizFilters shared cache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('dedupes concurrent loads, caches across consumers, and supports forced reload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(
      response({ subjectGroups: [group] }),
    );
    const a = useQuizFilters();
    const b = useQuizFilters();

    // 并发 ensure 只发一次请求
    await Promise.all([a.ensure(), b.ensure()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.groups.value).toHaveLength(1);
    expect(b.groups.value).toHaveLength(1);
    expect(a.loaded.value).toBe(true);

    // 已加载后 ensure 直接复用缓存
    await a.ensure();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // reload 强制重新请求，所有消费方看到同一份新数据
    fetchMock.mockResolvedValue(
      response({ subjectGroups: [] }),
    );
    await b.reload();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a.groups.value).toHaveLength(0);

    // reload 失败时保留错误信息，不冒充成功
    fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch'));
    await a.reload();
    expect(a.error.value).toContain('网络连接失败');
  });
});
