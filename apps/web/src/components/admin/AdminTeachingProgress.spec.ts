import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminTeachingProgress from './AdminTeachingProgress.vue';

vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}));

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const subjectsPayload = [
  { id: 'subject-1', name: '生理学', slug: 'physiology', sortOrder: 1, active: true },
];

function progressSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'progress-1',
    subject: { id: 'subject-1', name: '生理学', slug: 'physiology' },
    version: 3,
    effectivePracticeDate: '2026-07-29',
    changeType: 'ADD',
    note: null,
    correctionReason: null,
    scopeHash: 'scope',
    nodeCount: 2,
    publishedBy: null,
    publishedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

function resolvedNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snapshot-1',
    libraryId: 'library-1',
    documentId: 'document-1',
    nodePathHash: 'resolved-hash',
    currentKnowledgeNodeId: 'node-current',
    title: '心动周期',
    breadcrumb: '循环 / 心动周期',
    firstTaughtDate: '2026-07-20',
    resolved: true,
    remapped: false,
    resolvedDocumentId: 'document-1',
    ...overrides,
  };
}

function unresolvedNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snapshot-2',
    libraryId: 'library-old',
    documentId: 'document-old',
    nodePathHash: 'missing-hash',
    currentKnowledgeNodeId: null,
    title: '旧版微循环节点',
    breadcrumb: '旧教材 / 微循环',
    firstTaughtDate: '2026-07-21',
    resolved: false,
    remapped: false,
    resolvedDocumentId: null,
    ...overrides,
  };
}

function progressDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...progressSummary(),
    basedOnProgressId: null,
    unresolvedNodeCount: 1,
    eligibleQuestionCount: 5,
    nodes: [resolvedNode(), unresolvedNode()],
    ...overrides,
  };
}

/** 按路径分发教学进度相关请求；libraries 恒为空列表 */
function mockProgressFetch(handlers: {
  summaries?: unknown[];
  details?: Record<string, unknown>;
  onPublish?: (body: unknown) => unknown | Promise<unknown>;
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/subjects')) return response(subjectsPayload);
    if (url.pathname.endsWith('/teaching-progress') && init?.method === 'POST') {
      const result = await handlers.onPublish?.(JSON.parse(String(init.body)));
      return response(result ?? { id: 'progress-2' });
    }
    if (url.pathname.endsWith('/teaching-progress')) {
      return response({
        items: handlers.summaries ?? [progressSummary()],
        total: (handlers.summaries ?? [progressSummary()]).length,
        page: 1,
        pageSize: 20,
      });
    }
    const detailMatch = url.pathname.match(/\/teaching-progress\/([^/]+)$/);
    if (detailMatch && handlers.details?.[detailMatch[1]!]) {
      return response(handlers.details[detailMatch[1]!]);
    }
    if (url.pathname.endsWith('/sources/libraries')) return response({ items: [], total: 0 });
    return response({ message: 'not found' }, 404);
  });
}

