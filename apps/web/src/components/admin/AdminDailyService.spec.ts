import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminDailyService from './AdminDailyService.vue';

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

const settings = {
  enabled: true,
  revision: 3,
  updatedAt: '2026-07-28T00:00:00.000Z',
  updatedBy: null,
  effective: {
    enabled: true,
    paused: false,
    reason: null,
    resumesAt: null,
    settingsRevision: 3,
  },
};

describe('AdminDailyService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('provides an audited immediate-pause entry using optimistic revision', async () => {
    confirmMock.mockResolvedValue(true);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      if (url.endsWith('/admin/daily-practice/settings') && options?.method === 'PATCH') {
        return response({
          ...settings,
          enabled: false,
          revision: 4,
          effective: { ...settings.effective, enabled: false, paused: true, settingsRevision: 4 },
        });
      }
      if (url.endsWith('/admin/daily-practice/settings')) return response(settings);
      if (url.includes('/admin/daily-practice/service-pauses')) {
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      }
      return response({}, 404);
    });
    const wrapper = mount(AdminDailyService);
    await flushPromises();
    await wrapper.find('#daily-service-reason').setValue('暑假暂停');
    await wrapper.findAll('button').find((button) => button.text().includes('立即暂停'))!.trigger('click');
    await flushPromises();

    const patchCall = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH');
    expect(patchCall?.[0]).toBe('/api/v1/admin/daily-practice/settings');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      enabled: false,
      expectedRevision: 3,
      reason: '暑假暂停',
    });
  });

  it('creates a scheduled Asia/Shanghai service pause with an audited reason', async () => {
    confirmMock.mockResolvedValue(true);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      if (url.endsWith('/admin/daily-practice/settings')) return response(settings);
      if (url.endsWith('/admin/daily-practice/service-pauses') && options?.method === 'POST') {
        const payload = JSON.parse(String(options.body));
        return response({
          id: 'pause-1', ...payload, cancelledAt: null,
          createdAt: '2026-07-28T00:00:00.000Z', createdBy: null, cancelledBy: null,
        });
      }
      if (url.includes('/admin/daily-practice/service-pauses')) {
        return response({ items: [], total: 0, page: 1, pageSize: 20 });
      }
      return response({}, 404);
    });
    const wrapper = mount(AdminDailyService);
    await flushPromises();
    await wrapper.get('#pause-start').setValue('2026-08-01T10:00');
    await wrapper.get('#pause-end').setValue('2026-08-01T12:00');
    await wrapper.get('#pause-reason').setValue('暑假维护');
    await wrapper.get('.pause-form').trigger('submit');
    await flushPromises();

    const createCall = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      startsAt: '2026-08-01T02:00:00.000Z',
      endsAt: '2026-08-01T04:00:00.000Z',
      reason: '暑假维护',
    });
  });
});
