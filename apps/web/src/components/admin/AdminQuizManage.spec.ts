import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminQuizManage from './AdminQuizManage.vue';
import type { QuizQuestionEditorData, QuizQuestionSummary } from '../../types';

const confirmMock = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));
vi.mock('../../composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess }),
}));

const filters = {
  subjects: ['生理学', '病理学'],
  types: ['SINGLE'],
  subjectGroups: [
    {
      subjectId: 'subject-1',
      subject: '生理学',
      pastPaperCount: 1,
      types: [
        {
          label: '病例分析题',
          gradingTypes: ['SINGLE'],
          total: 2,
          randomEligibleCount: 1,
          pastPaperCount: 1,
        },
      ],
      chapters: [
        {
          chapterId: 'chapter-1',
          chapter: '循环',
          total: 2,
          randomEligibleCount: 1,
          pastPaperCount: 1,
          types: [
            {
              label: '病例分析题',
              gradingTypes: ['SINGLE'],
              total: 2,
              randomEligibleCount: 1,
              pastPaperCount: 1,
            },
          ],
        },
      ],
      pastPapers: [],
    },
    {
      subjectId: 'subject-2',
      subject: '病理学',
      pastPaperCount: 0,
      types: [],
      chapters: [],
      pastPapers: [],
    },
  ],
};

function question(
  id: string,
  overrides: Partial<QuizQuestionSummary> = {},
): QuizQuestionSummary {
  return {
    id,
    type: 'SINGLE',
    gradingType: 'SINGLE',
    typeLabel: '病例分析题',
    subjectId: 'subject-1',
    subject: '生理学',
    chapterIds: ['chapter-1'],
    chapter: '循环',
    chapters: [
      {
        id: 'chapter-1',
        subjectId: 'subject-1',
        name: '循环',
        slug: 'circulation',
        sortOrder: 1,
        active: true,
      },
    ],
    category: 'STANDARD',
    origin: 'MANUAL',
    prompt: `很长的题干 ${id}：患者出现循环系统相关症状，请选择最符合题意的答案。`,
    options: [],
    images: [],
    isPastPaper: false,
    pastPaper: null,
    paperOrder: null,
    maxScore: 1,
    ...overrides,
  };
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FetchOptions {
  questions?: QuizQuestionSummary[];
  total?: number;
  deleteResponse?: Response | Error;
}

function editorQuestion(id: string): QuizQuestionEditorData {
  return {
    ...question(id),
    options: [
      { id: 'A', text: '选项甲' },
      { id: 'B', text: '选项乙' },
    ],
    correctAnswer: ['A'],
    explanation: '题目解析',
  };
}

function mockFetch(options: FetchOptions = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/quizzes/filters')) return response(filters);
      if (url.pathname.endsWith('/subjects')) {
        return response([
          {
            id: 'subject-1',
            name: '生理学',
            slug: 'physiology',
            sortOrder: 1,
            active: true,
          },
        ]);
      }
      if (url.pathname.endsWith('/subjects/subject-1/chapters')) {
        return response([
          {
            id: 'chapter-1',
            subjectId: 'subject-1',
            name: '循环',
            slug: 'circulation',
            sortOrder: 1,
            active: true,
          },
          {
            id: 'chapter-2',
            subjectId: 'subject-1',
            name: '呼吸',
            slug: 'respiration',
            sortOrder: 2,
            active: true,
          },
        ]);
      }
      if (init?.method === 'DELETE') {
        if (options.deleteResponse instanceof Error)
          throw options.deleteResponse;
        return options.deleteResponse ?? response({ id: 'q1', deleted: true });
      }
      if (/\/quizzes\/questions\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').at(-1)!;
        return response(editorQuestion(id));
      }
      if (url.pathname.endsWith('/quizzes/questions')) {
        const page = Number(url.searchParams.get('page') ?? 1);
        return response({
          items: options.questions ?? [question('q1'), question('q2')],
          total: options.total ?? 2,
          page,
          pageSize: Number(url.searchParams.get('pageSize') ?? 20),
        });
      }
      throw new Error(
        `unexpected request ${init?.method ?? 'GET'} ${url.pathname}`,
      );
    });
}