describe('AdminTeachingProgress', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts unresolved legacy nodes as an explicit correction instead of deadlocking revisions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const fetchMock = mockProgressFetch({
      details: { 'progress-1': progressDetail() },
    });

    const wrapper = mount(AdminTeachingProgress);
    await flushPromises();

    expect(wrapper.text()).toContain('无法解析的节点');
    expect(wrapper.text()).toContain('旧教材 / 微循环');
    expect(wrapper.text()).toContain('明确计为移除项');
    expect(wrapper.text()).toContain('移除 1');
    expect(wrapper.text()).toContain('CORRECTION');
    expect(wrapper.find('#progress-correction').exists()).toBe(true);
    expect(wrapper.get('.publish-button').attributes('disabled')).toBeUndefined();

    await wrapper.get('#progress-correction').setValue('旧节点已由新版教材结构替代');
    await wrapper.get('.publish-button').trigger('click');
    await flushPromises();

    const publishCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        new URL(String(input), 'http://localhost').pathname.endsWith(
          '/teaching-progress',
        ) && init?.method === 'POST',
    );
    const body = JSON.parse(String(publishCall?.[1]?.body));
    expect(body).toMatchObject({
      changeType: 'CORRECTION',
      correctionReason: '旧节点已由新版教材结构替代',
      effectivePracticeDate: '2026-07-29',
    });
    expect(body.nodes).toEqual([
      { knowledgeNodeId: 'node-current', firstTaughtDate: '2026-07-20' },
    ]);
  });

  it('uses the existing future effective date and disables an unchanged ADD revision', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    mockProgressFetch({
      summaries: [progressSummary({ id: 'progress-future', version: 4, effectivePracticeDate: '2026-08-10' })],
      details: {
        'progress-future': progressDetail({
          id: 'progress-future',
          version: 4,
          effectivePracticeDate: '2026-08-10',
          basedOnProgressId: 'progress-3',
          unresolvedNodeCount: 0,
          nodes: [resolvedNode()],
        }),
      },
    });

    const wrapper = mount(AdminTeachingProgress);
    await flushPromises();

    const date = wrapper.get('#progress-effective-date');
    expect((date.element as HTMLInputElement).value).toBe('2026-08-10');
    expect(date.attributes('min')).toBe('2026-08-10');
    expect(wrapper.get('.publish-button').attributes('disabled')).toBeDefined();
  });

  it('allows the effective practice date to be today and explains the refreeze requirement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    mockProgressFetch({
      summaries: [progressSummary({ version: 1, changeType: 'INITIAL', effectivePracticeDate: '2026-07-28' })],
      details: {
        'progress-1': progressDetail({
          version: 1,
          changeType: 'INITIAL',
          effectivePracticeDate: '2026-07-28',
          unresolvedNodeCount: 0,
          nodes: [resolvedNode()],
        }),
      },
    });

    const wrapper = mount(AdminTeachingProgress);
    await flushPromises();

    const date = wrapper.get('#progress-effective-date');
    expect(date.attributes('min')).toBe('2026-07-28');
    expect((date.element as HTMLInputElement).value).toBe('2026-07-28');
    expect(wrapper.text()).toContain('今日已冻结的周期不会自动更新');
    expect(wrapper.text()).toContain('周期管理');
  });

  it('loads historical versions into the view but keeps publishing anchored to the latest', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const fetchMock = mockProgressFetch({
      summaries: [
        progressSummary(),
        progressSummary({
          id: 'progress-0',
          version: 2,
          changeType: 'INITIAL',
          effectivePracticeDate: '2026-07-20',
          nodeCount: 1,
        }),
      ],
      details: {
        'progress-1': progressDetail({ unresolvedNodeCount: 0, nodes: [resolvedNode()] }),
        'progress-0': progressDetail({
          id: 'progress-0',
          version: 2,
          changeType: 'INITIAL',
          effectivePracticeDate: '2026-07-20',
          nodeCount: 1,
          unresolvedNodeCount: 0,
          nodes: [resolvedNode({ firstTaughtDate: '2026-07-15' })],
        }),
      },
    });

    const wrapper = mount(AdminTeachingProgress);
    await flushPromises();

    const options = wrapper
      .get('#progress-version')
      .findAll('option')
      .map((option) => option.text().replace(/\s+/g, ' ').trim());
    expect(options).toEqual([
      '版本 3 · 新增 · 生效 2026-07-29（当前）',
      '版本 2 · 首次发布 · 生效 2026-07-20',
    ]);
    expect(wrapper.text()).toContain('版本 3');

    await wrapper.get('#progress-version').setValue('progress-0');
    await flushPromises();

    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/teaching-progress/progress-0'),
      ),
    ).toBe(true);
    expect(wrapper.get('.current-progress').text()).toContain('版本 2');
    expect(wrapper.get('.history-banner').text()).toContain('历史版本');
    expect(wrapper.get('.history-banner').text()).toContain('v3');
    expect(wrapper.get('.publish-button').attributes('disabled')).toBeDefined();

    await wrapper.get('#progress-version').setValue('progress-1');
    await flushPromises();

    expect(wrapper.find('.history-banner').exists()).toBe(false);
    expect(wrapper.get('.current-progress').text()).toContain('版本 3');
  });

  it('splits remapped nodes from unresolved ones and counts both in the summary row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    mockProgressFetch({
      details: {
        'progress-1': progressDetail({
          nodes: [
            resolvedNode({
              id: 'snapshot-remapped',
              documentId: 'old-doc-1234567890abcd',
              resolvedDocumentId: 'new-doc-1234567890abcd',
              remapped: true,
            }),
            unresolvedNode(),
          ],
        }),
      },
    });

    const wrapper = mount(AdminTeachingProgress);
    await flushPromises();

    expect(wrapper.get('.current-progress').text()).toContain('1 个节点已重映射');
    expect(wrapper.get('.current-progress').text()).toContain('1 个节点待解析');

    const remappedPanel = wrapper.get('.remapped-baseline');
    expect(remappedPanel.text()).toContain('已自动重映射到替换文档');
    expect(remappedPanel.text()).toContain('循环 / 心动周期');
    expect(remappedPanel.text()).toContain('old-doc-');
    expect(remappedPanel.text()).toContain('new-doc-');
    expect(remappedPanel.text()).toContain('2026-07-20');

    const unresolvedPanel = wrapper.get('.unresolved-baseline');
    expect(unresolvedPanel.text()).toContain('无法解析的节点');
    expect(unresolvedPanel.text()).toContain('旧教材 / 微循环');
  });

  it('cancels the pending subject read and clears loading when the subject is cleared', async () => {
    const pendingProgress = deferred<Response>();
    let progressSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/subjects')) return response(subjectsPayload);
      if (url.pathname.endsWith('/teaching-progress')) {
        progressSignal = init?.signal as AbortSignal | undefined;
        return pendingProgress.promise;
      }
      if (url.pathname.endsWith('/sources/libraries')) {
        return response({ items: [], total: 0 });
      }
      return response({ message: 'not found' }, 404);
    });

    const wrapper = mount(AdminTeachingProgress);
    await flushPromises();

    expect(progressSignal).toBeDefined();
    expect(
      wrapper.get('button[title="刷新教学进度"]').attributes('disabled'),
    ).toBeDefined();

    await wrapper.get('#progress-subject').setValue('');
    await flushPromises();

    expect(progressSignal?.aborted).toBe(true);
    expect(
      wrapper.get('button[title="刷新教学进度"]').attributes('disabled'),
    ).toBeUndefined();
    wrapper.unmount();
  });

  it('freezes the publish payload and locks baseline controls until the mutation finishes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const pendingPublish = deferred<unknown>();
    let publishedBody: unknown;
    mockProgressFetch({
      details: { 'progress-1': progressDetail() },
      onPublish(body) {
        publishedBody = body;
        return pendingPublish.promise;
      },
    });

    const wrapper = mount(AdminTeachingProgress);
    await flushPromises();
    await wrapper
      .get('#progress-correction')
      .setValue('旧节点已由新版教材结构替代');
    await wrapper.get('.publish-button').trigger('click');
    await flushPromises();

    expect(wrapper.get('#progress-subject').attributes('disabled')).toBeDefined();
    expect(
      wrapper.get('#progress-effective-date').attributes('disabled'),
    ).toBeDefined();
    expect(wrapper.get('#progress-version').attributes('disabled')).toBeDefined();
    expect(wrapper.get('#progress-correction').attributes('disabled')).toBeDefined();
    expect(publishedBody).toMatchObject({
      subjectId: 'subject-1',
      basedOnProgressId: 'progress-1',
      expectedVersion: 3,
      changeType: 'CORRECTION',
      correctionReason: '旧节点已由新版教材结构替代',
      effectivePracticeDate: '2026-07-29',
      nodes: [
        { knowledgeNodeId: 'node-current', firstTaughtDate: '2026-07-20' },
      ],
    });

    pendingPublish.resolve({ id: 'progress-2' });
    await flushPromises();
    expect(wrapper.get('#progress-subject').attributes('disabled')).toBeUndefined();
  });
});
