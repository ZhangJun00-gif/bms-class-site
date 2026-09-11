import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminKnowledge from './AdminKnowledge.vue';

const confirmMock = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));
vi.mock('../../composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, info: vi.fn(), error: vi.fn() }),
}));

const subject = {
  id: 'subject-1',
  name: '医学分子细胞遗传',
  slug: 'medical-molecular-cell-genetics',
  sortOrder: 10,
  active: true,
};

const library = {
  id: 'library-1',
  name: '共享教材库',
  scope: 'SHARED',
  ownerId: null,
  subjectId: subject.id,
  subject,
  aiEnabled: true,
  aiEnabledAt: '2026-07-25T00:00:00.000Z',
  active: true,
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
  _count: { documents: 0, chapters: 0 },
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseFetch(jobs: unknown[] = []) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/subjects')) return response([subject]);
    if (url.pathname.endsWith('/knowledge/libraries'))
      return response({ items: [library], total: 1 });
    if (url.pathname.endsWith('/knowledge/imports'))
      return response({ items: jobs, total: jobs.length, page: 1, pageSize: 100 });
    if (url.pathname.endsWith('/knowledge/imports/import-1/structure'))
      return response({
        items: [
          {
            level: 2,
            title: '细胞膜',
            titleMarkdown: '细胞膜中的 $H_2O$',
            path: '细胞膜',
            chapterName: '细胞生物学',
            chunkCount: 2,
          },
        ],
        nextCursor: null,
        total: 1,
        images: [],
        titleMarkdown: '课程第二版',
        replacement: {
          mode: 'REPLACE',
          targetDocumentId: 'document-1',
          targetDocumentTitle: '课程第一版',
          targetDocumentCreatedAt: '2026-01-01T00:00:00.000Z',
          activeVersionId: 'version-1',
          matchedH2Titles: ['细胞膜'],
        },
      });
    if (url.pathname.endsWith('/knowledge/libraries/library-1/documents'))
      return response({ items: [], total: 0 });
    throw new Error(`unexpected request ${url.pathname}`);
  });
}

async function mountKnowledge() {
  const wrapper = mount(AdminKnowledge);
  await flushPromises();
  return wrapper;
}

describe('AdminKnowledge', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    toastSuccess.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads shared libraries and their documents', async () => {
    const fetchMock = baseFetch();
    const wrapper = await mountKnowledge();

    expect(wrapper.text()).toContain('共享教材库');
    expect(wrapper.text()).toContain('Markdown 或 ZIP');
    expect(wrapper.find('.authoring-guide-open').exists()).toBe(false);
    expect(wrapper.find('.authoring-guide-download').exists()).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/knowledge/libraries/library-1/documents',
      expect.any(Object),
    );
  });

  it('creates a shared library with the selected subject', async () => {
    const fetchMock = baseFetch();
    fetchMock.mockImplementationOnce(async () => response([subject]));
    const wrapper = await mountKnowledge();
    fetchMock.mockResolvedValueOnce(response({ ...library, id: 'library-2', name: '组织学' }));

    await wrapper.get('#library-name-SHARED').setValue('组织学');
    await wrapper.get('form.library-create:nth-of-type(2)').trigger('submit');
    await flushPromises();

    const createCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith('/knowledge/libraries') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String((createCall?.[1] as RequestInit).body))).toEqual({
      name: '组织学',
      subjectId: 'subject-1',
      scope: 'SHARED',
    });
  });

  it('creates a subject and selects it for the next library', async () => {
    const fetchMock = baseFetch();
    const wrapper = await mountKnowledge();
    const created = { ...subject, id: 'subject-2', name: '生理学', slug: 'physiology' };
    fetchMock.mockResolvedValueOnce(response(created));

    await wrapper.get('#knowledge-subject-name').setValue('生理学');
    await wrapper.get('#knowledge-subject-slug').setValue('physiology');
    await wrapper.findAll('form.library-create')[0]!.trigger('submit');
    await flushPromises();

    expect((wrapper.get('#library-subject-SHARED').element as HTMLSelectElement).value)
      .toBe('subject-2');
  });

  it('rejects PDF and confirms a validated Markdown import', async () => {
    const job = {
      id: 'import-1',
      libraryId: 'library-1',
      targetDocumentId: null,
      fileType: 'MARKDOWN',
      sourceName: 'lecture.md',
      sourceSize: 100,
      status: 'AWAITING_CONFIRMATION',
      stage: 'READY_FOR_CONFIRMATION',
      progressCurrent: 0,
      progressTotal: 0,
      title: '课程',
      nodeCount: 3,
      estimatedChunkCount: 4,
      imageCount: 0,
      processedImageBytes: 0,
      warningCount: 0,
      errorCount: 0,
      errorCode: null,
      errorMessage: null,
      confirmedVersionId: null,
      expiresAt: '2026-07-26T00:00:00.000Z',
      confirmedAt: null,
      completedAt: null,
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    };
    const fetchMock = baseFetch([job]);
    const wrapper = await mountKnowledge();
    const input = wrapper.get('#knowledge-package-SHARED');
    Object.defineProperty(input.element, 'files', {
      value: [new File(['pdf'], 'legacy.pdf', { type: 'application/pdf' })],
      configurable: true,
    });
    await input.trigger('change');
    expect(wrapper.text()).toContain('仅支持 200 MiB 以内的 Markdown 或 ZIP');

    await wrapper.findAll('button').find((button) => button.text().includes('预检详情'))!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('整份替换');
    expect(wrapper.text()).toContain('替换“课程第一版”，保留首次创建位置');
    expect(wrapper.text()).toContain('命中 H2：细胞膜');

    fetchMock.mockResolvedValueOnce(response({ ...job, status: 'INDEX_PENDING' }));
    await wrapper.findAll('button').find((button) => button.text().includes('确认索引'))!.trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/knowledge/imports/import-1/confirm',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
