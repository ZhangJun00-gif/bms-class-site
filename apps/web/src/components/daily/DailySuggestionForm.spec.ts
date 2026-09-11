import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetQuizFiltersCache } from '../../composables/useQuizFilters';
import DailySuggestionForm from './DailySuggestionForm.vue';

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

describe('DailySuggestionForm', () => {
  beforeEach(() => {
    resetQuizFiltersCache();
    confirmMock.mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('submits the single daily suggestion and immediately switches to read-only state', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input).endsWith('/quizzes/filters')) {
        return response({ subjects: [], types: [], subjectGroups: [] });
      }
      if (String(input).endsWith('/daily-practice/suggestions') && options?.method === 'POST') {
        const payload = JSON.parse(String(options.body));
        return response({
          id: 'suggestion-1',
          targetPracticeDate: '2026-07-29',
          payload,
          status: 'PENDING',
          submittedByRole: 'MEMBER',
          createdAt: '2026-07-28T06:00:00.000Z',
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const wrapper = mount(DailySuggestionForm, {
      props: {
        targetPracticeDate: '2026-07-29',
        available: true,
        current: null,
      },
    });
    await flushPromises();
    await wrapper.find('#daily-question-count').setValue('6');
    await wrapper.find('#daily-suggestion-note').setValue('加强循环系统复习');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const postCalls = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(postCalls).toHaveLength(1);
    expect(JSON.parse(String(postCalls[0]![1]?.body))).toMatchObject({
      intensity: 'STANDARD',
      desiredQuestionCount: 6,
      note: '加强循环系统复习',
    });
    expect(wrapper.text()).toContain('今日建议已使用');
    expect(wrapper.find('form').exists()).toBe(false);

    await wrapper.setProps({
      targetPracticeDate: '2026-07-30',
      available: true,
      current: null,
    });
    await flushPromises();

    expect(wrapper.text()).toContain('2026-07-30');
    expect(wrapper.find('form').exists()).toBe(true);
  });

  it('reports a quota conflict so the parent can refresh cross-tab state', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input).endsWith('/quizzes/filters')) {
        return response({ subjects: [], types: [], subjectGroups: [] });
      }
      if (String(input).endsWith('/daily-practice/suggestions') && options?.method === 'POST') {
        return response({ message: '今日建议配额已使用' }, 409);
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const wrapper = mount(DailySuggestionForm, {
      props: {
        targetPracticeDate: '2026-07-29',
        available: true,
        current: null,
      },
    });
    await flushPromises();
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.emitted('conflict')).toHaveLength(1);
    expect(wrapper.find('form').exists()).toBe(true);
  });

  it('discards an old-day response that arrives after the target practice date changes', async () => {
    let resolveSuggestion!: (value: Response) => void;
    const pendingSuggestion = new Promise<Response>((resolve) => {
      resolveSuggestion = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input).endsWith('/quizzes/filters')) {
        return response({ subjects: [], types: [], subjectGroups: [] });
      }
      if (String(input).endsWith('/daily-practice/suggestions') && options?.method === 'POST') {
        return pendingSuggestion;
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const wrapper = mount(DailySuggestionForm, {
      props: {
        targetPracticeDate: '2026-07-29',
        available: true,
        current: null,
      },
    });
    await flushPromises();
    await wrapper.find('form').trigger('submit');
    await wrapper.setProps({
      targetPracticeDate: '2026-07-30',
      available: true,
      current: null,
    });
    resolveSuggestion(response({
      id: 'suggestion-old-day',
      targetPracticeDate: '2026-07-29',
      payload: {
        intensity: 'STANDARD',
        desiredQuestionCount: 7,
        focusSubjectIds: [],
        focusChapterIds: [],
      },
      status: 'PENDING',
      submittedByRole: 'MEMBER',
      createdAt: '2026-07-28T19:59:59.000Z',
    }));
    await flushPromises();

    expect(wrapper.emitted('saved')).toBeUndefined();
    expect(wrapper.emitted('conflict')).toHaveLength(1);
    expect(wrapper.find('form').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('今日建议已使用');
  });
});
