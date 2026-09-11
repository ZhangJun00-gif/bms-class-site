import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetQuizFiltersCache } from '../../composables/useQuizFilters';
import AdminDailyFixedQuestions from './AdminDailyFixedQuestions.vue';

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const candidate = {
  id: 'manual-1',
  gradingType: 'SINGLE',
  typeLabel: '单选题',
  subjectId: 'subject-1',
  subject: '生理学',
  chapterIds: ['chapter-1'],
  chapters: [{ id: 'chapter-1', name: '循环', slug: 'circulation' }],
  prompt: '人工固定题',
  origin: 'MANUAL',
  isPastPaper: false,
} as const;

describe('AdminDailyFixedQuestions', () => {
  beforeEach(() => {
    resetQuizFiltersCache();
    confirmMock.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts empty, uses only the dedicated non-AI candidate endpoint and preserves order on publish', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      if (url.endsWith('/quizzes/filters')) {
        return response({ subjects: [], types: [], subjectGroups: [] });
      }
      if (url.includes('/fixed-assignments/') && !options?.method) {
        return response({ message: '未设置' }, 404);
      }
      if (url.includes('/fixed-question-candidates')) {
        return response({ items: [candidate], total: 1, page: 1, pageSize: 10 });
      }
      if (url.endsWith('/fixed-assignments') && options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        return response({
          id: 'assignment-1',
          practiceDate: body.practiceDate,
          revision: 1,
          basedOnAssignmentId: null,
          assignmentHash: 'hash',
          note: null,
          publishedAt: '2026-07-28T00:00:00.000Z',
          publishedBy: null,
          questions: [{ ...candidate, ordinal: 1 }],
        });
      }
      return response({}, 404);
    });
    const wrapper = mount(AdminDailyFixedQuestions);
    await flushPromises();

    expect(wrapper.text()).toContain('该练习日未设置固定题');
    expect(wrapper.text()).toContain('人工固定题');
    expect(wrapper.text()).toContain('循环');
    expect(wrapper.find('select option[value="AI"]').exists()).toBe(false);
    await wrapper.find('.candidate-list input[type="checkbox"]').setValue(true);
    await wrapper.find('.save-button').trigger('click');
    await flushPromises();

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/fixed-question-candidates'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/quizzes/questions'))).toBe(false);
    const candidateCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/fixed-question-candidates'));
    expect(new URL(String(candidateCall?.[0]), 'http://localhost').searchParams.get('includeCrossChapter')).toBe('false');
    const publishCall = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(String(publishCall?.[1]?.body)).questionIds).toEqual(['manual-1']);
  });

  it('ignores an assignment response that belongs to a previously selected date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
    let resolveOld!: (value: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/quizzes/filters')) {
        return response({ subjects: [], types: [], subjectGroups: [] });
      }
      if (url.includes('/fixed-question-candidates')) {
        return response({ items: [], total: 0, page: 1, pageSize: 10 });
      }
      if (url.includes('/fixed-assignments/2026-07-29')) return oldResponse;
      if (url.includes('/fixed-assignments/2026-07-30')) {
        return response({
          id: 'new-assignment', practiceDate: '2026-07-30', revision: 1,
          basedOnAssignmentId: null, assignmentHash: 'new', note: null,
          publishedAt: '2026-07-28T00:00:00.000Z', publishedBy: null,
          questions: [{ ...candidate, id: 'new-question', prompt: '新日期题目', ordinal: 1 }],
        });
      }
      return response({}, 404);
    });
    const wrapper = mount(AdminDailyFixedQuestions);
    await wrapper.get('#fixed-practice-date').setValue('2026-07-30');
    await flushPromises();
    expect(wrapper.text()).toContain('新日期题目');

    resolveOld(response({
      id: 'old-assignment', practiceDate: '2026-07-29', revision: 1,
      basedOnAssignmentId: null, assignmentHash: 'old', note: null,
      publishedAt: '2026-07-28T00:00:00.000Z', publishedBy: null,
      questions: [{ ...candidate, prompt: '旧日期题目', ordinal: 1 }],
    }));
    await flushPromises();

    expect(wrapper.text()).toContain('新日期题目');
    expect(wrapper.text()).not.toContain('旧日期题目');
    expect(fetchMock).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('locks the current practice date after its 04:00 cycle starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/quizzes/filters')) return response({ subjects: [], types: [], subjectGroups: [] });
      if (url.includes('/fixed-question-candidates')) return response({ items: [candidate], total: 1, page: 1, pageSize: 10 });
      if (url.includes('/fixed-assignments/')) return response({ message: '未设置' }, 404);
      return response({}, 404);
    });
    const wrapper = mount(AdminDailyFixedQuestions);
    await flushPromises();
    await wrapper.get('#fixed-practice-date').setValue('2026-07-28');
    await flushPromises();

    expect(wrapper.text()).toContain('04:00 周期已经锁定');
    expect(wrapper.get('.candidate-list input[type="checkbox"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.save-button').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('keeps the target date immutable while publish confirmation is pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
    let resolveConfirm!: (value: boolean) => void;
    confirmMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      if (url.endsWith('/quizzes/filters')) return response({ subjects: [], types: [], subjectGroups: [] });
      if (url.includes('/fixed-question-candidates')) return response({ items: [candidate], total: 1, page: 1, pageSize: 10 });
      if (url.includes('/fixed-assignments/') && !options?.method) return response({ message: '未设置' }, 404);
      if (url.endsWith('/fixed-assignments') && options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        return response({
          id: 'assignment-1', practiceDate: body.practiceDate, revision: 1,
          basedOnAssignmentId: null, assignmentHash: 'hash', note: null,
          publishedAt: '2026-07-28T00:00:00.000Z', publishedBy: null,
          questions: [{ ...candidate, ordinal: 1 }],
        });
      }
      return response({}, 404);
    });
    const wrapper = mount(AdminDailyFixedQuestions);
    await flushPromises();
    await wrapper.get('.candidate-list input[type="checkbox"]').setValue(true);
    await wrapper.get('.save-button').trigger('click');
    await Promise.resolve();

    expect(wrapper.get('#fixed-practice-date').attributes('disabled')).toBeDefined();
    resolveConfirm(true);
    await flushPromises();

    const publishCall = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(String(publishCall?.[1]?.body)).practiceDate).toBe('2026-07-29');
    wrapper.unmount();
  });

  it('does not show candidates from the previous filters when the new filter fails', async () => {
    let failPastPaperFilter = true;
    const candidatePages: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/quizzes/filters')) {
        return response({ subjects: [], types: [], subjectGroups: [] });
      }
      if (url.pathname.includes('/fixed-assignments/')) {
        return response({ message: '未设置' }, 404);
      }
      if (url.pathname.endsWith('/fixed-question-candidates')) {
        candidatePages.push(url.searchParams.get('page') ?? '');
        if (url.searchParams.get('pastPaper') === 'ONLY' && failPastPaperFilter) {
          failPastPaperFilter = false;
          return response({ message: '筛选请求失败' }, 500);
        }
        return response({
          items: [{
            ...candidate,
            id: url.searchParams.get('pastPaper') === 'ONLY'
              ? 'past-paper-1'
              : candidate.id,
            prompt: url.searchParams.get('pastPaper') === 'ONLY'
              ? '往年真题候选'
              : candidate.prompt,
          }],
          total: 1,
          page: 1,
          pageSize: 10,
        });
      }
      return response({}, 404);
    });
    const wrapper = mount(AdminDailyFixedQuestions);
    await flushPromises();
    expect(wrapper.text()).toContain('人工固定题');

    await wrapper.get('#fixed-paper').setValue('ONLY');
    await flushPromises();

    expect(wrapper.text()).toContain('筛选请求失败');
    expect(wrapper.text()).not.toContain('人工固定题');
    expect(wrapper.find('.candidate-list').exists()).toBe(false);

    await wrapper.get('.error-state button').trigger('click');
    await flushPromises();

    expect(candidatePages.at(-1)).toBe('1');
    expect(wrapper.text()).toContain('往年真题候选');
    wrapper.unmount();
  });

  it('corrects a fixed-question candidate page that became out of range once', async () => {
    const requestedPages: string[] = [];
    let pageOneCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/quizzes/filters')) {
        return response({ subjects: [], types: [], subjectGroups: [] });
      }
      if (url.pathname.includes('/fixed-assignments/')) {
        return response({ message: '未设置' }, 404);
      }
      if (url.pathname.endsWith('/fixed-question-candidates')) {
        const requestedPage = url.searchParams.get('page') ?? '';
        requestedPages.push(requestedPage);
        if (requestedPage === '3') {
          return response({ items: [], total: 1, page: 3, pageSize: 10 });
        }
        pageOneCalls += 1;
        return response({
          items: [{
            ...candidate,
            id: pageOneCalls === 1 ? 'initial-candidate' : 'corrected-candidate',
            prompt: pageOneCalls === 1 ? '初始候选题' : '纠偏候选题',
          }],
          total: pageOneCalls === 1 ? 21 : 1,
          page: 1,
          pageSize: 10,
        });
      }
      return response({}, 404);
    });
    const wrapper = mount(AdminDailyFixedQuestions);
    await flushPromises();

    wrapper.findComponent({ name: 'PaginationControl' }).vm.$emit('update:page', 3);
    await flushPromises();

    expect(requestedPages).toEqual(['1', '3', '1']);
    expect(wrapper.text()).toContain('纠偏候选题');
    expect(wrapper.text()).not.toContain('初始候选题');
    expect(wrapper.findComponent({ name: 'PaginationControl' }).props('page')).toBe(1);
    wrapper.unmount();
  });
});
