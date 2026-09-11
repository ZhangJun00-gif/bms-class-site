import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h, provide } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminNews from './AdminNews.vue';
import {
  adminTabGuardKey,
  type AdminTabGuardRegistry,
} from '../../lib/adminTabGuard';
import { useAuthStore } from '../../stores/auth';
import type { NewsItem, NewsSummary } from '../../types';

const confirmMock = vi.hoisted(() => vi.fn());
const leaveGuard = vi.hoisted(
  () => ({ current: null }) as { current: null | (() => unknown) },
);
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>();
  return {
    ...actual,
    onBeforeRouteLeave: (guard: () => unknown) => {
      leaveGuard.current = guard;
    },
  };
});
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));

const NEW_VERSION = '2026-07-21T00:00:00.000Z';

function record(overrides: Partial<NewsSummary>): NewsSummary {
  return {
    id: 'x',
    title: '未命名',
    summary: '摘要',
    bodyFormat: 'HTML_V1',
    visibility: 'MEMBERS',
    status: 'DRAFT',
    publishedAt: null,
    createdAt: '2026-07-20T01:00:00.000Z',
    updatedAt: '2026-07-20T02:00:00.000Z',
    author: { id: 'editor-1', displayName: '编辑一' },
    ...overrides,
  };
}

const published = record({
  id: 'pub-1',
  title: '已发布动态',
  summary: '已发布摘要',
  status: 'PUBLISHED',
  visibility: 'PUBLIC',
  publishedAt: '2026-07-20T01:30:00.000Z',
  updatedAt: '2026-07-20T02:00:00.000Z',
});
const draft = record({
  id: 'draft-1',
  title: '草稿动态',
  summary: '草稿摘要',
  status: 'DRAFT',
  updatedAt: '2026-07-20T04:00:00.000Z',
});
const archived = record({
  id: 'arch-1',
  title: '归档动态',
  summary: '归档摘要',
  status: 'ARCHIVED',
  updatedAt: '2026-07-19T06:00:00.000Z',
});

const details: Record<string, NewsItem> = {
  'pub-1': { ...published, body: '<p>已发布正文</p>' },
  'draft-1': { ...draft, body: '<p>草稿正文</p>' },
  'arch-1': { ...archived, body: '<p>归档正文</p>' },
};

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface FetchOptions {
  items?: NewsSummary[];
  total?: number;
  handle?: (call: Call) => Response | null;
}

function setupFetch(options: FetchOptions = {}) {
  const calls: Call[] = [];
  const items = options.items ?? [published, draft, archived];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const call: Call = {
      method,
      url,
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined,
    };
    calls.push(call);
    const custom = options.handle?.(call);
    if (custom) return custom;

    const parsed = new URL(url, 'http://localhost');
    const path = parsed.pathname.replace('/api/v1', '');
    if (path === '/news/manage' && method === 'GET') {
      const status = parsed.searchParams.get('status');
      const filtered = status
        ? items.filter((item) => item.status === status)
        : items;
      return response({
        items: filtered,
        total: options.total ?? filtered.length,
        page: Number(parsed.searchParams.get('page') ?? '1'),
        pageSize: 20,
      });
    }
    const manageDetail = path.match(/^\/news\/manage\/(.+)$/);
    if (manageDetail && method === 'GET')
      return response(details[manageDetail[1]!]);
    if (path === '/news' && method === 'POST')
      return response({
        ...details['draft-1']!,
        id: 'new-1',
        status: call.body?.status ?? 'DRAFT',
        updatedAt: NEW_VERSION,
      });
    const actionMatch = path.match(/^\/news\/(.+)\/(archive|restore)$/);
    if (actionMatch && method === 'PATCH')
      return response({ id: actionMatch[1], updatedAt: NEW_VERSION });
    const itemMatch = path.match(/^\/news\/(.+)$/);
    if (itemMatch && method === 'PATCH')
      return response({
        ...details[itemMatch[1]!],
        ...call.body,
        id: itemMatch[1],
        updatedAt: NEW_VERSION,
      });
    if (itemMatch && method === 'DELETE')
      return response({ id: itemMatch[1], deleted: true });
    throw new Error(`unexpected request ${method} ${url}`);
  });
  return calls;
}

const editorStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<textarea class="rich-editor-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};

