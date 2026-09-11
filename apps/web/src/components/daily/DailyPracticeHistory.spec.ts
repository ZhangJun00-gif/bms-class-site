import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DailyPracticeHistory from './DailyPracticeHistory.vue';

function response(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function historyItem(id: string, practiceDate: string) {
  return {
    planRevisionId: id,
    practiceDate,
    status: 'COMPLETED',
    generationSource: 'PRO_MAX',
    generatedAt: `${practiceDate}T04:10:00.000Z`,
    summary: null,
    questionCount: 5,
    fixedQuestionCount: 0,
    attempt: null,
  };
}

describe('DailyPracticeHistory', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the contract questionCount as personalized count without subtracting fixed items', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      items: [{
        planRevisionId: 'plan-1',
        practiceDate: '2026-07-28',
        status: 'COMPLETED',
        generationSource: 'PRO_MAX',
        generatedAt: '2026-07-28T04:10:00.000Z',
        summary: null,
        questionCount: 5,
        fixedQuestionCount: 2,
        attempt: {
          id: 'attempt-1',
          score: 6,
          total: 7,
          submittedAt: '2026-07-28T08:00:00.000Z',
        },
      }],
      total: 1,
      page: 1,
      pageSize: 5,
    }));
    const wrapper = mount(DailyPracticeHistory);
    await flushPromises();

    expect(wrapper.text()).toContain('个性化 5 题 · 固定 2 题');
    expect(wrapper.text()).toContain('得分 6 / 7');
  });

  it('lazy-loads the plan detail once and joins the per-question results', async () => {
    const listPayload = {
      items: [{
        planRevisionId: 'plan-1',
        practiceDate: '2026-07-28',
        status: 'COMPLETED',
        generationSource: 'PRO_MAX',
        generatedAt: '2026-07-28T04:10:00.000Z',
        summary: null,
        questionCount: 1,
        fixedQuestionCount: 1,
        attempt: {
          id: 'attempt-1',
          score: 1,
          total: 2,
          submittedAt: '2026-07-28T08:00:00.000Z',
        },
      }],
      total: 1,
      page: 1,
      pageSize: 5,
    };
    const detailPayload = {
      ...listPayload.items[0],
      summary: {
        headline: '循环系统需要优先复习',
        overview: '',
        dataQuality: 'SUFFICIENT',
        strengths: [],
        priorities: [],
      },
      personalizedItems: [{
        ordinal: 1,
        source: 'PERSONALIZED',
        questionId: 'q-1',
        gradingType: 'SINGLE',
        typeLabel: '单选题',
        subjectId: 'subject-1',
        subject: '生理学',
        chapterIds: [],
        chapters: [],
        prompt: '心室收缩时房室瓣处于什么状态？',
        options: [],
        images: [],
        maxScore: 1,
        reason: '近 7 天错题重现',
        evidenceRefs: [],
      }],
      fixedItems: [{
        ordinal: 2,
        source: 'ADMIN_FIXED',
        questionId: 'q-2',
        gradingType: 'TRUE_FALSE',
        typeLabel: '判断题',
        subjectId: 'subject-1',
        subject: '生理学',
        chapterIds: [],
        chapters: [],
        prompt: '静息电位主要由钾离子外流形成。',
        options: [],
        images: [],
        maxScore: 1,
        reason: '管理员指定',
        evidenceRefs: [],
      }],
      resultSummary: [
        { questionId: 'q-1', correct: false, score: 0, maxScore: 1 },
        { questionId: 'q-2', correct: true, score: 1, maxScore: 1 },
      ],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/daily-practice/history/plan-1')) {
        return response(detailPayload);
      }
      return response(listPayload);
    });
    const wrapper = mount(DailyPracticeHistory);
    await flushPromises();

    const toggle = wrapper.get('.history-detail-toggle');
    await toggle.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('循环系统需要优先复习');
    expect(wrapper.text()).toContain('心室收缩时房室瓣处于什么状态？');
    expect(wrapper.text()).toContain('管理员指定');
    expect(wrapper.text()).toContain('答错');
    expect(wrapper.text()).toContain('答对');
    const detailCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/daily-practice/history/plan-1'),
    );
    expect(detailCalls).toHaveLength(1);

    await toggle.trigger('click');
    await toggle.trigger('click');
    await flushPromises();
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith('/daily-practice/history/plan-1'),
      ),
    ).toHaveLength(1);
  });

  it('shows a retryable error when the detail load fails', async () => {
    const listPayload = {
      items: [{
        planRevisionId: 'plan-1',
        practiceDate: '2026-07-28',
        status: 'READY',
        generationSource: 'DETERMINISTIC',
        generatedAt: '2026-07-28T04:10:00.000Z',
        summary: null,
        questionCount: 1,
        fixedQuestionCount: 0,
        attempt: null,
      }],
      total: 1,
      page: 1,
      pageSize: 5,
    };
    let detailCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/daily-practice/history/plan-1')) {
        detailCalls += 1;
        return new Response('boom', { status: 500 });
      }
      return response(listPayload);
    });
    const wrapper = mount(DailyPracticeHistory);
    await flushPromises();

    await wrapper.get('.history-detail-toggle').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('请求失败');
    expect(detailCalls).toBe(1);

    await wrapper.get('.detail-error button').trigger('click');
    await flushPromises();
    expect(detailCalls).toBe(2);
  });

  it('keeps the stable history visible when pagination fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.searchParams.get('page') === '2') {
        return new Response('boom', { status: 500 });
      }
      return response({
        items: [historyItem('plan-stable', '2026-07-28')],
        total: 6,
        page: 1,
        pageSize: 5,
      });
    });
    const wrapper = mount(DailyPracticeHistory);
    await flushPromises();

    wrapper.findComponent({ name: 'PaginationControl' }).vm.$emit('update:page', 2);
    await flushPromises();

    expect(wrapper.text()).toContain('2026-07-28');
    expect(wrapper.get('.alert.error').text()).toContain('请求失败');
    expect(wrapper.findComponent({ name: 'PaginationControl' }).props('page')).toBe(1);
  });

  it('corrects a page that became out of range without recursive requests', async () => {
    const requestedPages: string[] = [];
    let pageOneCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      const requestedPage = url.searchParams.get('page') ?? '';
      requestedPages.push(requestedPage);
      if (requestedPage === '2') {
        return response({ items: [], total: 1, page: 2, pageSize: 5 });
      }
      pageOneCalls += 1;
      return response({
        items: [
          historyItem(
            pageOneCalls === 1 ? 'plan-initial' : 'plan-corrected',
            pageOneCalls === 1 ? '2026-07-28' : '2026-07-29',
          ),
        ],
        total: pageOneCalls === 1 ? 6 : 1,
        page: 1,
        pageSize: 5,
      });
    });
    const wrapper = mount(DailyPracticeHistory);
    await flushPromises();

    wrapper.findComponent({ name: 'PaginationControl' }).vm.$emit('update:page', 2);
    await flushPromises();

    expect(requestedPages).toEqual(['1', '2', '1']);
    expect(wrapper.text()).toContain('2026-07-29');
    expect(wrapper.text()).not.toContain('2026-07-28');
    expect(wrapper.findComponent({ name: 'PaginationControl' }).props('page')).toBe(1);
  });
});
