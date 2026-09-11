import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { knowledgeAuthoringGuideMarkdown } from '../../lib/knowledgeAuthoringGuide';
import KnowledgeLibraryManager from './KnowledgeLibraryManager.vue';

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));

const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  'createObjectURL',
);
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  'revokeObjectURL',
);

vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}));
vi.mock('../../composables/useToast', () => ({
  useToast: () => toastMocks,
}));

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('KnowledgeLibraryManager private scope', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreUrlMethod('createObjectURL', originalCreateObjectUrl);
    restoreUrlMethod('revokeObjectURL', originalRevokeObjectUrl);
    document.body.innerHTML = '';
    toastMocks.success.mockReset();
    toastMocks.info.mockReset();
    toastMocks.error.mockReset();
  });

  it('always creates the member library as private', async () => {
    const subject = {
      id: 'subject-1',
      name: '生理学',
      slug: 'physiology',
      sortOrder: 1,
      active: true,
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input, init) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname.endsWith('/subjects')) return response([subject]);
        if (
          url.pathname.endsWith('/knowledge/libraries') &&
          init?.method === 'POST'
        ) {
          return response({
            id: 'private-1',
            name: '我的笔记',
            scope: 'PRIVATE',
            ownerId: 'member-1',
            subjectId: subject.id,
            subject,
            aiEnabled: false,
            aiEnabledAt: null,
            active: true,
            createdAt: '2026-07-25T00:00:00.000Z',
            updatedAt: '2026-07-25T00:00:00.000Z',
            _count: { documents: 0, chapters: 0 },
          });
        }
        if (url.pathname.endsWith('/knowledge/libraries'))
          return response({ items: [], total: 0 });
        if (url.pathname.endsWith('/knowledge/imports'))
          return response({ items: [], total: 0, page: 1, pageSize: 100 });
        throw new Error(`unexpected ${url.pathname}`);
      },
    );
    const wrapper = mount(KnowledgeLibraryManager, {
      props: { scope: 'PRIVATE' },
    });
    await flushPromises();

    await wrapper.get('#library-name-PRIVATE').setValue('我的笔记');
    await wrapper.get('form.library-create').trigger('submit');
    await flushPromises();

    const call = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith('/knowledge/libraries') && init?.method === 'POST',
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      name: '我的笔记',
      subjectId: 'subject-1',
      scope: 'PRIVATE',
    });
    wrapper.unmount();
  });

  it('shows the current guide and downloads the same Markdown source', async () => {
    vi.useFakeTimers();
    const createObjectUrl = vi.fn((_blob: Blob) => 'blob:knowledge-authoring-guide');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    });
    let downloadedName = '';
    let downloadedHref = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedName = this.download;
      downloadedHref = this.href;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(privateManagerFetch);

    const wrapper = mount(KnowledgeLibraryManager, {
      props: { scope: 'PRIVATE' },
    });
    await flushPromises();

    expect(wrapper.get('.authoring-guide-open').text()).toContain('文件编写说明');
    expect(wrapper.get('.authoring-guide-download').attributes('title')).toBe(
      '下载知识库文件编写说明',
    );

    await wrapper.get('.authoring-guide-open').trigger('click');
    await flushPromises();
    const guide = document.body.querySelector('.authoring-guide-document');
    expect(guide?.textContent).toContain('H2 唯一性与整份替换');
    expect(guide?.textContent).toContain('思维导图');
    expect(guide?.textContent).not.toContain('上/下一节按钮');

    await wrapper.get('.authoring-guide-download').trigger('click');
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    const downloadedBlob = createObjectUrl.mock.calls[0]![0];
    expect(downloadedBlob.type).toBe('text/markdown;charset=utf-8');
    expect(downloadedBlob.size).toBe(
      new Blob([knowledgeAuthoringGuideMarkdown]).size,
    );
    expect(downloadedName).toBe('KNOWLEDGE_BASE_FILE_AUTHORING_GUIDE.md');
    expect(downloadedHref).toBe('blob:knowledge-authoring-guide');
    vi.advanceTimersByTime(0);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:knowledge-authoring-guide');
    wrapper.unmount();
  });

  it('refreshes a conflicted import and releases only that job busy state', async () => {
    const subject = { id: 'subject-1', name: '生理学', slug: 'physiology', sortOrder: 1, active: true };
    const library = {
      id: 'private-1', name: '我的笔记', scope: 'PRIVATE', ownerId: 'member-1',
      subjectId: subject.id, subject, aiEnabled: false, aiEnabledAt: null, active: true,
      createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
      _count: { documents: 0, chapters: 0 },
    };
    const importJob = {
      id: 'import-1', libraryId: library.id, sourceName: 'book.zip', title: '教材',
      status: 'AWAITING_CONFIRMATION', nodeCount: 2, estimatedChunkCount: 4, imageCount: 0,
      errorMessage: null,
    };
    let importReads = 0;
    let resolveConfirm!: (value: Response) => void;
    const confirmResponse = new Promise<Response>((resolve) => { resolveConfirm = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/subjects')) return response([subject]);
      if (url.pathname.endsWith('/knowledge/libraries')) return response({ items: [library], total: 1 });
      if (url.pathname.endsWith('/knowledge/imports/import-1/confirm') && init?.method === 'POST')
        return confirmResponse;
      if (url.pathname.endsWith('/knowledge/imports')) {
        importReads += 1;
        return response({ items: [importJob], total: 1, page: 1, pageSize: 100 });
      }
      if (url.pathname.endsWith('/knowledge/libraries/private-1/documents'))
        return response({ items: [], total: 0 });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const wrapper = mount(KnowledgeLibraryManager, { props: { scope: 'PRIVATE' } });
    await flushPromises();
    const confirmButton = wrapper.findAll('.task-list button').find((button) => button.text().includes('确认索引'))!;
    await confirmButton.trigger('click');
    await flushPromises();

    const cancelButton = wrapper.findAll('.task-list button').find((button) => button.text() === '取消')!;
    expect(confirmButton.attributes('disabled')).toBeDefined();
    expect(cancelButton.attributes('disabled')).toBeDefined();
    resolveConfirm(response({ message: '任务状态已变化' }, 409));
    await flushPromises();

    expect(importReads).toBeGreaterThanOrEqual(2);
    expect(confirmButton.attributes('disabled')).toBeUndefined();
    expect(toastMocks.error).toHaveBeenCalledWith('任务状态已变化');
    wrapper.unmount();
  });

  it('starts polling when switching to a library with an active import', async () => {
    vi.useFakeTimers();
    const subject = { id: 'subject-1', name: '生理学', slug: 'physiology', sortOrder: 1, active: true };
    const libraries = [
      {
        id: 'private-1', name: '静态知识库', scope: 'PRIVATE', ownerId: 'member-1',
        subjectId: subject.id, subject, aiEnabled: false, aiEnabledAt: null, active: true,
        createdAt: '', updatedAt: '', _count: { documents: 0, chapters: 0 },
      },
      {
        id: 'private-2', name: '导入中知识库', scope: 'PRIVATE', ownerId: 'member-1',
        subjectId: subject.id, subject, aiEnabled: false, aiEnabledAt: null, active: true,
        createdAt: '', updatedAt: '', _count: { documents: 0, chapters: 0 },
      },
    ];
    const activeImport = {
      id: 'import-2', libraryId: 'private-2', sourceName: 'book.zip', title: '教材',
      status: 'PROCESSING', nodeCount: 2, estimatedChunkCount: 4, imageCount: 0,
      errorMessage: null,
    };
    let importReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/subjects')) return response([subject]);
      if (url.pathname.endsWith('/knowledge/libraries')) return response({ items: libraries, total: 2 });
      if (url.pathname.endsWith('/knowledge/imports')) {
        importReads += 1;
        return response({ items: [activeImport], total: 1, page: 1, pageSize: 100 });
      }
      if (/\/knowledge\/libraries\/private-[12]\/documents$/.test(url.pathname))
        return response({ items: [], total: 0 });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const wrapper = mount(KnowledgeLibraryManager, { props: { scope: 'PRIVATE' } });
    await flushPromises();
    expect(importReads).toBe(1);

    await wrapper.get('#library-select-PRIVATE').setValue('private-2');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(4_000);
    await flushPromises();

    expect(importReads).toBe(2);
    wrapper.unmount();
  });

  it('pauses sequential polling while hidden and resumes immediately when visible', async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const subject = { id: 'subject-1', name: '生理学', slug: 'physiology', sortOrder: 1, active: true };
    const library = {
      id: 'private-1', name: '我的笔记', scope: 'PRIVATE', ownerId: 'member-1',
      subjectId: subject.id, subject, aiEnabled: false, aiEnabledAt: null, active: true,
      createdAt: '', updatedAt: '', _count: { documents: 0, chapters: 0 },
    };
    const activeImport = {
      id: 'import-1', libraryId: library.id, sourceName: 'book.zip', title: '教材',
      status: 'PROCESSING', nodeCount: 2, estimatedChunkCount: 4, imageCount: 0,
      errorMessage: null,
    };
    let importReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/subjects')) return response([subject]);
      if (url.pathname.endsWith('/knowledge/libraries')) return response({ items: [library], total: 1 });
      if (url.pathname.endsWith('/knowledge/imports')) {
        importReads += 1;
        return response({ items: [activeImport], total: 1, page: 1, pageSize: 100 });
      }
      if (url.pathname.endsWith('/knowledge/libraries/private-1/documents'))
        return response({ items: [], total: 0 });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const wrapper = mount(KnowledgeLibraryManager, { props: { scope: 'PRIVATE' } });
    await flushPromises();
    expect(importReads).toBe(1);

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(importReads).toBe(1);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(importReads).toBe(2);
    await vi.advanceTimersByTimeAsync(4_000);
    await flushPromises();
    expect(importReads).toBe(3);
    wrapper.unmount();
  });

  it('releases library delete busy and refreshes after a conflict', async () => {
    const subject = { id: 'subject-1', name: '生理学', slug: 'physiology', sortOrder: 1, active: true };
    const library = {
      id: 'private-1', name: '我的笔记', scope: 'PRIVATE', ownerId: 'member-1',
      subjectId: subject.id, subject, aiEnabled: false, aiEnabledAt: null, active: true,
      createdAt: '', updatedAt: '', _count: { documents: 0, chapters: 0 },
    };
    let libraryReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/subjects')) return response([subject]);
      if (url.pathname.endsWith('/knowledge/libraries/private-1') && init?.method === 'DELETE')
        return response({ message: '知识库状态已变化' }, 409);
      if (url.pathname.endsWith('/knowledge/libraries')) {
        libraryReads += 1;
        return response({ items: [library], total: 1 });
      }
      if (url.pathname.endsWith('/knowledge/imports'))
        return response({ items: [], total: 0, page: 1, pageSize: 100 });
      if (url.pathname.endsWith('/knowledge/libraries/private-1/documents'))
        return response({ items: [], total: 0 });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const wrapper = mount(KnowledgeLibraryManager, { props: { scope: 'PRIVATE' } });
    await flushPromises();
    const deleteButton = wrapper.get('button[title="删除知识库"]');
    await deleteButton.trigger('click');
    await flushPromises();

    expect(libraryReads).toBeGreaterThanOrEqual(2);
    expect(deleteButton.attributes('disabled')).toBeUndefined();
    expect(toastMocks.error).toHaveBeenCalledWith('知识库状态已变化');
    wrapper.unmount();
  });

  it('does not read while hidden and reloads the base snapshot once when restored', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/subjects')) return response([]);
      if (url.pathname.endsWith('/knowledge/libraries')) return response({ items: [], total: 0 });
      if (url.pathname.endsWith('/knowledge/imports'))
        return response({ items: [], total: 0, page: 1, pageSize: 100 });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const wrapper = mount(KnowledgeLibraryManager, {
      props: { scope: 'PRIVATE', active: false },
    });
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();

    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await wrapper.setProps({ active: false });
    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    wrapper.unmount();
  });
});