function mountNews() {
  const wrapper = mount(AdminNews, {
    global: { stubs: { RichTextEditor: editorStub } },
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

const mountedWrappers: Array<{ unmount: () => void }> = [];

async function openRecordByTitle(wrapper: unknown, title: string) {
  const button = (
    wrapper as ReturnType<typeof mountNews>
  )
    .findAll('.record-item')
    .find((item) => item.text().includes(title));
  expect(button, `record ${title}`).toBeTruthy();
  await button!.trigger('click');
  await flushPromises();
}

describe('AdminNews manage workspace', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const auth = useAuthStore();
    auth.user = {
      id: 'editor-1',
      displayName: '编辑一',
      role: 'EDITOR',
      status: 'ACTIVE',
    };
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    leaveGuard.current = null;
  });
  afterEach(() => {
    while (mountedWrappers.length) mountedWrappers.pop()!.unmount();
    vi.restoreAllMocks();
  });

  it('loads the manage list with pagination params and shows author, status and visibility', async () => {
    const calls = setupFetch();
    const wrapper = mountNews();
    await flushPromises();

    const first = calls[0]!;
    expect(first.url).toContain('/news/manage?');
    expect(first.url).toContain('page=1');
    expect(first.url).toContain('pageSize=20');
    expect(first.url).not.toContain('status=');

    const items = wrapper.findAll('.record-item');
    expect(items).toHaveLength(3);
    expect(items[0]!.text()).toContain('已发布动态');
    expect(items[0]!.text()).toContain('编辑一');
    expect(items[0]!.text()).toContain('已发布');
    expect(items[1]!.text()).toContain('成员可见');
    expect(items[2]!.text()).toContain('已归档');
    expect(items[0]!.find('time').attributes('datetime')).toBe(
      '2026-07-20T02:00:00.000Z',
    );
  });

  it('applies the status filter and server pagination', async () => {
    const calls = setupFetch({ total: 45 });
    const wrapper = mountNews();
    await flushPromises();

    await wrapper
      .findAll('.status-tab')
      .find((tab) => tab.text() === '草稿')!
      .trigger('click');
    await flushPromises();
    expect(
      calls.some(
        (call) =>
          call.url.includes('/news/manage') &&
          call.url.includes('status=DRAFT'),
      ),
    ).toBe(true);

    // total=45 → 3 页，翻页重新请求
    await wrapper.get('[aria-label="下一页"]').trigger('click');
    await flushPromises();
    expect(
      calls.some(
        (call) =>
          call.url.includes('/news/manage') && call.url.includes('page=2'),
      ),
    ).toBe(true);
  });

  it('keeps the stable page and list when total-shrink correction fails', async () => {
    let manageRequests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.replace('/api/v1', '') !== '/news/manage') {
        throw new Error(`unexpected request ${String(input)}`);
      }
      manageRequests += 1;
      if (manageRequests === 1) {
        return response({ items: [published], total: 45, page: 1, pageSize: 20 });
      }
      if (manageRequests === 2) {
        return response({ items: [], total: 5, page: 2, pageSize: 20 });
      }
      return response({ message: '纠偏请求失败' }, 503);
    });
    const wrapper = mountNews();
    await flushPromises();

    await wrapper.get('[aria-label="下一页"]').trigger('click');
    await flushPromises();

    expect(manageRequests).toBe(3);
    expect(wrapper.find('.pagination-page.active').text()).toBe('1');
    expect(wrapper.text()).toContain('已发布动态');
    expect(wrapper.get('[role="alert"]').text()).toContain('纠偏请求失败');
  });

  it('ignores a late list response after a newer request commits', async () => {
    const pageTwo = deferred<Response>();
    const pageThree = deferred<Response>();
    let manageRequests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.replace('/api/v1', '') !== '/news/manage') {
        throw new Error(`unexpected request ${String(input)}`);
      }
      manageRequests += 1;
      if (manageRequests === 1) {
        return response({ items: [published], total: 60, page: 1, pageSize: 20 });
      }
      if (url.searchParams.get('page') === '2') return pageTwo.promise;
      if (url.searchParams.get('page') === '3') return pageThree.promise;
      throw new Error(`unexpected request ${String(input)}`);
    });
    const wrapper = mountNews();
    await flushPromises();

    const news = wrapper.vm as unknown as {
      reloadManage: (page: number, navigate: boolean) => Promise<unknown>;
    };
    const oldRequest = news.reloadManage(2, true);
    const latestRequest = news.reloadManage(3, true);
    pageThree.resolve(response({
      items: [{ ...archived, id: 'page-3', title: '第三页动态' }],
      total: 60,
      page: 3,
      pageSize: 20,
    }));
    await latestRequest;
    pageTwo.resolve(response({
      items: [{ ...draft, id: 'page-2', title: '迟到的第二页动态' }],
      total: 60,
      page: 2,
      pageSize: 20,
    }));
    await oldRequest;
    await flushPromises();

    expect(wrapper.find('.pagination-page.active').text()).toBe('3');
    expect(wrapper.text()).toContain('第三页动态');
    expect(wrapper.text()).not.toContain('迟到的第二页动态');
  });

  it('corrects a multi-page total shrink before committing the list', async () => {
    const urls: string[] = [];
    let shrinking = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.replace('/api/v1', '') !== '/news/manage') {
        throw new Error(`unexpected request ${String(input)}`);
      }
      urls.push(String(input));
      const requestedPage = Number(url.searchParams.get('page'));
      if (!shrinking) {
        return response({ items: [published], total: 61, page: requestedPage, pageSize: 20 });
      }
      if (requestedPage === 4) {
        return response({ items: [], total: 5, page: 4, pageSize: 20 });
      }
      return response({
        items: [{ ...draft, id: 'remaining', title: '收缩后动态' }],
        total: 5,
        page: 1,
        pageSize: 20,
      });
    });
    const wrapper = mountNews();
    await flushPromises();
    await wrapper
      .findAll('.pagination-page')
      .find((button) => button.text() === '4')!
      .trigger('click');
    await flushPromises();

    shrinking = true;
    await wrapper.get('[aria-label="刷新动态列表"]').trigger('click');
    await flushPromises();

    expect(urls.at(-2)).toContain('page=4');
    expect(urls.at(-1)).toContain('page=1');
    expect(wrapper.find('.pagination-page.active').exists()).toBe(false);
    expect(wrapper.text()).toContain('收缩后动态');
    expect(wrapper.text()).not.toContain('暂无动态');
  });

  it('cancels an in-flight detail when the filter changes without leaving the list busy', async () => {
    let resolveDetail!: (value: Response) => void;
    let detailSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.replace('/api/v1', '');
      if (path === '/news/manage/pub-1') {
        detailSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveDetail = resolve;
        });
      }
      if (path === '/news/manage') {
        const filtered = url.searchParams.get('status') === 'DRAFT'
          ? [draft]
          : [published, draft, archived];
        return response({
          items: filtered,
          total: filtered.length,
          page: 1,
          pageSize: 20,
        });
      }
      throw new Error(`unexpected request ${String(input)}`);
    });
    const wrapper = mountNews();
    await flushPromises();

    await wrapper.findAll('.record-item')[0]!.trigger('click');
    await Promise.resolve();
    await wrapper
      .findAll('.status-tab')
      .find((tab) => tab.text() === '草稿')!
      .trigger('click');
    await flushPromises();

    expect(detailSignal?.aborted).toBe(true);
    expect(wrapper.findAll('.record-item')).toHaveLength(1);
    expect(wrapper.find('.record-item').attributes('disabled')).toBeUndefined();
    resolveDetail(response(details['pub-1']!));
    await flushPromises();
    expect(wrapper.find('#news-title').exists()).toBe(true);
    expect((wrapper.get('#news-title').element as HTMLInputElement).value).toBe('');
  });

  it('opens a published record, keeps it editable, and refreshes the version baseline after saving', async () => {
    const calls = setupFetch();
    const wrapper = mountNews();
    await flushPromises();

    await openRecordByTitle(wrapper, '已发布动态');
    expect(
      calls.some((call) => call.url.endsWith('/news/manage/pub-1')),
    ).toBe(true);
    expect(wrapper.get('.form-heading h2').text()).toBe('编辑已发布动态');
    expect(
      (wrapper.get('#news-title').element as HTMLInputElement).value,
    ).toBe('已发布动态');
    expect(
      (wrapper.get('.rich-editor-stub').element as HTMLTextAreaElement).value,
    ).toBe('<p>已发布正文</p>');

    // 第一次保存：携带详情 updatedAt 作为 expectedUpdatedAt
    await wrapper.get('#news-title').setValue('已发布动态（改）');
    await wrapper.get('.submit-button').trigger('submit');
    await flushPromises();
    const patches = calls.filter(
      (call) => call.method === 'PATCH' && call.url.endsWith('/news/pub-1'),
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({
      title: '已发布动态（改）',
      status: 'PUBLISHED',
      expectedUpdatedAt: '2026-07-20T02:00:00.000Z',
    });

    // 保存成功后记录保持打开、基线更新为响应中的 updatedAt
    expect(wrapper.get('.form-heading h2').text()).toBe('编辑已发布动态');
    await wrapper.get('#news-title').setValue('已发布动态（再改）');
    await wrapper.get('.submit-button').trigger('submit');
    await flushPromises();
    const allPatches = calls.filter(
      (call) => call.method === 'PATCH' && call.url.endsWith('/news/pub-1'),
    );
    expect(allPatches).toHaveLength(2);
    expect(allPatches[1]!.body?.expectedUpdatedAt).toBe(NEW_VERSION);
  });

  it('publishes a draft without losing the editing context', async () => {
    const calls = setupFetch();
    const wrapper = mountNews();
    await flushPromises();
    await openRecordByTitle(wrapper, '草稿动态');
    expect(wrapper.get('.form-heading h2').text()).toBe('编辑草稿');

    await wrapper.get('#news-status').setValue('PUBLISHED');
    await wrapper.get('.submit-button').trigger('submit');
    await flushPromises();

    const patch = calls.find(
      (call) => call.method === 'PATCH' && call.url.endsWith('/news/draft-1'),
    );
    expect(patch?.body).toMatchObject({
      status: 'PUBLISHED',
      expectedUpdatedAt: '2026-07-20T04:00:00.000Z',
    });
    // 发布后记录仍可继续管理
    expect(wrapper.get('.form-heading h2').text()).toBe('编辑已发布动态');
    // 列表已刷新
    expect(
      calls.filter((call) => call.url.includes('/news/manage?')).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('opens an archived record in the read-only panel with restore and delete only', async () => {
    setupFetch();
    const wrapper = mountNews();
    await flushPromises();
    await openRecordByTitle(wrapper, '归档动态');

    expect(wrapper.text()).toContain('已归档动态不能直接编辑或发布');
    expect(wrapper.find('#news-title').exists()).toBe(false);
    const buttons = wrapper
      .get('.archived-panel')
      .findAll('button')
      .map((item) => item.text());
    expect(buttons.some((text) => text.includes('恢复为草稿'))).toBe(true);
    expect(buttons.some((text) => text.includes('删除动态'))).toBe(true);
    expect(buttons.some((text) => text.includes('发布'))).toBe(false);
    expect(buttons.some((text) => text.includes('编辑'))).toBe(false);
  });

  it('restores an archived record after confirmation', async () => {
    const calls = setupFetch();
    const wrapper = mountNews();
    await flushPromises();
    await openRecordByTitle(wrapper, '归档动态');

    const restore = wrapper
      .findAll('button')
      .find((item) => item.text().includes('恢复为草稿'))!;
    await restore.trigger('click');
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '恢复为草稿' }),
    );
    const call = calls.find(
      (item) => item.url.endsWith('/news/arch-1/restore'),
    );
    expect(call?.method).toBe('PATCH');
    expect(call?.body).toEqual({
      expectedUpdatedAt: '2026-07-19T06:00:00.000Z',
    });
    // 成功后面板关闭，回到新建表单
    expect(wrapper.find('#news-title').exists()).toBe(true);
  });

  it('keeps the archived panel with an error when restore hits a conflict', async () => {
    setupFetch({
      handle: (call) =>
        call.url.endsWith('/news/arch-1/restore')
          ? response({ message: '动态已被其他人修改或删除' }, 409)
          : null,
    });
    const wrapper = mountNews();
    await flushPromises();
    await openRecordByTitle(wrapper, '归档动态');

    await wrapper
      .findAll('button')
      .find((item) => item.text().includes('恢复为草稿'))!
      .trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('内容已被其他人修改或删除');
    expect(wrapper.find('#news-title').exists()).toBe(false);
  });

  it('archives the open record with confirmation, version, and busy state', async () => {
    setupFetch();
    // 用挂起的 Promise 替换归档请求，验证忙碌态
    let releaseArchive!: () => void;
    let archiveBody: unknown;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const baseImpl = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/news/draft-1/archive')) {
        archiveBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return new Promise<Response>((resolve) => {
          releaseArchive = () =>
            resolve(response({ id: 'draft-1', updatedAt: NEW_VERSION }));
        });
      }
      return baseImpl(input, init);
    });

    const wrapper = mountNews();
    await flushPromises();
    await openRecordByTitle(wrapper, '草稿动态');

    const archiveButton = wrapper
      .get('.form-actions')
      .findAll('button')
      .find((item) => item.text().includes('归档'))!;
    await archiveButton.trigger('click');
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '归档动态', danger: true }),
    );
    // 忙碌态：禁用重复操作
    const busyButton = wrapper
      .get('.form-actions')
      .findAll('button')
      .find((item) => item.text().includes('正在归档'))!;
    expect(busyButton.attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('.status-tab').every((tab) => tab.attributes('disabled') !== undefined))
      .toBe(true);

    releaseArchive();
    await flushPromises();
    expect(archiveBody).toEqual({
      expectedUpdatedAt: '2026-07-20T04:00:00.000Z',
    });
    expect(wrapper.get('.form-heading h2').text()).toBe('新建动态');
  });

  it('deletes the open record only after confirmation and clears the editor', async () => {
    const calls = setupFetch();
    const wrapper = mountNews();
    await flushPromises();
    await openRecordByTitle(wrapper, '草稿动态');

    const deleteButton = wrapper
      .findAll('button')
      .find((item) => item.text().trim() === '删除')!;
    await deleteButton.trigger('click');
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '删除动态', danger: true }),
    );
    const call = calls.find(
      (item) => item.method === 'DELETE' && item.url.endsWith('/news/draft-1'),
    );
    expect(call).toBeTruthy();
    // 删除成功：编辑器清空、列表刷新
    expect(wrapper.get('.form-heading h2').text()).toBe('新建动态');
    expect(
      calls.filter((item) => item.url.includes('/news/manage?')).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('keeps the editor state when deletion fails', async () => {
    setupFetch({
      handle: (call) =>
        call.method === 'DELETE'
          ? response({ message: '服务异常' }, 500)
          : null,
    });
    const wrapper = mountNews();
    await flushPromises();
    await openRecordByTitle(wrapper, '草稿动态');

    await wrapper
      .findAll('button')
      .find((item) => item.text().trim() === '删除')!
      .trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('服务异常');
    expect(
      (wrapper.get('#news-title').element as HTMLInputElement).value,
    ).toBe('草稿动态');
  });

  it('surfaces 409 as an edit conflict without overwriting local content, and reloads after confirmation', async () => {
    let conflict = true;
    const calls = setupFetch({
      handle: (call) => {
        if (
          conflict &&
          call.method === 'PATCH' &&
          call.url.endsWith('/news/draft-1')
        )
          return response({ message: '动态已被其他人修改或删除' }, 409);
        return null;
      },
    });
    const wrapper = mountNews();
    await flushPromises();
    await openRecordByTitle(wrapper, '草稿动态');

    await wrapper.get('#news-title').setValue('本地未保存标题');
    await wrapper.get('.submit-button').trigger('submit');
    await flushPromises();

    // 409：明确冲突提示，本地内容未被覆盖
    expect(wrapper.get('.conflict-box').text()).toContain(
      '内容已被其他人修改或删除',
    );
    expect(
      (wrapper.get('#news-title').element as HTMLInputElement).value,
    ).toBe('本地未保存标题');

    // 重新加载前需要确认会丢失本地修改
    confirmMock.mockClear();
    await wrapper
      .get('.conflict-box button')
      .trigger('click');
    await flushPromises();
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '重新加载服务器版本', danger: true }),
    );
    // 服务器版本覆盖表单，冲突清除
    expect(
      calls.filter((item) => item.url.endsWith('/news/manage/draft-1')).length,
    ).toBe(2);
    expect(
      (wrapper.get('#news-title').element as HTMLInputElement).value,
    ).toBe('草稿动态');
    expect(wrapper.find('.conflict-box').exists()).toBe(false);
  });

  it('does not reload the server version when the discard confirmation is rejected', async () => {
    setupFetch({
      handle: (call) =>
        call.method === 'PATCH' && call.url.endsWith('/news/draft-1')
          ? response({ message: '动态已被其他人修改或删除' }, 409)
          : null,
    });
    const wrapper = mountNews();
    await flushPromises();
    await openRecordByTitle(wrapper, '草稿动态');

    await wrapper.get('#news-title').setValue('本地未保存标题');
    await wrapper.get('.submit-button').trigger('submit');
    await flushPromises();

    confirmMock.mockClear();
    confirmMock.mockResolvedValue(false);
    await wrapper.get('.conflict-box button').trigger('click');
    await flushPromises();

    expect(confirmMock).toHaveBeenCalled();
    expect(
      (wrapper.get('#news-title').element as HTMLInputElement).value,
    ).toBe('本地未保存标题');
    // 冲突提示仍在，未发起新的详情请求
    expect(wrapper.find('.conflict-box').exists()).toBe(true);
  });

  it('protects unsaved content before switching records', async () => {
    const calls = setupFetch();
    confirmMock.mockResolvedValue(false);
    const wrapper = mountNews();
    await flushPromises();
    await openRecordByTitle(wrapper, '草稿动态');
    await wrapper.get('#news-title').setValue('尚未保存的标题');

    await openRecordByTitle(wrapper, '已发布动态');
    expect(confirmMock).toHaveBeenCalled();
    expect(
      calls.some((item) => item.url.endsWith('/news/manage/pub-1')),
    ).toBe(false);
    expect(
      (wrapper.get('#news-title').element as HTMLInputElement).value,
    ).toBe('尚未保存的标题');
  });

  it('protects unsaved content before changing the status filter', async () => {
    setupFetch();
    confirmMock.mockResolvedValue(false);
    const wrapper = mountNews();
    await flushPromises();
    await wrapper.get('#news-title').setValue('尚未保存的标题');

    await wrapper
      .findAll('.status-tab')
      .find((tab) => tab.text() === '已发布')!
      .trigger('click');
    await flushPromises();
    expect(confirmMock).toHaveBeenCalled();
    // 筛选未切换
    expect(
      wrapper.findAll('.status-tab').find((tab) => tab.text() === '全部')!
        .classes(),
    ).toContain('active');
  });

  it('blocks beforeunload only while dirty and removes the listener on unmount', async () => {
    setupFetch();
    const wrapper = mountNews();
    await flushPromises();

    let event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);

    await wrapper.get('#news-title').setValue('改过的标题');
    event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    wrapper.unmount();
    event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('registers a route-leave guard that blocks navigation only while dirty', async () => {
    setupFetch();
    const wrapper = mountNews();
    await flushPromises();
    expect(leaveGuard.current).toBeTruthy();

    await expect(leaveGuard.current!()).resolves.toBe(true);

    await wrapper.get('#news-title').setValue('改过的标题');
    confirmMock.mockResolvedValue(false);
    await expect(leaveGuard.current!()).resolves.toBe(false);
    confirmMock.mockResolvedValue(true);
    await expect(leaveGuard.current!()).resolves.toBe(true);
    wrapper.unmount();
  });

  it('registers and unregisters the admin tab guard', async () => {
    setupFetch();
    const registered = new Map<string, () => unknown>();
    const unregister = vi.fn();
    const registry: AdminTabGuardRegistry = {
      register: (id, guard) => {
        registered.set(id, guard as () => unknown);
      },
      unregister,
    };
    const Host = defineComponent({
      setup() {
        provide(adminTabGuardKey, registry);
        return () => h(AdminNews);
      },
    });
    const wrapper = mount(Host, {
      global: { stubs: { RichTextEditor: editorStub } },
    });
    await flushPromises();

    expect(registered.has('news')).toBe(true);
    await expect(registered.get('news')!()).resolves.toBe(true);

    const news = wrapper.findComponent(AdminNews);
    await news.get('#news-title').setValue('改过的标题');
    confirmMock.mockResolvedValue(false);
    await expect(registered.get('news')!()).resolves.toBe(false);

    wrapper.unmount();
    expect(unregister).toHaveBeenCalledWith('news');
  });

  it('shows an empty state when nothing is manageable and retries after a list failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ message: '服务异常' }, 500))
      .mockResolvedValue(
        response({ items: [], total: 0, page: 1, pageSize: 20 }),
      );
    const wrapper = mountNews();
    await flushPromises();
    expect(wrapper.text()).toContain('服务异常');

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('重试加载列表'))!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('暂无动态');
  });
});
