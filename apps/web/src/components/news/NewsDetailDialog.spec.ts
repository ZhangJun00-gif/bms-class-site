import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewsDetailDialog from './NewsDetailDialog.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import { clearNewsDetailCache } from '../../lib/news';
import { useAuthStore } from '../../stores/auth';
import type { NewsItem, NewsSummary } from '../../types';

const baseSummary: NewsSummary = {
  id: 'n1',
  title: '生理学讲座回顾',
  summary: '摘要一',
  bodyFormat: 'HTML_V1',
  visibility: 'PUBLIC',
  status: 'PUBLISHED',
  publishedAt: '2026-07-01T08:00:00.000Z',
  createdAt: '2026-07-01T08:00:00.000Z',
  author: { id: 'u1', displayName: '作者一' },
};

function detail(overrides: Partial<NewsItem> = {}): NewsItem {
  return { ...baseSummary, body: '<p>正文一</p>', ...overrides };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mountDialog(item: NewsSummary | null) {
  return mount(NewsDetailDialog, {
    props: { item },
    attachTo: document.body,
  });
}

describe('NewsDetailDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clearNewsDetailCache();
    document.body.innerHTML = '';
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows a loading state, then renders the fetched body', async () => {
    let release: ((value: Response) => void) | null = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const wrapper = mountDialog(null);
    await wrapper.setProps({ item: baseSummary });
    await flushPromises();

    expect(wrapper.findComponent(SkeletonBlock).exists()).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/v1/news/n1');

    release!(jsonResponse(detail()));
    await flushPromises();
    expect(wrapper.findComponent(SkeletonBlock).exists()).toBe(false);
    const body = document.body.querySelector('.detail-body');
    expect(body?.innerHTML).toBe('<p>正文一</p>');
    expect(document.body.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-07-01T08:00:00.000Z',
    );
    wrapper.unmount();
  });

  it('uses the members detail endpoint when signed in', async () => {
    const auth = useAuthStore();
    auth.user = {
      id: 'member-1',
      displayName: '成员一',
      role: 'MEMBER',
      status: 'ACTIVE',
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(detail()));
    const wrapper = mountDialog(baseSummary);
    await flushPromises();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/v1/news/members/n1');
    wrapper.unmount();
  });

  it('shows an error with retry and recovers on retry', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ message: '服务异常' }, 500))
      .mockResolvedValueOnce(jsonResponse(detail()));
    const wrapper = mountDialog(baseSummary);
    await flushPromises();

    expect(wrapper.findComponent(ErrorState).exists()).toBe(true);
    expect(document.body.textContent).toContain('服务异常');
    expect(document.body.querySelector('.detail-body')).toBeNull();

    const retry = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('重试加载正文'),
    );
    retry!.click();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('.detail-body')?.innerHTML).toBe(
      '<p>正文一</p>',
    );
    wrapper.unmount();
  });

  it('never shows the previous body after closing or switching items', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/news/n1')) return jsonResponse(detail());
      // n2 的响应刻意延迟，验证加载期间不展示旧正文
      return new Promise<Response>(() => {});
    });
    const wrapper = mountDialog(baseSummary);
    await flushPromises();
    expect(document.body.textContent).toContain('正文一');

    // 关闭：正文清空
    await wrapper.setProps({ item: null });
    await flushPromises();
    expect(document.body.querySelector('.detail-body')).toBeNull();

    // 打开另一条：旧正文不得残留，应显示加载状态
    await wrapper.setProps({
      item: { ...baseSummary, id: 'n2', title: '另一条动态' },
    });
    await flushPromises();
    expect(document.body.textContent).not.toContain('正文一');
    expect(wrapper.findComponent(SkeletonBlock).exists()).toBe(true);
    wrapper.unmount();
  });

});
