import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CreditHoursView from './CreditHoursView.vue';
import * as apiClient from '../lib/api';

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CreditHoursView public disclosure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('orders the tools before public statistics and opens records in a dialog', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) => {
        const url = String(input);
        if (url.includes('/credit-hours/me/summary')) {
          return json({
            qualityHours: 1,
            volunteerHours: 0,
            totalHours: 1,
            statusCounts: {},
          });
        }
        if (url.includes('/credit-hours/leaderboard')) {
          return url.includes('cursor=next-leader')
            ? json({
                type: 'TOTAL',
                items: [
                  {
                    userId: 'user-2',
                    displayName: '乙同学',
                    qualityHours: 0.5,
                    volunteerHours: 2,
                    totalHours: 2.5,
                    rank: 1,
                    currentUser: false,
                  },
                ],
                nextCursor: null,
              })
            : json({
                type: 'TOTAL',
                items: [
                  {
                    userId: 'user-1',
                    displayName: '甲同学',
                    qualityHours: 1,
                    volunteerHours: 0,
                    totalHours: 1,
                    rank: 2,
                    currentUser: true,
                  },
                ],
                nextCursor: 'next-leader',
              });
        }
        if (url.includes('/credit-hours/submissions')) {
          return json({ items: [], nextCursor: null });
        }
        if (url.includes('/credit-hours/users/user-2/submissions')) {
          return json({
            user: { id: 'user-2', displayName: '乙同学' },
            items: [
              {
                id: 'record-1',
                type: 'QUALITY',
                activityName: '素质公开活动',
                hours: 0.5,
                decidedAt: '2026-09-01T00:00:00.000Z',
              },
              {
                id: 'record-2',
                type: 'VOLUNTEER',
                activityName: '志愿公开活动',
                hours: 2,
                decidedAt: '2026-09-01T01:00:00.000Z',
              },
            ],
            nextCursor: null,
          });
        }
        if (url.includes('/credit-hours/users/user-1/submissions')) {
          return json({
            user: { id: 'user-1', displayName: '甲同学' },
            items: [
              {
                id: 'record-3',
                type: 'QUALITY',
                activityName: '仅素质活动',
                hours: 1,
                decidedAt: '2026-09-01T02:00:00.000Z',
              },
            ],
            nextCursor: null,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    const wrapper = mount(CreditHoursView, {
      attachTo: document.body,
      global: { stubs: { RouterLink: RouterLinkStub } },
    });
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain('甲同学');
    expect(wrapper.text()).toContain('乙同学');
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes('cursor=next-leader'),
    )).toBe(true);
    const hoursInput = wrapper.find<HTMLInputElement>('input[type="number"]');
    expect(hoursInput.attributes('step')).toBe('0.5');
    expect(hoursInput.attributes('min')).toBe('0.5');
    expect(hoursInput.attributes('max')).toBe('1000');
    expect(wrapper.find('.type-switch').exists()).toBe(false);
    expect(wrapper.get('#summary-heading').text()).toBe('我的总学时');
    expect(wrapper.get('#submit-heading').text()).toBe('提交学时记录');
    expect(
      wrapper
        .findAll('.submission-type-switch [role="radio"]')
        .map((option) => option.text()),
    ).toEqual(['素质学时', '志愿学时']);
    expect(
      wrapper.findAll('.public-section thead th').map((header) => header.text()),
    ).toEqual(['排名', '成员', '素质学时', '志愿学时', '总学时', '记录']);
    expect(rowText(wrapper, '甲同学')).toContain('1.0h0.0h1.0h');
    expect(rowText(wrapper, '乙同学')).toContain('0.5h2.0h2.5h');
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes(
          '/credit-hours/leaderboard?type=TOTAL&pageSize=100',
        ),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          String(input).includes('/credit-hours/submissions?pageSize=100') &&
          !String(input).includes('type='),
      ),
    ).toBe(true);
    expect(
      wrapper
        .findAll('.summary-band, .work-grid, .public-section')
        .map((element) => element.classes()[0]),
    ).toEqual(['summary-band', 'work-grid', 'public-section']);

    const otherRow = wrapper
      .findAll('tbody tr')
      .find((row) => row.text().includes('乙同学'))!;
    await otherRow.get('button').trigger('click');
    await flushPromises();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(wrapper.get('.public-section').element.contains(dialog)).toBe(false);
    expect(dialog?.textContent).toContain('乙同学 · 总学时公示记录');
    const qualitySection = dialog?.querySelector<HTMLElement>(
      '[aria-labelledby="public-quality-heading"]',
    );
    const volunteerSection = dialog?.querySelector<HTMLElement>(
      '[aria-labelledby="public-volunteer-heading"]',
    );
    expect(qualitySection?.textContent).toContain('素质学时');
    expect(
      qualitySection?.querySelector('.public-record-heading > strong')?.textContent,
    ).toBe('0.5h');
    expect(qualitySection?.textContent).toContain('素质公开活动');
    expect(qualitySection?.textContent).not.toContain('志愿公开活动');
    expect(volunteerSection?.textContent).toContain('志愿学时');
    expect(
      volunteerSection?.querySelector('.public-record-heading > strong')
        ?.textContent,
    ).toBe('2.0h');
    expect(volunteerSection?.textContent).toContain('志愿公开活动');
    expect(volunteerSection?.textContent).not.toContain('素质公开活动');
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          String(input).includes(
            '/credit-hours/users/user-2/submissions?pageSize=100',
          ) && !String(input).includes('type='),
      ),
    ).toBe(true);

    dialog
      ?.querySelector<HTMLButtonElement>('button[aria-label="关闭对话框"]')
      ?.click();
    await flushPromises();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    const selfRow = wrapper
      .findAll('tbody tr')
      .find((row) => row.text().includes('甲同学'))!;
    await selfRow.get('button').trigger('click');
    await flushPromises();
    const selfDialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const selfQualitySection = selfDialog?.querySelector<HTMLElement>(
      '[aria-labelledby="public-quality-heading"]',
    );
    const selfVolunteerSection = selfDialog?.querySelector<HTMLElement>(
      '[aria-labelledby="public-volunteer-heading"]',
    );
    expect(selfQualitySection?.textContent).toContain('仅素质活动');
    expect(selfQualitySection?.textContent).not.toContain('暂无素质学时记录');
    expect(selfVolunteerSection?.textContent).toContain('暂无志愿学时记录');
    expect(selfVolunteerSection?.textContent).not.toContain('仅素质活动');

    wrapper.unmount();
  });
});

