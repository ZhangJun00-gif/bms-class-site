import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminDailyUsers from './AdminDailyUsers.vue';

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

const userSummary = {
  id: 'user-1',
  displayName: '测试用户',
  role: 'MEMBER',
  status: 'ACTIVE',
  initializationStatus: 'READY',
  initializationProgress: 100,
  todayStatus: 'READY',
  generationSource: 'PRO_MAX',
  completed: false,
  summaryUpdatedAt: '2026-07-28T08:00:00.000Z',
  suggestionStatus: null,
} as const;

function userDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...userSummary,
    profileRevision: 7,
    summary: null,
    knowledgeStates: [],
    knowledgeStatesTotal: 0,
    chapterStates: [],
    chapterStatesTotal: 0,
    todayPlan: null,
    planRevisions: [],
    planRevisionsTotal: 0,
    suggestions: [],
    suggestionsTotal: 0,
    ...overrides,
  };
}

describe('AdminDailyUsers', () => {
  beforeEach(() => confirmMock.mockResolvedValue(true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders completion and summary freshness and sends the gap filter', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      items: [{
        id: 'user-1',
        displayName: '测试用户',
        role: 'MEMBER',
        status: 'ACTIVE',
        initializationStatus: 'READY',
        initializationProgress: 100,
        todayStatus: 'COMPLETED',
        generationSource: 'PRO_MAX',
        completed: true,
        summaryUpdatedAt: '2026-07-28T08:00:00.000Z',
        suggestionStatus: null,
      }],
      total: 1,
      page: 1,
      pageSize: 20,
    }));
    const wrapper = mount(AdminDailyUsers);
    await flushPromises();

    expect(wrapper.get('td[data-label="完成"]').text()).toBe('已完成');
    expect(wrapper.get('td[data-label="总结更新"]').text()).not.toBe('尚无总结');

    await wrapper.get('#daily-user-gap').setValue('true');
    await flushPromises();

    const latestUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost');
    expect(latestUrl.searchParams.get('hasGap')).toBe('true');
  });

  it('renders a compact today-plan diagnostic snapshot without raw model payloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/users/user-1')) {
        const personalizedItem = {
          ordinal: 1,
          source: 'PERSONALIZED',
          questionId: 'question-1',
          gradingType: 'SINGLE',
          typeLabel: '单选题',
          subjectId: 'subject-1',
          subject: '生理学',
          chapterIds: ['chapter-1'],
          chapters: [{ id: 'chapter-1', name: '循环', slug: 'circulation' }],
          prompt: '最终个性化题干',
          options: [],
          images: [],
          maxScore: 1,
          reason: '对应近期错题',
          evidenceRefs: ['S001'],
        };
        return response({
          id: 'user-1', displayName: '测试用户', role: 'MEMBER', status: 'ACTIVE',
          initializationStatus: 'READY', initializationProgress: 100,
          todayStatus: 'READY', generationSource: 'PRO_MAX', completed: false,
          summaryUpdatedAt: '2026-07-28T08:00:00.000Z', suggestionStatus: null,
          profileRevision: 7,
          summary: null,
          knowledgeStates: Array.from({ length: 11 }, (_, index) => ({
            id: `knowledge-${index}`,
            subjectId: 'subject-1',
            subject: '生理学',
            label: `知识点 ${index + 1}`,
            masteryBps: 5000,
            attemptCount: 2,
            wrongCount: 1,
            nextReviewAt: null,
            lastPracticedAt: null,
          })),
          knowledgeStatesTotal: 12,
          chapterStates: [{
            id: 'chapter-state-1',
            subjectId: 'subject-1',
            subject: '生理学',
            label: '循环',
            masteryBps: 6000,
            attemptCount: 3,
            wrongCount: 1,
            nextReviewAt: null,
            lastPracticedAt: null,
          }],
          chapterStatesTotal: 4,
          planRevisions: [],
          planRevisionsTotal: 5,
          suggestions: [],
          suggestionsTotal: 3,
          rawPayload: 'SECRET_RAW_PAYLOAD',
          answer: 'SECRET_ANSWER',
          reasoning: 'SECRET_REASONING',
          todayPlan: {
            dayId: 'day-1',
            practiceDate: '2026-07-28',
            profileRevision: 7,
            progressSetHash: 'progress-hash-1234567890abcdef',
            candidateHash: 'candidate-hash-1234567890abcdef',
            inputHash: 'input-hash-1234567890abcdef',
            outputHash: 'output-hash-1234567890abcdef',
            rawPayload: 'SECRET_RAW_PAYLOAD',
            answer: 'SECRET_ANSWER',
            reasoning: 'SECRET_REASONING',
            candidateQuestions: [{
              questionId: 'question-1', questionAlias: 'Q001', gradingType: 'SINGLE',
              typeLabel: '单选题', promptExcerpt: '候选题干摘要', knowledgeAliases: ['K001'],
              chapterAliases: ['C001'], priorityScore: 88,
              answer: 'SECRET_ANSWER', reasoning: 'SECRET_REASONING',
            }],
            personalizedItems: [{ ...personalizedItem, answer: 'SECRET_ANSWER', reasoning: 'SECRET_REASONING' }],
            fixedItems: [{ ...personalizedItem, ordinal: 2, source: 'ADMIN_FIXED', questionId: 'fixed-1', prompt: '最终固定题干' }],
            fixedAssignment: {
              assignmentId: 'assignment-1',
              hash: 'fixed-assignment-hash-1234567890abcdef',
              validCount: 1,
              invalidCount: 1,
              invalidQuestionIds: ['invalid-question-id-1234567890'],
              questions: [{
                questionId: 'fixed-1', ordinal: 1, gradingType: 'SINGLE', typeLabel: '单选题',
                promptExcerpt: '冻结固定题摘要', subjectId: 'subject-1', subject: '生理学',
                chapterIds: ['chapter-1'], promptHash: 'prompt-hash-1234567890abcdef',
              }],
            },
          },
        });
      }
      return response({
        items: [{
          id: 'user-1', displayName: '测试用户', role: 'MEMBER', status: 'ACTIVE',
          initializationStatus: 'READY', initializationProgress: 100,
          todayStatus: 'READY', generationSource: 'PRO_MAX', completed: false,
          summaryUpdatedAt: '2026-07-28T08:00:00.000Z', suggestionStatus: null,
        }],
        total: 1, page: 1, pageSize: 20,
      });
    });
    const wrapper = mount(AdminDailyUsers);
    await flushPromises();
    await wrapper.get('.action-link').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('今日计划诊断');
    expect(wrapper.text()).toContain('候选题干摘要');
    expect(wrapper.text()).toContain('最终个性化题干');
    expect(wrapper.text()).toContain('最终固定题干');
    expect(wrapper.text()).toContain('有效 1 · 失效 1');
    expect(wrapper.findAll('.list-count').map((item) => item.text())).toEqual([
      '显示 10 / 共 12',
      '显示 1 / 共 4',
      '显示 0 / 共 5',
      '显示 0 / 共 3',
    ]);
    expect(wrapper.find('code[title="progress-hash-1234567890abcdef"]').exists()).toBe(true);
    expect(wrapper.find('code[title="fixed-assignment-hash-1234567890abcdef"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('SECRET_RAW_PAYLOAD');
    expect(wrapper.text()).not.toContain('SECRET_ANSWER');
    expect(wrapper.text()).not.toContain('SECRET_REASONING');
  });

  it('traps focus in the modal drawer, closes on Escape, and restores the trigger', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/users/user-1')) return response(userDetail());
      return response({ items: [userSummary], total: 1, page: 1, pageSize: 20 });
    });
    const wrapper = mount(AdminDailyUsers, { attachTo: document.body });
    await flushPromises();
    const trigger = wrapper.get('.action-link');
    await trigger.trigger('click');
    await flushPromises();

    const dialog = wrapper.get('[role="dialog"]');
    const closeButton = wrapper.get('button[aria-label="关闭用户详情"]');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(closeButton.element);

    const enabledButtons = dialog.findAll('button:not([disabled])');
    const lastButton = enabledButtons.at(-1)!;
    (lastButton.element as HTMLButtonElement).focus();
    await dialog.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton.element);

    await dialog.trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });

  it('supports admin suggestions and both plan actions without applying today status to another date', async () => {
    const completedDetail = userDetail({ todayStatus: 'COMPLETED', completed: true });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/suggestions') && options?.method === 'POST') {
        const payload = JSON.parse(String(options.body));
        return response({
          id: 'suggestion-1', targetPracticeDate: payload.targetPracticeDate,
          payload, status: 'PENDING', submittedByRole: 'ADMIN',
          createdAt: '2026-07-28T08:00:00.000Z',
        });
      }
      if ((url.pathname.endsWith('/regenerate') || url.pathname.endsWith('/preview')) && options?.method === 'POST') {
        return response({ dayId: 'day-1', planRevisionId: 'plan-1', trigger: 'ADMIN_PREVIEW' });
      }
      if (url.pathname.endsWith('/users/user-1')) return response(completedDetail);
      return response({ items: [{ ...userSummary, todayStatus: 'COMPLETED', completed: true }], total: 1, page: 1, pageSize: 20 });
    });
    const wrapper = mount(AdminDailyUsers);
    await flushPromises();
    await wrapper.get('.action-link').trigger('click');
    await flushPromises();

    expect((wrapper.get('.regenerate-button').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get('#admin-suggestion-note').setValue('加强循环复习');
    await wrapper.findAll('button').find((button) => button.text().includes('提交管理员建议'))!.trigger('click');
    await flushPromises();

    await wrapper.get('#admin-action-date').setValue('2026-08-01');
    const regenerate = wrapper.get('.regenerate-button');
    await vi.waitFor(() => {
      expect((regenerate.element as HTMLButtonElement).disabled).toBe(false);
    });
    await regenerate.trigger('click');
    await flushPromises();
    await wrapper.get('.preview-button').trigger('click');
    await flushPromises();

    const postUrls = fetchMock.mock.calls
      .filter(([, options]) => options?.method === 'POST')
      .map(([input]) => String(input));
    expect(postUrls.some((url) => url.endsWith('/users/user-1/suggestions'))).toBe(true);
    expect(postUrls.some((url) => url.endsWith('/plans/2026-08-01/regenerate'))).toBe(true);
    expect(postUrls.some((url) => url.endsWith('/plans/2026-08-01/preview'))).toBe(true);
  });

  it('reloads the authoritative user detail after a regenerate conflict', async () => {
    let detailCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/regenerate') && options?.method === 'POST') {
        return response({ message: '计划已经开始' }, 409);
      }
      if (url.pathname.endsWith('/users/user-1')) {
        detailCalls += 1;
        return response(userDetail({
          todayStatus: detailCalls === 1 ? 'READY' : 'STARTED',
        }));
      }
      return response({
        items: [userSummary],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });
    const wrapper = mount(AdminDailyUsers);
    await flushPromises();
    await wrapper.get('.action-link').trigger('click');
    await flushPromises();

    await wrapper.get('.regenerate-button').trigger('click');
    await flushPromises();

    expect(detailCalls).toBe(2);
    expect((wrapper.get('.regenerate-button').element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });

  it('keeps the stable user list visible when a page request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.searchParams.get('page') === '2') {
        return response({ message: 'temporary failure' }, 500);
      }
      return response({ items: [userSummary], total: 21, page: 1, pageSize: 20 });
    });
    const wrapper = mount(AdminDailyUsers);
    await flushPromises();

    wrapper.findComponent({ name: 'PaginationControl' }).vm.$emit('update:page', 2);
    await flushPromises();

    expect(wrapper.text()).toContain('测试用户');
    expect(wrapper.get('.alert.error').text()).toContain('temporary failure');
    expect(wrapper.findComponent({ name: 'PaginationControl' }).props('page')).toBe(1);
    wrapper.unmount();
  });

  it('corrects a user page that became out of range once', async () => {
    const requestedPages: string[] = [];
    let pageOneCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      const requestedPage = url.searchParams.get('page') ?? '';
      requestedPages.push(requestedPage);
      if (requestedPage === '3') {
        return response({ items: [], total: 1, page: 3, pageSize: 20 });
      }
      pageOneCalls += 1;
      return response({
        items: [{
          ...userSummary,
          id: pageOneCalls === 1 ? 'user-initial' : 'user-corrected',
          displayName: pageOneCalls === 1 ? '初始用户' : '纠偏用户',
        }],
        total: pageOneCalls === 1 ? 41 : 1,
        page: 1,
        pageSize: 20,
      });
    });
    const wrapper = mount(AdminDailyUsers);
    await flushPromises();

    wrapper.findComponent({ name: 'PaginationControl' }).vm.$emit('update:page', 3);
    await flushPromises();

    expect(requestedPages).toEqual(['1', '3', '1']);
    expect(wrapper.text()).toContain('纠偏用户');
    expect(wrapper.text()).not.toContain('初始用户');
    expect(wrapper.findComponent({ name: 'PaginationControl' }).props('page')).toBe(1);
    wrapper.unmount();
  });
});
