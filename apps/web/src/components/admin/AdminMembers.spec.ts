import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth';
import type { Member } from '../../types';
import AdminMembers from './AdminMembers.vue';

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));

const currentAdmin: Member = {
  id: 'admin-1',
  displayName: '测试管理员',
  role: 'ADMIN',
  status: 'ACTIVE',
  createdAt: '2026-07-20T00:00:00.000Z',
  approvedAt: '2026-07-20T00:00:00.000Z',
};
const member: Member = {
  id: 'member-1',
  displayName: '李同学',
  role: 'MEMBER',
  status: 'ACTIVE',
  createdAt: '2026-07-20T01:00:00.000Z',
  approvedAt: '2026-07-20T01:00:00.000Z',
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setAdmin() {
  const auth = useAuthStore();
  auth.user = currentAdmin;
}

describe('AdminMembers', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setAdmin();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('saves an ADMIN-selected role through the user update endpoint', async () => {
    const updated = { ...member, role: 'ADMIN' as const };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response({ items: [currentAdmin, member], total: 2 }),
      )
      .mockResolvedValueOnce(response(updated))
      .mockResolvedValueOnce(
        response({ items: [currentAdmin, updated], total: 2 }),
      );
    const wrapper = mount(AdminMembers);
    await flushPromises();

    const row = wrapper
      .findAll('tbody tr')
      .find((item) => item.text().includes('李同学'))!;
    await row.find('select').setValue('ADMIN');
    await row
      .findAll('button')
      .find((button) => button.text() === '保存')!
      .trigger('click');
    await flushPromises();

    const patchCall = fetchMock.mock.calls.find(
      ([, options]) => options?.method === 'PATCH',
    );
    expect(patchCall?.[0]).toBe('/api/v1/users/member-1');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ role: 'ADMIN' });
  });

  it('disables dangerous operations for the current and only active administrator', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ items: [currentAdmin], total: 1 }),
    );
    const wrapper = mount(AdminMembers);
    await flushPromises();

    const row = wrapper.find('tbody tr');
    expect(row.find('select').attributes()).toHaveProperty('disabled');
    const suspend = row
      .findAll('button')
      .find((button) => button.text() === '停用')!;
    expect(suspend.attributes()).toHaveProperty('disabled');
    expect(
      row.findAll('button').some((button) => button.text() === '重置密码'),
    ).toBe(false);
    expect(row.text()).toContain('唯一正常管理员不可降级');
    expect(row.text()).toContain('当前账号不可停用或重置密码');
  });

  it('rolls the selected role back when the server rejects the change', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response({ items: [currentAdmin, member], total: 2 }),
      )
      .mockResolvedValueOnce(
        response({ message: '系统必须至少保留一个正常状态的管理员' }, 409),
      );
    const wrapper = mount(AdminMembers);
    await flushPromises();

    const row = wrapper
      .findAll('tbody tr')
      .find((item) => item.text().includes('李同学'))!;
    const select = row.find('select');
    await select.setValue('ADMIN');
    await row
      .findAll('button')
      .find((button) => button.text() === '保存')!
      .trigger('click');
    await flushPromises();

    expect((select.element as HTMLSelectElement).value).toBe('MEMBER');
  });

  it('keeps an unsaved role draft across reloads while syncing untouched rows', async () => {
    const pending: Member = {
      ...member,
      id: 'member-2',
      displayName: '王同学',
      status: 'PENDING',
    };
    const untouched: Member = { ...member, id: 'member-3', displayName: '赵同学' };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response({ items: [currentAdmin, member, pending, untouched], total: 4 }),
      )
      .mockResolvedValueOnce(response({ ...pending, status: 'ACTIVE' }))
      .mockResolvedValueOnce(
        response({
          items: [
            currentAdmin,
            member,
            { ...pending, status: 'ACTIVE' },
            { ...untouched, role: 'EDITOR' },
          ],
          total: 4,
        }),
      );
    const wrapper = mount(AdminMembers);
    await flushPromises();

    const rowOf = (name: string) =>
      wrapper.findAll('tbody tr').find((item) => item.text().includes(name))!;
    const draftSelect = rowOf('李同学').find('select');
    await draftSelect.setValue('ADMIN');

    await rowOf('王同学')
      .findAll('button')
      .find((button) => button.text() === '通过')!
      .trigger('click');
    await flushPromises();

    // 未保存的草稿不被刷新覆盖；未改动的行跟随服务端最新角色
    expect(
      (rowOf('李同学').find('select').element as HTMLSelectElement).value,
    ).toBe('ADMIN');
    expect(
      (rowOf('赵同学').find('select').element as HTMLSelectElement).value,
    ).toBe('EDITOR');
  });

  it('syncs the role draft again after a successful save', async () => {
    const pending: Member = {
      ...member,
      id: 'member-2',
      displayName: '王同学',
      status: 'PENDING',
    };
    const saved = { ...member, role: 'EDITOR' as const };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response({ items: [currentAdmin, member, pending], total: 3 }),
      )
      .mockResolvedValueOnce(response(saved))
      .mockResolvedValueOnce(
        response({ items: [currentAdmin, saved, pending], total: 3 }),
      )
      .mockResolvedValueOnce(response({ ...pending, status: 'ACTIVE' }))
      .mockResolvedValueOnce(
        response({
          items: [currentAdmin, member, { ...pending, status: 'ACTIVE' }],
          total: 3,
        }),
      );
    const wrapper = mount(AdminMembers);
    await flushPromises();

    const rowOf = (name: string) =>
      wrapper.findAll('tbody tr').find((item) => item.text().includes(name))!;
    await rowOf('李同学').find('select').setValue('EDITOR');
    await rowOf('李同学')
      .findAll('button')
      .find((button) => button.text() === '保存')!
      .trigger('click');
    await flushPromises();
    expect(
      (rowOf('李同学').find('select').element as HTMLSelectElement).value,
    ).toBe('EDITOR');

    // 保存成功后 dirty 标记已清除，后续刷新重新跟随服务端角色
    await rowOf('王同学')
      .findAll('button')
      .find((button) => button.text() === '通过')!
      .trigger('click');
    await flushPromises();
    expect(
      (rowOf('李同学').find('select').element as HTMLSelectElement).value,
    ).toBe('MEMBER');
  });
});
