import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewsView from './NewsView.vue';
import NewsDetailDialog from '../components/news/NewsDetailDialog.vue';
import { useAuthStore } from '../stores/auth';
import type { NewsSummary } from '../types';

function summary(overrides: Partial<NewsSummary> = {}): NewsSummary {
  return {
    id: 'n1',
    title: '生理学讲座回顾',
    summary: '摘要一',
    bodyFormat: 'HTML_V1',
    visibility: 'PUBLIC',
    status: 'PUBLISHED',
    publishedAt: '2026-07-01T08:00:00.000Z',
    createdAt: '2026-07-01T08:00:00.000Z',
    author: { id: 'u1', displayName: '作者一' },
    ...overrides,
  };
}

function pageResponse(items: NewsSummary[], total = items.length, page = 1) {
  return new Response(
    JSON.stringify({ items, total, page, pageSize: 10 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function mountView() {
  return mount(NewsView, {
    global: {
      stubs: {
        RouterLink: RouterLinkStub,
        NewsDetailDialog: true,
      },
    },
  });
}

describe('NewsView server pagination', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it('requests the public summary endpoint without bodies when anonymous', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(pageResponse([summary()]));
    mountView();
    await flushPromises();
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/news?');
    expect(url).not.toContain('/news/members');
    expect(url).toContain('page=1');
    expect(url).toContain('pageSize=10');
    expect(url).toContain('includeBody=false');
  });

  it('requests the members endpoint when signed in', async () => {
    const auth = useAuthStore();
    auth.user = {
      id: 'member-1',
      displayName: '成员一',
      role: 'MEMBER',
      status: 'ACTIVE',
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(pageResponse([summary()]));
    mountView();
    await flushPromises();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/news/members?');
  });

  it('refetches with the new page when paginating and keeps server total', async () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      summary({ id: `n${index + 1}`, title: `动态 ${index + 1}` }),
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = new URL(String(input), 'http://localhost');
        const page = Number(url.searchParams.get('page') ?? '1');
        if (page === 1) return pageResponse(items, 25, 1);
        return pageResponse(
          [summary({ id: 'n11', title: '第十一动态' })],
          25,
          page,
        );
      });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.findAll('.news-item')).toHaveLength(10);

    await wrapper.get('[aria-label="下一页"]').trigger('click');
    await flushPromises();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('page=2'))).toBe(true);
    expect(wrapper.text()).toContain('第十一动态');
    // 服务端 total=25 → 3 页
    expect(wrapper.get('.pagination [aria-current="page"]').text()).toBe('2');
  });

  it('keeps the current list rendered while the next page loads', async () => {
    const items = [summary()];
    let release: ((value: Response) => void) | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) => {
        const url = new URL(String(input), 'http://localhost');
        if ((url.searchParams.get('page') ?? '1') === '1')
          return pageResponse(items, 25, 1);
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      },
    );
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('生理学讲座回顾');

    await wrapper.get('[aria-label="下一页"]').trigger('click');
    await flushPromises();
    // 翻页请求进行中：旧列表保持渲染，避免页面跳动
    expect(wrapper.text()).toContain('生理学讲座回顾');
    expect(wrapper.get('.list').attributes('aria-busy')).toBe('true');

    release!(pageResponse([summary({ id: 'n11', title: '第二页动态' })], 25, 2));
    await flushPromises();
    expect(wrapper.text()).toContain('第二页动态');
  });

  it('passes the summary to the detail dialog on click and keyboard', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      pageResponse([
        summary(),
        summary({ id: 'n2', title: '解剖学实验安排', visibility: 'MEMBERS' }),
      ]),
    );
    const wrapper = mountView();
    await flushPromises();
    const dialog = wrapper.findComponent(NewsDetailDialog);

    await wrapper.findAll('.news-item')[0]!.trigger('click');
    expect(dialog.props('item')).toMatchObject({ id: 'n1' });
    expect(dialog.props('item')).not.toHaveProperty('body');

    const second = wrapper.findAll('.news-item')[1]!;
    await second.trigger('keydown', { key: 'Enter' });
    expect(dialog.props('item')).toMatchObject({ id: 'n2' });
    await second.trigger('keydown', { key: ' ' });
    expect(dialog.props('item')).toMatchObject({ id: 'n2' });
  });
});