function rowText(wrapper: ReturnType<typeof mount>, displayName: string) {
  return wrapper
    .findAll('tbody tr')
    .find((row) => row.text().includes(displayName))!
    .text()
    .replace(/\s/g, '');
}

function memberRow(userId: string, displayName: string) { return { userId, displayName, qualityHours: 1, volunteerHours: 0, totalHours: 1, rank: 1, currentUser: false }; }
const mountView = () => mount(CreditHoursView, { attachTo: document.body, global: { stubs: { RouterLink: RouterLinkStub } } });

describe('CreditHoursView safety', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

  it('does not replace B public records with a late response for A after closing and reopening', async () => {
    let resolveA!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/me/summary')) return json({ totalHours: 1 });
      if (url.includes('/leaderboard')) return json({ items: [memberRow('a', '甲'), memberRow('b', '乙')], nextCursor: null });
      if (url.includes('/users/a/')) return new Promise((resolve) => { resolveA = resolve; });
      if (url.includes('/users/b/')) return json({ items: [{ id: 'b-record', type: 'QUALITY', activityName: '乙的活动', hours: 1, decidedAt: null }], nextCursor: null });
      return json({ items: [], nextCursor: null });
    });
    const wrapper = mountView(); await flushPromises();
    await wrapper.findAll('tbody tr')[0]!.get('button').trigger('click'); await flushPromises();
    document.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click(); await flushPromises();
    await wrapper.findAll('tbody tr')[1]!.get('button').trigger('click'); await flushPromises();
    resolveA(json({ items: [{ id: 'a-record', type: 'QUALITY', activityName: '甲的旧活动', hours: 1, decidedAt: null }], nextCursor: null })); await flushPromises();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('乙的活动');
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('甲的旧活动');
    wrapper.unmount();
  });

  it('shows a retryable public error instead of an endless loading spinner', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/me/summary')) return json({ totalHours: 1 });
      if (url.includes('/leaderboard')) return json({ items: [memberRow('a', '甲')], nextCursor: null });
      if (url.includes('/users/')) throw new TypeError('Failed to fetch');
      return json({ items: [], nextCursor: null });
    });
    const wrapper = mountView(); await flushPromises();
    await wrapper.get('tbody button').trigger('click'); await flushPromises();
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('重试');
    expect(document.querySelector('[role="dialog"] .loading-row')).toBeNull();
    wrapper.unmount();
  });

  it('shows neutral manual review guidance and allows pending manual records to be withdrawn', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/me/summary')) return json({ totalHours: 0 });
      if (url.includes('/leaderboard')) return json({ items: [], nextCursor: null });
      if (url.endsWith('/withdraw')) return json({});
      return json({ items: [{ id: 'manual', user: { id: 'a', displayName: '甲' }, activityName: '待复核活动', status: 'PENDING_MANUAL_REVIEW', type: 'QUALITY', hours: 1, revision: 3, createdAt: '2026-09-05T00:00:00Z', sourceDescription: '活动凭证', evidence: [], manualReview: { reason: '需进一步核验', riskCodes: ['SUSPECTED_IMAGE_MANIPULATION'], transferredAt: null } }], nextCursor: null });
    });
    const wrapper = mountView(); await flushPromises();
    expect(wrapper.text()).toContain('待人工审核');
    await wrapper.get('.record-detail-button').trigger('click');
    expect(wrapper.text()).toContain('当前未认定凭证不实');
    await wrapper.get('.danger-text').trigger('click'); await flushPromises();
    expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/manual/withdraw') && init?.body === '{"expectedRevision":3}')).toBe(true);
    wrapper.unmount();
  });

  it('locks all draft controls during upload and retains the same form for an unknown-result retry', async () => {
    const OriginalURL = URL;
    vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL() { return 'blob:test'; } static revokeObjectURL() {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('/me/summary') ? json({ totalHours: 0 }) : json({ items: [], nextCursor: null }));
    let rejectUpload!: (reason: unknown) => void;
    const upload = vi.spyOn(apiClient, 'uploadForm').mockImplementationOnce(() => new Promise((_, reject) => { rejectUpload = reject; })).mockResolvedValueOnce({});
    const wrapper = mountView(); await flushPromises();
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [new File(['fake'], 'proof.png', { type: 'image/png' })] });
    await fileInput.trigger('change');
    await wrapper.get('input[maxlength="160"]').setValue('保留活动'); await wrapper.get('textarea').setValue('保留说明');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.get<HTMLInputElement>('input[maxlength="160"]').element.disabled).toBe(true);
    expect(fileInput.element.disabled).toBe(true);
    expect(wrapper.get<HTMLButtonElement>('[aria-label="移除这张凭证"]').element.disabled).toBe(true);
    rejectUpload(new TypeError('Failed to fetch')); await flushPromises();
    expect(wrapper.text()).toContain('提交结果尚未确认');
    expect(wrapper.get<HTMLInputElement>('input[maxlength="160"]').element.value).toBe('保留活动');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(upload.mock.calls[1]![1]).toBe(upload.mock.calls[0]![1]);
    expect(upload.mock.calls[1]![2]?.headers).toEqual(upload.mock.calls[0]![2]?.headers);
    expect(wrapper.get<HTMLInputElement>('input[maxlength="160"]').element.value).toBe('');
    wrapper.unmount();
  });
});