async function privateManagerFetch(input: RequestInfo | URL) {
  const url = new URL(String(input), 'http://localhost');
  const subject = {
    id: 'subject-1',
    name: '生理学',
    slug: 'physiology',
    sortOrder: 1,
    active: true,
  };
  if (url.pathname.endsWith('/subjects')) return response([subject]);
  if (url.pathname.endsWith('/knowledge/libraries')) {
    return response({
      items: [
        {
          id: 'private-1',
          name: '我的笔记',
          scope: 'PRIVATE',
          ownerId: 'member-1',
          subjectId: subject.id,
          subject,
          aiEnabled: false,
          aiEnabledAt: null,
          active: true,
          createdAt: '2026-07-25T00:00:00.000Z',
          updatedAt: '2026-07-25T00:00:00.000Z',
          _count: { documents: 0, chapters: 0 },
        },
      ],
      total: 1,
    });
  }
  if (url.pathname.endsWith('/knowledge/imports')) {
    return response({ items: [], total: 0, page: 1, pageSize: 100 });
  }
  if (url.pathname.endsWith('/knowledge/libraries/private-1/documents')) {
    return response({ items: [], total: 0 });
  }
  throw new Error(`unexpected ${url.pathname}`);
}

function restoreUrlMethod(
  method: 'createObjectURL' | 'revokeObjectURL',
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(URL, method, descriptor);
  else delete (URL as unknown as Record<string, unknown>)[method];
}