async function mountManager() {
  const wrapper = mount(AdminQuizManage);
  await flushPromises();
  return wrapper;
}

function questionUrls(fetchMock: ReturnType<typeof mockFetch>) {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method !== 'DELETE')
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname.endsWith('/quizzes/questions'));
}

describe('AdminQuizManage', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    toastSuccess.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it('sends server-side keyword, subject, chapter, type, paper, and pagination filters', async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountManager();
    await wrapper.get('#manage-quiz-subject').setValue('subject-1');
    await flushPromises();
    await wrapper.get('#manage-quiz-chapters').trigger('click');
    await wrapper
      .findAll('.chapter-select-option')
      .find((option) => option.text().includes('循环'))!
      .trigger('click');
    await flushPromises();
    await wrapper.get('#manage-quiz-type').setValue('病例分析题');
    await flushPromises();
    await wrapper.get('#manage-quiz-source').setValue('NON_AI');
    await flushPromises();
    await wrapper.get('#manage-quiz-comprehensive').setValue('true');
    await flushPromises();
    await wrapper.get('#manage-quiz-paper').setValue('ONLY');
    await flushPromises();
    await wrapper.get('#manage-quiz-search').setValue('循环 症状');
    await wrapper.get('.manage-filters').trigger('submit');
    await flushPromises();

    const url = questionUrls(fetchMock).at(-1)!;
    expect(url.searchParams.get('subjectId')).toBe('subject-1');
    expect(url.searchParams.get('chapterIds')).toBe('chapter-1');
    expect(url.searchParams.get('chapterMatch')).toBe('ANY');
    expect(url.searchParams.get('typeLabel')).toBe('病例分析题');
    expect(url.searchParams.get('source')).toBe('NON_AI');
    expect(url.searchParams.get('includeCrossChapter')).toBe('true');
    expect(url.searchParams.get('pastPaper')).toBe('ONLY');
    expect(url.searchParams.get('search')).toBe('循环 症状');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('pageSize')).toBe('20');
    expect(wrapper.text()).not.toContain('正确答案');
    expect(wrapper.text()).toContain('非 AI');
    expect(
      wrapper
        .get('#manage-quiz-search')
        .element.closest('.quiz-keyword-search'),
    ).not.toBeNull();
    wrapper.unmount();
  });

  it('does nothing when deletion confirmation is cancelled', async () => {
    confirmMock.mockResolvedValue(false);
    const fetchMock = mockFetch();
    const wrapper = await mountManager();
    await wrapper.findAll('.delete-button')[0]!.trigger('click');
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '删除题目',
        confirmText: '删除题目',
        body: expect.stringContaining('历史答题记录和快照仍会保留'),
      }),
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
    ).toBe(false);
    wrapper.unmount();
  });

  it('loads protected editor data and saves multiple chapter ids', async () => {
    const fetchMock = mockFetch({ questions: [question('q1')] });
    const wrapper = await mountManager();

    await wrapper.get('.edit-button').trigger('click');
    await flushPromises();
    expect(wrapper.find('form[aria-label="编辑题目"]').exists()).toBe(true);
    expect(wrapper.find('.chapter-field input[type="checkbox"]').exists()).toBe(
      false,
    );
    await wrapper.get('#edit-chapters-q1').trigger('click');
    await wrapper
      .findAll('.chapter-select-option')
      .find((option) => option.text().includes('呼吸'))!
      .trigger('click');
    expect(wrapper.find('.chapter-match').exists()).toBe(false);
    await wrapper.get('form[aria-label="编辑题目"]').trigger('submit');
    await flushPromises();

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith('/quizzes/questions/q1') &&
        init?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      subjectId: 'subject-1',
      chapterIds: ['chapter-1', 'chapter-2'],
      correctAnswer: ['A'],
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('历史答题快照保持不变'),
    );
    wrapper.unmount();
  });

  it('soft deletes through the question endpoint and never unlinks images', async () => {
    const fetchMock = mockFetch({ questions: [question('q1')] });
    const wrapper = await mountManager();
    await wrapper.get('.delete-button').trigger('click');
    await flushPromises();

    const deleteCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(1);
    expect(String(deleteCalls[0]![0])).toBe('/api/v1/quizzes/questions/q1');
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/images/'),
      ),
    ).toBe(false);
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('历史答题记录'),
    );
    expect(wrapper.emitted('deleted')).toHaveLength(1);
    wrapper.unmount();
  });

  it('locks only the active row while deletion is in flight', async () => {
    let resolveDelete!: (response: Response) => void;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname.endsWith('/quizzes/filters')) return response(filters);
        if (init?.method === 'DELETE')
          return new Promise<Response>((resolve) => (resolveDelete = resolve));
        return response({
          items: [question('q1'), question('q2')],
          total: 2,
          page: 1,
          pageSize: 20,
        });
      });
    const wrapper = await mountManager();
    const buttons = wrapper.findAll('.delete-button');
    await buttons[0]!.trigger('click');

    expect(buttons[0]!.text()).toContain('正在删除');
    expect(buttons[0]!.attributes()).toHaveProperty('disabled');
    expect(buttons[1]!.attributes()).not.toHaveProperty('disabled');
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE'),
    ).toHaveLength(1);

    resolveDelete(response({ id: 'q1', deleted: true }));
    await flushPromises();
    wrapper.unmount();
  });

  it.each([
    ['无权删除该题目', response({ message: '无权删除该题目' }, 403)],
    ['题目不存在', response({ message: '题目不存在' }, 404)],
    ['网络连接失败', new TypeError('failed to fetch')],
  ])(
    'keeps the row and shows a retryable error: %s',
    async (message, deleteResponse) => {
      mockFetch({ questions: [question('q1')], deleteResponse });
      const wrapper = await mountManager();
      await wrapper.get('.delete-button').trigger('click');
      await flushPromises();

      expect(wrapper.text()).toContain(message);
      expect(wrapper.text()).toContain('很长的题干 q1');
      expect(wrapper.get('.delete-button').attributes()).not.toHaveProperty(
        'disabled',
      );
      wrapper.unmount();
    },
  );

  it('moves to the previous page after deleting the last item on a later page', async () => {
    let deleted = false;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname.endsWith('/quizzes/filters')) return response(filters);
        if (init?.method === 'DELETE') {
          deleted = true;
          return response({ id: 'q21', deleted: true });
        }
        const requestedPage = Number(url.searchParams.get('page') ?? 1);
        if (requestedPage === 2 && !deleted)
          return response({
            items: [question('q21')],
            total: 21,
            page: 2,
            pageSize: 20,
          });
        return response({
          items: [question('q1')],
          total: deleted ? 20 : 21,
          page: 1,
          pageSize: 20,
        });
      });
    const wrapper = await mountManager();
    await wrapper
      .findAll('.pagination button')
      .find((button) => button.attributes('aria-label') === '下一页')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('很长的题干 q21');
    await wrapper.get('.delete-button').trigger('click');
    await flushPromises();

    const pages = fetchMock.mock.calls
      .filter(([, init]) => init?.method !== 'DELETE')
      .map(([input]) => new URL(String(input), 'http://localhost'))
      .filter((url) => url.pathname.endsWith('/quizzes/questions'))
      .map((url) => url.searchParams.get('page'));
    expect(pages.slice(-2)).toEqual(['2', '1']);
    expect(wrapper.text()).toContain('很长的题干 q1');
    wrapper.unmount();
  });
});
