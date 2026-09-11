import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth';
import type { ForumThread, User } from '../../types';
import ThreadDetail from './ThreadDetail.vue';

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));

const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useToast', () => ({
  useToast: () => ({
    toasts: [],
    dismiss: vi.fn(),
    success: toastSuccessMock,
    error: toastErrorMock,
    info: vi.fn(),
  }),
}));

const thread: ForumThread = {
  id: 'thread-1',
  title: '需要审核的主题',
  body: '<p>主题正文</p>',
  pinned: false,
  locked: false,
  hidden: false,
  authorId: 'author-1',
  createdAt: '2026-07-20T00:00:00.000Z',
  author: { id: 'author-1', displayName: '作者' },
  posts: [
    {
      id: 'post-1',
      threadId: 'thread-1',
      body: '<p>回复正文</p>',
      authorId: 'author-2',
      createdAt: '2026-07-20T01:00:00.000Z',
      author: { id: 'author-2', displayName: '回复者' },
    },
  ],
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mountDetail(user: User) {
  const auth = useAuthStore();
  auth.user = user;
  return mount(ThreadDetail, {
    props: { threadId: thread.id },
    global: {
      stubs: {
        ThreadComposerDialog: true,
        ReportDialog: true,
      },
    },
  });
}

describe('ThreadDetail moderation permissions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('limits a MEMBER to reporting content they do not own', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(thread));
    const wrapper = mountDetail({
      id: 'member-1',
      displayName: '成员',
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    await flushPromises();

    const actions = wrapper
      .findAll('.action-link')
      .map((button) => button.text());
    expect(actions.filter((text) => text === '举报')).toHaveLength(2);
    expect(actions).not.toContain('隐藏');
    expect(actions).not.toContain('编辑');
    expect(actions).not.toContain('删除');
  });

  it('lets an EDITOR manage other users content and hide the thread after confirmation', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, options) => {
        const path = String(input).replace('/api/v1', '');
        if (path === '/forum/threads/thread-1' && !options?.method)
          return response(thread);
        if (
          path === '/forum/threads/thread-1/moderation' &&
          options?.method === 'PATCH'
        ) {
          return response({ ...thread, hidden: true });
        }
        throw new Error(
          `unexpected request ${options?.method ?? 'GET'} ${path}`,
        );
      });
    const wrapper = mountDetail({
      id: 'editor-1',
      displayName: '编辑',
      role: 'EDITOR',
      status: 'ACTIVE',
    });
    await flushPromises();

    const actions = wrapper
      .findAll('.action-link')
      .map((button) => button.text());
    expect(actions.filter((text) => text === '编辑')).toHaveLength(2);
    expect(actions.filter((text) => text === '删除')).toHaveLength(2);
    expect(actions).toContain('隐藏');
    expect(actions).not.toContain('举报');

    await wrapper
      .findAll('.action-link')
      .find((button) => button.text() === '隐藏')!
      .trigger('click');
    await flushPromises();
    expect(confirmMock).toHaveBeenCalled();
    const patchCall = fetchMock.mock.calls.find(
      ([, options]) => options?.method === 'PATCH',
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ hidden: true });
    expect(wrapper.emitted('deleted')).toHaveLength(1);
  });
});

describe('ThreadDetail reply flow', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('does not report a send failure when the reply was saved but the refresh failed', async () => {
    let getCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const path = String(input).replace('/api/v1', '');
      if (path === '/forum/threads/thread-1/posts' && options?.method === 'POST')
        return response({ id: 'post-2' }, 201);
      getCount += 1;
      // 首次加载成功，写后刷新失败
      return getCount === 1
        ? response(thread)
        : response({ message: '服务暂时不可用' }, 500);
    });
    const wrapper = mountDetail({
      id: 'member-1',
      displayName: '成员',
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    await flushPromises();

    await wrapper.get('#reply-body').setValue('这是一条新回复');
    await wrapper.get('.reply-form').trigger('submit');
    await flushPromises();

    expect(wrapper.find('.reply-form .alert.error').exists()).toBe(false);
    expect(
      (wrapper.get('#reply-body').element as HTMLTextAreaElement).value,
    ).toBe('');
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('内容已保存'),
    );
    wrapper.unmount();
  });

  it('keeps the draft and shows the error when the reply itself fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const path = String(input).replace('/api/v1', '');
      if (path === '/forum/threads/thread-1/posts' && options?.method === 'POST')
        return response({ message: '回复过于频繁' }, 429);
      return response(thread);
    });
    const wrapper = mountDetail({
      id: 'member-1',
      displayName: '成员',
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    await flushPromises();

    await wrapper.get('#reply-body').setValue('这是一条新回复');
    await wrapper.get('.reply-form').trigger('submit');
    await flushPromises();

    expect(wrapper.get('.reply-form .alert.error').text()).toContain(
      '回复过于频繁',
    );
    expect(
      (wrapper.get('#reply-body').element as HTMLTextAreaElement).value,
    ).toBe('这是一条新回复');
    wrapper.unmount();
  });
});
