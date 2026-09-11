import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogItem } from '../../types';
import AdminAuditLogs from './AdminAuditLogs.vue';

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock('../../composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: toastInfo }),
}));

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

function log(id: string, overrides: Partial<AuditLogItem> = {}): AuditLogItem {
  return {
    id,
    actorId: 'admin-1',
    action: 'user.update',
    targetType: 'User',
    targetId: 'member-1',
    metadata: { role: 'EDITOR', password: 'never-show', sessionToken: 'never-show' },
    createdAt: '2026-07-20T00:00:00.000Z',
    actor: { id: 'admin-1', displayName: '测试管理员' },
    ...overrides,
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function restoreUrlMethod(
  method: 'createObjectURL' | 'revokeObjectURL',
  original: typeof URL.createObjectURL | typeof URL.revokeObjectURL | undefined,
) {
  if (original) Object.defineProperty(URL, method, { configurable: true, value: original });
  else Reflect.deleteProperty(URL, method);
}

describe('AdminAuditLogs', () => {
  beforeEach(() => {
    toastSuccess.mockReset();
    toastError.mockReset();
    toastInfo.mockReset();
  });

  afterEach(() => {
    restoreUrlMethod('createObjectURL', originalCreateObjectUrl);
    restoreUrlMethod('revokeObjectURL', originalRevokeObjectUrl);
    vi.restoreAllMocks();
  });

  it('renders readable entries without exposing sensitive metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/v1/users') return json({ items: [], total: 0 });
      return json({ items: [log('audit-1')], nextCursor: null });
    });
    const wrapper = mount(AdminAuditLogs);
    await flushPromises();

    expect(wrapper.text()).toContain('测试管理员');
    expect(wrapper.text()).toContain('更新成员');
    expect(wrapper.text()).toContain('role: EDITOR');
    expect(wrapper.text()).not.toContain('never-show');
  });

  it('keeps draft filters separate and exports the currently applied filters', async () => {
    const createObjectUrl = vi.fn(() => 'blob:audit-export');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/v1/users') {
        return json({
          items: [{ id: 'admin-1', displayName: '测试管理员', role: 'ADMIN', status: 'ACTIVE' }],
          total: 1,
        });
      }
      if (url.includes('/admin/audit-logs.csv')) {
        return new Response('id,action\naudit-1,user.update\n', {
          headers: {
            'content-type': 'text/csv',
            'x-result-truncated': 'true',
            'x-result-limit': '5000',
          },
        });
      }
      return json({ items: [log('audit-1')], nextCursor: null });
    });
    const wrapper = mount(AdminAuditLogs);
    await flushPromises();

    await wrapper.get('#audit-actor').setValue('admin-1');
    await wrapper.get('#audit-action').setValue('user.update');
    await wrapper.get('#audit-target-type').setValue('User');
    await wrapper.get('.audit-filters').trigger('submit');
    await flushPromises();
    await wrapper.get('#audit-action').setValue('invite.revoke');
    await wrapper.findAll('button').find((button) => button.text().includes('导出 CSV'))!.trigger('click');
    await flushPromises();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const exportCall = fetchMock.mock.calls.find(([input]) => String(input).includes('.csv'));
    const exportUrl = new URL(String(exportCall?.[0]), 'http://localhost');
    expect(exportUrl.searchParams.get('actorId')).toBe('admin-1');
    expect(exportUrl.searchParams.get('action')).toBe('user.update');
    expect(exportUrl.searchParams.get('targetType')).toBe('User');
    expect(exportUrl.searchParams.get('limit')).toBe('5000');
    expect(createObjectUrl).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:audit-export');
    expect(toastInfo).toHaveBeenCalledWith('CSV 已导出前 5000 条，符合条件的结果已达到上限');
  });

  it('appends cursor pages with stable deduplication', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/users')) return json({ items: [], total: 0 });
      if (url.searchParams.get('cursor') === 'cursor-1') {
        return json({
          items: [log('audit-1'), log('audit-2', { action: 'invite.revoke' })],
          nextCursor: null,
        });
      }
      return json({ items: [log('audit-1')], nextCursor: 'cursor-1' });
    });
    const wrapper = mount(AdminAuditLogs);
    await flushPromises();

    await wrapper.get('.load-more').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
    expect(wrapper.text()).toContain('撤销邀请码');
  });
});
