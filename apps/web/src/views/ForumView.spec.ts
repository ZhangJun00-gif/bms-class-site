import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ForumView from './ForumView.vue';

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function thread(id: string, title: string) {
  return {
    id,
    title,
    body: '<p>正文</p>',
    pinned: false,
    locked: false,
    hidden: false,
    authorId: 'author-1',
    createdAt: '2026-07-20T00:00:00.000Z',
    author: { id: 'author-1', displayName: '作者' },
    _count: { posts: 2 },
  };
}

function mountView() {
  return mount(ForumView, {
    global: {
      stubs: {
        RouterLink: RouterLinkStub,
        PageHeader: {
          template: '<div><slot name="breadcrumb"/><slot name="actions"/></div>',
        },
        ThreadList: true,
        ThreadDetail: true,
        ThreadComposerDialog: true,
        ForumReportsDialog: true,
      },
    },
  });
}

describe('ForumView pagination', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it('clamps an out-of-range page after the total shrinks', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('page=2'))
          // 第 2 页时 total 收缩到只剩 1 页
          return response({ items: [], total: 5, page: 2, pageSize: 20 });
        return response({
          items: [thread('t1', '主题一')],
          total: 30,
          page: 1,
          pageSize: 20,
        });
      });
    const wrapper = mountView();
    await flushPromises();
    wrapper.findComponent({ name: 'PaginationControl' }).vm.$emit('update:page', 2);
    await flushPromises();

    // pageCount 收缩为 1 后自动回退并重新请求第 1 页
    await flushPromises();
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.at(-1)).toContain('page=1');
    wrapper.unmount();
  });

  it('keeps the stable page and shows an error when pagination fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        items: [thread('t1', '主题一')],
        total: 30,
        page: 1,
        pageSize: 20,
      }))
      .mockResolvedValueOnce(response({ message: '论坛暂时不可用' }, 503));
    const wrapper = mountView();
    await flushPromises();
    const pagination = wrapper.findComponent({ name: 'PaginationControl' });

    pagination.vm.$emit('update:page', 2);
    await flushPromises();

    expect(pagination.props('page')).toBe(1);
    expect(wrapper.get('[role="alert"]').text()).toContain('论坛暂时不可用');
    wrapper.unmount();
  });

  it('keeps the previous stable page when the total-shrink correction fails', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        items: [thread('t1', '主题一')],
        total: 30,
        page: 1,
        pageSize: 20,
      }))
      .mockResolvedValueOnce(response({
        items: [],
        total: 5,
        page: 2,
        pageSize: 20,
      }))
      .mockResolvedValueOnce(response({ message: '纠偏请求失败' }, 503));
    const wrapper = mountView();
    await flushPromises();
    const pagination = wrapper.findComponent({ name: 'PaginationControl' });

    pagination.vm.$emit('update:page', 2);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]![0])).toContain('page=1');
    expect(pagination.props('page')).toBe(1);
    expect(wrapper.get('[role="alert"]').text()).toContain('纠偏请求失败');
    wrapper.unmount();
  });
});
