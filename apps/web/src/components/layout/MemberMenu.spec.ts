import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth';
import MemberMenu from './MemberMenu.vue';

const pushMock = vi.hoisted(() => vi.fn());
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const user = {
  id: 'admin-1',
  displayName: '测试管理员',
  role: 'ADMIN' as const,
  status: 'ACTIVE' as const,
};

function response(payload: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mountMenu() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = { ...user };
  const wrapper = mount(MemberMenu, {
    attachTo: document.body,
    global: {
      plugins: [pinia],
      stubs: { ChangePasswordDialog: true },
    },
  });
  return { wrapper, auth };
}

describe('MemberMenu', () => {
  beforeEach(() => pushMock.mockReset());

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('opens with menu semantics, focuses the first item and returns focus on Escape', async () => {
    const { wrapper } = mountMenu();
    const trigger = wrapper.get('.member-trigger');
    await trigger.trigger('click');

    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('[role="menu"]').exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.findAll('[role="menuitem"]')[0]!.element);
    await wrapper.find('[role="menu"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();

    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
  });

  it('closes on an outside click and keeps the password action', async () => {
    const { wrapper } = mountMenu();
    await wrapper.get('.member-trigger').trigger('click');
    expect(wrapper.text()).toContain('修改密码');
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
  });

  it('shows a stable busy state and suppresses duplicate logout submissions', async () => {
    let resolveRequest!: (value: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>((resolve) => (resolveRequest = resolve)),
    );
    const { wrapper } = mountMenu();
    await wrapper.get('.member-trigger').trigger('click');
    const logout = wrapper.findAll('[role="menuitem"]')[1]!;
    await logout.trigger('click');

    expect(wrapper.text()).toContain('正在退出…');
    expect(logout.attributes()).toHaveProperty('disabled');
    await logout.trigger('click');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveRequest(response(null, 204));
    await flushPromises();
    expect(pushMock).toHaveBeenCalledWith('/');
  });

  it('treats logout 401 as local success and navigates away', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ message: '请先登录' }, 401),
    );
    const { wrapper, auth } = mountMenu();
    await wrapper.get('.member-trigger').trigger('click');
    await wrapper.findAll('[role="menuitem"]')[1]!.trigger('click');
    await flushPromises();

    expect(auth.user).toBeNull();
    expect(pushMock).toHaveBeenCalledWith('/');
  });

  it.each([
    ['网络连接失败，请检查网络后重试', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['服务暂不可用', () => Promise.resolve(response({ message: '服务暂不可用' }, 500))],
  ])('keeps the signed-in appearance when logout fails: %s', async (message, implementation) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(implementation);
    const { wrapper, auth } = mountMenu();
    await wrapper.get('.member-trigger').trigger('click');
    await wrapper.findAll('[role="menuitem"]')[1]!.trigger('click');
    await flushPromises();

    expect(auth.user).toEqual(user);
    expect(wrapper.get('[role="alert"]').text()).toContain(message);
    expect(wrapper.get('.member-trigger').attributes('aria-expanded')).toBe('true');
    expect(pushMock).not.toHaveBeenCalled();
  });
});
