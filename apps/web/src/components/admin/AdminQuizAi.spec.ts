import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminQuizAi from './AdminQuizAi.vue';

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));

const subject = {
  id: 'subject-1',
  name: '生理学',
  slug: 'physiology',
  sortOrder: 10,
  active: true,
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function reviewItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'SINGLE',
    typeLabel: '单选题',
    subjectId: subject.id,
    subject: { id: subject.id, name: subject.name, slug: subject.slug },
    chapterIds: [],
    chapters: [],
    prompt: `题干 ${id}`,
    reviewStatus: 'APPROVED',
    reviewRevision: 2,
    sourceReviewStatus: 'REVIEW_REQUIRED',
    sourceReviewRequiredAt: '2026-07-30T04:00:00.000Z',
    author: { id: 'user-1', displayName: '系统' },
    generationJob: null,
    createdAt: '2026-07-29T04:00:00.000Z',
    updatedAt: '2026-07-29T04:00:00.000Z',
    ...overrides,
  };
}

describe('AdminQuizAi', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exposes Max as a production option and sends only the business complexity', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/chapters')) {
        return response([
          { id: 'chapter-1', subjectId: subject.id, name: '循环', slug: 'circulation', sortOrder: 1, active: true },
        ]);
      }
      if (url.pathname.endsWith('/sources/libraries')) {
        return response({
          items: [{ id: 'library-1', name: '生理学教材', subjectId: subject.id, nodeCount: 1, chunkCount: 2 }],
          total: 1,
        });
      }
      if (url.pathname.endsWith('/nodes')) {
        return response({
          items: [{
            id: 'node-1', parentId: null, level: 2, title: '心动周期', titleMarkdown: '心动周期',
            path: 'heart-cycle', breadcrumb: '循环 / 心动周期', sortOrder: 1,
            hasChildren: false, leafNodeCount: 1, leafNodeIds: ['node-1'],
            libraryChapterId: 'library-chapter-1', documentId: 'document-1',
            documentVersionId: 'version-1', chunkCount: 2, tokenCount: 320,
          }],
          total: 1,
          page: 1,
        });
      }
      if (url.pathname.endsWith('/question-generation-jobs/preview') && init?.method === 'POST') {
        return response({
          chapterCount: 1, nodeCount: 1, chunkCount: 2, evidenceTokens: 320,
          dedupCandidates: 8, requestedCount: 5, strategy: 'PRO_MAX',
          model: 'deepseek-v4-flash', sourceRevision: 'revision',
          promptVersion: 'question-generation-v1', maxOutputTokens: 8000,
        });
      }
      if (url.pathname.endsWith('/question-generation-jobs')) {
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      }
      return response({ items: [], total: 0 });
    });

    const wrapper = mount(AdminQuizAi, { props: { subjects: [subject] } });
    await flushPromises();
    await wrapper.get('.choice-list input[type="checkbox"]').setValue(true);
    await wrapper.get('.node-label input[type="checkbox"]').setValue(true);
    await wrapper.get('input[value="MAX"]').setValue(true);
    await wrapper.get('.generation-form').trigger('submit');
    await flushPromises();

    const previewCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input).includes('/preview') && init?.method === 'POST',
    );
    const payload = JSON.parse(String(previewCall?.[1]?.body));
    expect(payload.complexity).toBe('MAX');
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('reasoning_effort');
    expect(wrapper.text()).toContain('Flash · Max');
    expect(wrapper.text()).not.toContain('PRO_MAX');
    expect(wrapper.text()).toContain('极深推理（Max）');
  });

  it('selects a valid subject supplied by an admin deep link', async () => {
    const secondSubject = {
      id: 'subject-2',
      name: '病理学',
      slug: 'pathology',
      sortOrder: 20,
      active: true,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/chapters')) return response([]);
      if (url.pathname.endsWith('/sources/libraries')) return response({ items: [], total: 0 });
      if (url.pathname.endsWith('/question-generation-jobs')) {
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      }
      return response({ items: [], total: 0 });
    });

    const wrapper = mount(AdminQuizAi, {
      props: {
        subjects: [subject, secondSubject],
        initialSubjectId: 'subject-2',
      },
    });
    await flushPromises();

    expect((wrapper.get('#ai-subject').element as HTMLSelectElement).value).toBe('subject-2');
  });

  it('paginates the review queue instead of hard-coding the first page', async () => {
    const queueCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/chapters')) return response([]);
      if (url.pathname.endsWith('/sources/libraries')) return response({ items: [], total: 0 });
      if (url.pathname.endsWith('/question-generation-jobs')) {
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      }
      if (url.pathname.endsWith('/question-reviews')) {
        const page = Number(url.searchParams.get('page') ?? '1');
        queueCalls.push(`${url.searchParams.get('reviewStatus')}:${page}:${url.searchParams.get('pageSize')}`);
        const items = page === 1
          ? Array.from({ length: 50 }, (_, index) => reviewItem(`q-${index + 1}`))
          : [reviewItem('q-51')];
        return response({ items, total: 51, page, pageSize: 50 });
      }
      return response({ items: [], total: 0 });
    });

    const wrapper = mount(AdminQuizAi, { props: { subjects: [subject] } });
    await flushPromises();
    await wrapper.findAll('.ai-subtabs button')[1]!.trigger('click');
    await flushPromises();
    expect(queueCalls).toContain('DRAFT_REVIEW:1:50');

    const pageButtons = wrapper.findAll('.queue-pagination .pagination-page');
    expect(pageButtons.length).toBe(2);
    await pageButtons[1]!.trigger('click');
    await flushPromises();
    expect(queueCalls).toContain('DRAFT_REVIEW:2:50');

    await wrapper.findAll('.review-filters select')[0]!.setValue('APPROVED');
    await flushPromises();
    expect(queueCalls.at(-1)).toBe('APPROVED:1:50');
    wrapper.unmount();
  });

  it('bulk rebinds the filtered queue after confirmation and lists failures', async () => {
    confirmMock.mockResolvedValue(true);
    const bulkCalls: string[] = [];
    let resolveBulk!: (value: Response) => void;
    const bulkResponse = new Promise<Response>((resolve) => { resolveBulk = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/chapters')) return response([]);
      if (url.pathname.endsWith('/sources/libraries')) return response({ items: [], total: 0 });
      if (url.pathname.endsWith('/question-generation-jobs')) {
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      }
      if (url.pathname.endsWith('/revalidate-source/bulk') && init?.method === 'POST') {
        bulkCalls.push(String(init.body));
        return bulkResponse;
      }
      if (url.pathname.endsWith('/question-reviews')) {
        return response({
          items: [reviewItem('q-1'), reviewItem('q-2')],
          total: 2,
          page: 1,
          pageSize: 50,
        });
      }
      return response({ items: [], total: 0 });
    });

    const wrapper = mount(AdminQuizAi, { props: { subjects: [subject] } });
    await flushPromises();
    await wrapper.findAll('.ai-subtabs button')[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.find('.queue-tools').exists()).toBe(false);

    await wrapper.findAll('.review-filters select')[1]!.setValue('REVIEW_REQUIRED');
    await flushPromises();
    const bulkButton = wrapper.get('.queue-tools button');
    await bulkButton.trigger('click');
    await flushPromises();
    expect(wrapper.get('.review-filters select').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.review-list button').attributes('disabled')).toBeDefined();

    resolveBulk(response({
      results: [
        { questionId: 'q-1', status: 'REVALIDATED', reason: null, sourceRevision: 3 },
        { questionId: 'q-2', status: 'FAILED', reason: 'SOURCE_NODE_AMBIGUOUS', sourceRevision: null },
      ],
    }));
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(bulkCalls).toHaveLength(1);
    expect(JSON.parse(bulkCalls[0]!).questionIds).toEqual(['q-1', 'q-2']);
    expect(wrapper.text()).toContain('重绑完成：成功 1 · 跳过 0 · 失败 1');
    expect(wrapper.text()).toContain('以下题目未能自动重绑');
    expect(wrapper.text()).toContain('存在多个候选文档，需人工选择');
    wrapper.unmount();
  });

  it('refreshes the authoritative review queue after a bulk rebind conflict', async () => {
    confirmMock.mockResolvedValue(true);
    let queueReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/chapters')) return response([]);
      if (url.pathname.endsWith('/sources/libraries')) {
        return response({ items: [], total: 0 });
      }
      if (url.pathname.endsWith('/question-generation-jobs')) {
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      }
      if (url.pathname.endsWith('/revalidate-source/bulk') && init?.method === 'POST') {
        return response({ message: '审核队列已变化' }, 409);
      }
      if (url.pathname.endsWith('/question-reviews')) {
        queueReads += 1;
        return response({
          items: [reviewItem('q-1')],
          total: 1,
          page: 1,
          pageSize: 50,
        });
      }
      return response({ items: [], total: 0 });
    });

    const wrapper = mount(AdminQuizAi, { props: { subjects: [subject] } });
    await flushPromises();
    await wrapper.findAll('.ai-subtabs button')[1]!.trigger('click');
    await flushPromises();
    await wrapper.findAll('.review-filters select')[1]!.setValue('REVIEW_REQUIRED');
    await flushPromises();
    const readsBeforeMutation = queueReads;

    await wrapper.get('.queue-tools button').trigger('click');
    await flushPromises();

    expect(queueReads).toBe(readsBeforeMutation + 1);
    expect(wrapper.text()).toContain('审核队列已变化');
    expect(wrapper.get('.review-filters select').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('auto-rebinds a single question from the detail panel', async () => {
    const detail = {
      id: 'q-1',
      gradingType: 'SINGLE',
      typeLabel: '单选题',
      subjectId: subject.id,
      subject: { id: subject.id, name: subject.name, slug: subject.slug },
      chapterIds: [],
      chapters: [],
      category: 'KNOWLEDGE_RECALL',
      origin: 'AI_GENERATED',
      prompt: '题干 q-1',
      options: [{ id: 'A', text: '选项 A' }],
      correctAnswer: ['A'],
      gradingRubric: null,
      maxScore: 1,
      explanation: '解析',
      reviewStatus: 'DRAFT_REVIEW',
      reviewRevision: 2,
      sourceRevision: 2,
      sourceReviewStatus: 'REVIEW_REQUIRED',
      sourceReviewRequiredAt: '2026-07-30T04:00:00.000Z',
      originalGenerated: null,
      sources: [],
      events: [],
      createdAt: '2026-07-29T04:00:00.000Z',
      updatedAt: '2026-07-29T04:00:00.000Z',
    };
    const bulkCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/chapters')) return response([]);
      if (url.pathname.endsWith('/sources/libraries')) return response({ items: [], total: 0 });
      if (url.pathname.endsWith('/nodes')) return response({ items: [], total: 0, page: 1 });
      if (url.pathname.endsWith('/question-generation-jobs')) {
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      }
      if (url.pathname.endsWith('/revalidate-source/bulk') && init?.method === 'POST') {
        bulkCalls.push(String(init.body));
        return response({
          results: [{ questionId: 'q-1', status: 'REVALIDATED', reason: null, sourceRevision: 3 }],
        });
      }
      if (url.pathname.endsWith('/question-reviews/q-1')) return response(detail);
      if (url.pathname.endsWith('/question-reviews')) {
        return response({ items: [reviewItem('q-1')], total: 1, page: 1, pageSize: 50 });
      }
      return response({ items: [], total: 0 });
    });

    const wrapper = mount(AdminQuizAi, { props: { subjects: [subject] } });
    await flushPromises();
    await wrapper.findAll('.ai-subtabs button')[1]!.trigger('click');
    await flushPromises();
    await wrapper.get('.review-list button').trigger('click');
    await flushPromises();

    const autoButton = wrapper
      .findAll('.revalidate-auto button')
      .find((button) => button.text().includes('自动匹配并重绑'));
    expect(autoButton).toBeDefined();
    await autoButton!.trigger('click');
    await flushPromises();

    expect(JSON.parse(bulkCalls[0]!).questionIds).toEqual(['q-1']);
    expect(wrapper.text()).toContain('来源已自动重绑并恢复有效');
    wrapper.unmount();
  });

  it('clears the previous review while a new detail loads and keeps it cleared on failure', async () => {
    const detail = {
      id: 'q-1', gradingType: 'SINGLE', typeLabel: '单选题', subjectId: subject.id,
      subject: { id: subject.id, name: subject.name, slug: subject.slug }, chapterIds: [], chapters: [],
      category: 'KNOWLEDGE_RECALL', origin: 'AI_GENERATED', prompt: '旧详情题干',
      options: [{ id: 'A', text: '答案' }], correctAnswer: ['A'], gradingRubric: null,
      maxScore: 1, explanation: '解析', reviewStatus: 'DRAFT_REVIEW', reviewRevision: 1,
      sourceRevision: 1, sourceReviewStatus: 'VALID', sourceReviewRequiredAt: null,
      originalGenerated: null, sources: [], events: [], createdAt: '', updatedAt: '',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/chapters')) return response([]);
      if (url.pathname.endsWith('/sources/libraries')) return response({ items: [], total: 0 });
      if (url.pathname.endsWith('/question-generation-jobs'))
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      if (url.pathname.endsWith('/question-reviews/q-1')) return response(detail);
      if (url.pathname.endsWith('/question-reviews/q-2')) throw new Error('详情读取失败');
      if (url.pathname.endsWith('/question-reviews'))
        return response({ items: [reviewItem('q-1'), reviewItem('q-2')], total: 2, page: 1, pageSize: 50 });
      return response({ items: [], total: 0 });
    });
    const wrapper = mount(AdminQuizAi, { props: { subjects: [subject] } });
    await flushPromises();
    await wrapper.findAll('.ai-subtabs button')[1]!.trigger('click');
    await flushPromises();
    await wrapper.findAll('.review-list button')[0]!.trigger('click');
    await flushPromises();
    expect((wrapper.get('#review-prompt').element as HTMLTextAreaElement).value).toBe('旧详情题干');

    await wrapper.findAll('.review-list button')[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.find('#review-prompt').exists()).toBe(false);
    expect(wrapper.text()).toContain('详情读取失败');
    wrapper.unmount();
  });

  it('fences review navigation during rejection and refreshes the captured question on 409', async () => {
    let detailReads = 0;
    let resolveReject!: (value: Response) => void;
    const rejectPromise = new Promise<Response>((resolve) => { resolveReject = resolve; });
    const detailFor = () => ({
      id: 'q-1', gradingType: 'SINGLE', typeLabel: '单选题', subjectId: subject.id,
      subject: { id: subject.id, name: subject.name, slug: subject.slug }, chapterIds: [], chapters: [],
      category: 'KNOWLEDGE_RECALL', origin: 'AI_GENERATED', prompt: '待拒绝题目',
      options: [{ id: 'A', text: '答案' }], correctAnswer: ['A'], gradingRubric: null,
      maxScore: 1, explanation: '解析', reviewStatus: 'DRAFT_REVIEW',
      reviewRevision: detailReads > 1 ? 2 : 1, sourceRevision: 1, sourceReviewStatus: 'VALID',
      sourceReviewRequiredAt: null, originalGenerated: null, sources: [], events: [],
      createdAt: '', updatedAt: '',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/chapters')) return response([]);
      if (url.pathname.endsWith('/sources/libraries')) return response({ items: [], total: 0 });
      if (url.pathname.endsWith('/question-generation-jobs'))
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      if (url.pathname.endsWith('/question-reviews/q-1/reject') && init?.method === 'POST')
        return rejectPromise;
      if (url.pathname.endsWith('/question-reviews/q-1')) {
        detailReads += 1;
        return response(detailFor());
      }
      if (url.pathname.endsWith('/question-reviews'))
        return response({ items: [reviewItem('q-1', { reviewStatus: 'DRAFT_REVIEW' })], total: 1, page: 1, pageSize: 50 });
      return response({ items: [], total: 0 });
    });
    const wrapper = mount(AdminQuizAi, { props: { subjects: [subject] } });
    await flushPromises();
    await wrapper.findAll('.ai-subtabs button')[1]!.trigger('click');
    await flushPromises();
    await wrapper.get('.review-list button').trigger('click');
    await flushPromises();
    const rejectDialog = wrapper.get('.reject-dialog').element as HTMLDialogElement;
    rejectDialog.showModal = vi.fn();
    rejectDialog.close = vi.fn();
    await wrapper.findAll('.review-actions button')[1]!.trigger('click');
    await wrapper.get('#reject-reason').setValue('来源不足');
    await wrapper.get('.reject-dialog form').trigger('submit');
    await flushPromises();

    expect(wrapper.get('.review-filters select').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.review-list button').attributes('disabled')).toBeDefined();
    resolveReject(response({ message: '审核版本已变化' }, 409));
    await flushPromises();

    const rejectCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/q-1/reject'));
    expect(JSON.parse(String(rejectCall?.[1]?.body))).toEqual({ expectedRevision: 1, reason: '来源不足' });
    expect(detailReads).toBe(2);
    expect(wrapper.get('.review-filters select').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('keeps approved questions read-only and reopens them only after confirmation', async () => {
    confirmMock.mockClear();
    confirmMock.mockResolvedValue(true);
    let reopened = false;
    const detailFor = () => ({
      id: 'q-approved', gradingType: 'SINGLE', typeLabel: '单选题', subjectId: subject.id,
      subject: { id: subject.id, name: subject.name, slug: subject.slug }, chapterIds: [], chapters: [],
      category: 'KNOWLEDGE_RECALL', origin: 'AI_GENERATED', prompt: '已批准题目',
      options: [{ id: 'A', text: '答案' }], correctAnswer: ['A'], gradingRubric: null,
      maxScore: 1, explanation: '解析', reviewStatus: reopened ? 'DRAFT_REVIEW' : 'APPROVED',
      reviewRevision: reopened ? 4 : 3, sourceRevision: 1, sourceReviewStatus: 'VALID',
      sourceReviewRequiredAt: null, originalGenerated: null, sources: [], events: [],
      createdAt: '2026-07-29T04:00:00.000Z', updatedAt: '2026-07-29T04:00:00.000Z',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/chapters')) return response([]);
      if (url.pathname.endsWith('/sources/libraries')) return response({ items: [], total: 0 });
      if (url.pathname.endsWith('/question-generation-jobs'))
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      if (url.pathname.endsWith('/question-reviews/q-approved/reopen') && init?.method === 'POST') {
        reopened = true;
        return response({ reopened: true });
      }
      if (url.pathname.endsWith('/question-reviews/q-approved')) return response(detailFor());
      if (url.pathname.endsWith('/question-reviews'))
        return response({ items: [reviewItem('q-approved', { reviewStatus: reopened ? 'DRAFT_REVIEW' : 'APPROVED' })], total: 1, page: 1, pageSize: 50 });
      return response({ items: [], total: 0 });
    });

    const wrapper = mount(AdminQuizAi, { props: { subjects: [subject] } });
    await flushPromises();
    await wrapper.findAll('.ai-subtabs button')[1]!.trigger('click');
    await flushPromises();
    await wrapper.get('.review-list button').trigger('click');
    await flushPromises();

    expect(wrapper.get('#review-prompt').attributes('disabled')).toBeDefined();
    const reopen = wrapper.findAll('.review-actions button').find((button) => button.text().includes('撤回并重新审核'))!;
    await reopen.trigger('click');
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const reopenCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/q-approved/reopen'));
    expect(JSON.parse(String(reopenCall?.[1]?.body))).toEqual({ expectedRevision: 3 });
    expect(wrapper.get('#review-prompt').attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).toContain('题目已撤回，可以重新编辑审核');
    wrapper.unmount();
  });

  it('does not read while hidden and reloads each data source once when restored', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/chapters')) return response([]);
      if (url.pathname.endsWith('/sources/libraries')) return response({ items: [], total: 0 });
      if (url.pathname.endsWith('/question-generation-jobs'))
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      return response({ items: [], total: 0 });
    });
    const wrapper = mount(AdminQuizAi, {
      props: { subjects: [subject], active: false },
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
