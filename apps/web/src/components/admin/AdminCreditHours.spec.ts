import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth';
import AdminCreditHours from './AdminCreditHours.vue';

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AdminCreditHours overview', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useAuthStore().user = {
      id: 'admin-1',
      displayName: '管理员',
      role: 'ADMIN',
      status: 'ACTIVE',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows total hours in ascending order and offers the streaming export', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/admin/credit-hours/submissions')) {
        return json({ items: [], nextCursor: null });
      }
      if (url.includes('/admin/credit-hours/overview')) {
        return json({
          type: 'TOTAL',
          items: [
            {
              userId: 'user-1',
              displayName: '甲同学',
              qualityHours: 1,
              volunteerHours: 0.5,
              totalHours: 1.5,
              rank: 1,
              currentUser: false,
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const wrapper = mount(AdminCreditHours);
    await flushPromises();
    const overviewTab = wrapper
      .findAll('.subtabs [role="tab"]')
      .find((tab) => tab.text() === '学时总览')!;
    await overviewTab.trigger('click');
    await flushPromises();

    expect(wrapper.find('.filters').exists()).toBe(false);
    expect(wrapper.get('.overview-heading').text()).toContain('总学时低到高');
    expect(
      wrapper.findAll('.admin-table-wrap thead th').map((header) => header.text()),
    ).toEqual(['成员', '总学时']);
    expect(wrapper.get('.admin-table-wrap tbody').text()).toContain('1.5h');
    const exportLink = wrapper.get<HTMLAnchorElement>('.export-button');
    expect(exportLink.attributes('href')).toBe(
      '/api/v1/admin/credit-hours/exports/approved.zip',
    );
    expect(exportLink.attributes()).toHaveProperty('download');
  });

  it('creates an approved evidence-free record for another active user', async () => {
    const created = {
      id: 'record-1',
      user: { id: 'user-2', displayName: '乙同学' },
      type: 'VOLUNTEER',
      status: 'APPROVED',
      revision: 1,
      activityName: '校内志愿活动',
      hours: 1.5,
      sourceDescription: '管理员核验后录入',
      decisionSource: 'ADMIN_CREATED',
      decisionReason: '管理员直接录入，无需 AI 审核',
      evidence: [],
      reviewJob: null,
      decidedAt: '2026-09-03T00:00:00.000Z',
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    };
    let posted = false;
    let postInit: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/users')) {
        return json({
          items: [
            {
              id: 'admin-1',
              displayName: '管理员',
              role: 'ADMIN',
              status: 'ACTIVE',
              createdAt: '2026-01-01T00:00:00.000Z',
              approvedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'user-2',
              displayName: '乙同学',
              role: 'MEMBER',
              status: 'ACTIVE',
              createdAt: '2026-01-01T00:00:00.000Z',
              approvedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'user-3',
              displayName: '待审核成员',
              role: 'MEMBER',
              status: 'PENDING',
              createdAt: '2026-01-01T00:00:00.000Z',
              approvedAt: null,
            },
          ],
          total: 3,
        });
      }
      if (
        url.includes('/admin/credit-hours/submissions') &&
        init?.method === 'POST'
      ) {
        posted = true;
        postInit = init;
        return json(created);
      }
      if (url.includes('/admin/credit-hours/submissions')) {
        return json({ items: posted ? [created] : [], nextCursor: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const wrapper = mount(AdminCreditHours, { attachTo: document.body });
    await flushPromises();
    await wrapper.get('.create-button').trigger('click');
    await flushPromises();

    const dialog = document.querySelector<HTMLElement>('.dialog-panel')!;
    const options = Array.from(
      dialog.querySelectorAll<HTMLOptionElement>('#credit-member option'),
    ).map((option) => option.textContent?.trim());
    expect(options).toContain('乙同学 · 成员');
    expect(options.join(' ')).not.toContain('管理员 · 管理员');
    expect(options.join(' ')).not.toContain('待审核成员');

    const volunteer = dialog.querySelector<HTMLInputElement>(
      'input[value="VOLUNTEER"]',
    )!;
    volunteer.checked = true;
    volunteer.dispatchEvent(new Event('change', { bubbles: true }));
    const hours = dialog.querySelector<HTMLInputElement>('#credit-hours')!;
    expect(hours.min).toBe('0.5');
    expect(hours.max).toBe('1000');
    expect(hours.step).toBe('0.5');
    hours.value = '1000';
    hours.dispatchEvent(new Event('input', { bubbles: true }));
    const activity = dialog.querySelector<HTMLInputElement>('#credit-activity')!;
    activity.value = '校内志愿活动';
    activity.dispatchEvent(new Event('input', { bubbles: true }));
    const description = dialog.querySelector<HTMLTextAreaElement>(
      '#credit-description',
    )!;
    description.value = '管理员核验后录入';
    description.dispatchEvent(new Event('input', { bubbles: true }));
    dialog
      .querySelector<HTMLFormElement>('#admin-credit-hour-create')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(new Headers(postInit?.headers).get('Idempotency-Key')).toEqual(
      expect.any(String),
    );
    expect(JSON.parse(String(postInit?.body))).toEqual({
      userId: 'user-2',
      type: 'VOLUNTEER',
      activityName: '校内志愿活动',
      hours: 1000,
      description: '管理员核验后录入',
    });
    expect(wrapper.text()).toContain('管理员录入 · 无 AI 任务');
    expect(wrapper.find('[aria-label="重新打开"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

function manualRecord(id = 'manual-1') {
  return { id, user: { id: 'member', displayName: id }, type: 'QUALITY', status: 'PENDING_MANUAL_REVIEW', revision: 1, activityName: id, hours: 1, sourceDescription: '凭证待核验', decisionReason: null, evidence: [], reviewJob: { status: 'SUCCEEDED', attempts: 1 }, manualReview: { transferredAt: '2026-09-05T00:00:00Z', reason: '印章无法确认', riskCodes: ['OFFICIAL_SEAL_UNCLEAR'] }, createdAt: '2026-09-05T00:00:00Z', reviewJobs: [], decisionEvents: [] };
}

describe('AdminCreditHours request and manual review safety', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useAuthStore().user = { id: 'admin-1', displayName: '管理员', role: 'ADMIN', status: 'ACTIVE' };
  });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

  it('defaults to manual review and isolates hidden record filters from each queue mode', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ items: [manualRecord()], nextCursor: null }));
    const wrapper = mount(AdminCreditHours);
    await flushPromises();
    expect(String(fetch.mock.calls[0]![0])).toContain('status=PENDING_MANUAL_REVIEW');
    expect(wrapper.text()).toContain('待人工审核');
    expect(wrapper.find('[aria-label="重新打开"]').exists()).toBe(false);
    await wrapper.findAll('.subtabs button').find((button) => button.text() === '全部记录')!.trigger('click');
    await flushPromises();
    await wrapper.get('[aria-label="记录状态"]').setValue('APPROVED');
    await wrapper.get('.keyword input').setValue('旧关键词');
    await wrapper.findAll('.filters button')[0]!.trigger('click'); await flushPromises();
    expect(String(fetch.mock.calls.at(-1)![0])).toContain('status=APPROVED');
    await wrapper.findAll('.subtabs button').find((button) => button.text() === '审核队列')!.trigger('click'); await flushPromises();
    expect(String(fetch.mock.calls.at(-1)![0])).toContain('status=PENDING_MANUAL_REVIEW');
    expect(String(fetch.mock.calls.at(-1)![0])).not.toContain('keyword');
    await wrapper.get('[aria-label="审核阶段"]').setValue('error'); await flushPromises();
    expect(String(fetch.mock.calls.at(-1)![0])).toContain('status=PENDING_REVIEW');
    expect(String(fetch.mock.calls.at(-1)![0])).not.toContain('keyword');
    wrapper.unmount();
  });

  it('rejects stale list results and shows a retry error for direct filter failures', async () => {
    let resolveFirst!: (response: Response) => void;
    let count = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (++count === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      if (count === 2) return json({ items: [manualRecord('current')], nextCursor: null });
      throw new TypeError('Failed to fetch');
    });
    const wrapper = mount(AdminCreditHours); await flushPromises();
    await wrapper.findAll('.subtabs button').find((button) => button.text() === '全部记录')!.trigger('click'); await flushPromises();
    resolveFirst(json({ items: [manualRecord('stale')], nextCursor: null })); await flushPromises();
    expect(wrapper.text()).toContain('current'); expect(wrapper.text()).not.toContain('stale');
    await wrapper.findAll('.filters button')[0]!.trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('网络连接失败');
    expect(wrapper.get('[role="alert"]').text()).toContain('重试');
    wrapper.unmount();
  });

  it('preserves the decision reason on a revision conflict and refreshes before resubmission', async () => {
    const body = manualRecord();
    let decisions = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'POST') {
        if (++decisions === 1) return new Response(JSON.stringify({ message: 'conflict' }), { status: 409, headers: { 'content-type': 'application/json' } });
        return json(body);
      }
      if (String(url).endsWith('/manual-1')) return json({ ...body, revision: 2 });
      return json({ items: [body], nextCursor: null });
    });
    const wrapper = mount(AdminCreditHours, { attachTo: document.body }); await flushPromises();
    await wrapper.get('[aria-label="通过"]').trigger('click'); await flushPromises();
    const reason = document.querySelector<HTMLTextAreaElement>('#credit-action-reason')!;
    reason.value = '人工核对原图已通过'; reason.dispatchEvent(new Event('input', { bubbles: true }));
    const submit = () => document.querySelector('#credit-hour-decision')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    submit(); await flushPromises();
    expect(reason.value).toBe('人工核对原图已通过');
    expect(document.body.textContent).toContain('操作理由已保留');
    expect(document.querySelector<HTMLButtonElement>('button[form="credit-hour-decision"]')?.disabled).toBe(true);
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '刷新记录')!.click(); await flushPromises();
    submit(); await flushPromises();
    const requests = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(requests.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { expectedRevision: 1, reason: '人工核对原图已通过', decision: 'APPROVED' },
      { expectedRevision: 2, reason: '人工核对原图已通过', decision: 'APPROVED' },
    ]);
    wrapper.unmount();
  });
});
