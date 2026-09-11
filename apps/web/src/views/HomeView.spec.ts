import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomeView from './HomeView.vue';
import NewsDetailDialog from '../components/news/NewsDetailDialog.vue';
import type { NewsSummary } from '../types';

// 摘要响应不含 body：首页不得依赖列表正文
const newsSummaries: NewsSummary[] = [
  {
    id: 'n1',
    title: '第一条动态',
    summary: '摘要一',
    bodyFormat: 'HTML_V1',
    visibility: 'PUBLIC',
    status: 'PUBLISHED',
    publishedAt: '2026-07-01T08:00:00.000Z',
    createdAt: '2026-07-01T08:00:00.000Z',
    author: { id: 'u1', displayName: '作者一' },
  },
  {
    id: 'n2',
    title: '第二条动态',
    summary: '摘要二',
    bodyFormat: 'HTML_V1',
    visibility: 'PUBLIC',
    status: 'PUBLISHED',
    publishedAt: '2026-07-02T08:00:00.000Z',
    createdAt: '2026-07-02T08:00:00.000Z',
    author: { id: 'u2', displayName: '作者二' },
  },
];

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          items: newsSummaries,
          total: 8,
          page: 1,
          pageSize: 3,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
  );
}

function mountView() {
  return mount(HomeView, {
    global: {
      stubs: {
        RouterLink: RouterLinkStub,
        ParticleCanvas: true,
        NewsDetailDialog: true,
      },
    },
  });
}

describe('HomeView news cards', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requests only three public summaries without bodies', async () => {
    const fetchMock = mockFetch();
    mountView();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/news?');
    expect(url).toContain('page=1');
    expect(url).toContain('pageSize=3');
    expect(url).toContain('includeBody=false');
  });

  it('opens the detail dialog with the summary when a card is clicked', async () => {
    mockFetch();
    const wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('.news-card')[0]!.trigger('click');
    const dialog = wrapper.findComponent(NewsDetailDialog);
    expect(dialog.props('item')).toMatchObject({
      id: 'n1',
      title: '第一条动态',
    });
    expect(dialog.props('item')).not.toHaveProperty('body');
  });

  it('opens the dialog with Enter or Space for keyboard users', async () => {
    mockFetch();
    const wrapper = mountView();
    await flushPromises();
    const dialog = wrapper.findComponent(NewsDetailDialog);
    const second = wrapper.findAll('.news-card')[1]!;
    await second.trigger('keydown', { key: 'Enter' });
    expect(dialog.props('item')).toMatchObject({ id: 'n2' });
    await second.trigger('keydown', { key: ' ' });
    expect(dialog.props('item')).toMatchObject({ id: 'n2' });
  });
});
