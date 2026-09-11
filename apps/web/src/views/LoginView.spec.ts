import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LoginView from './LoginView.vue';

const pushMock = vi.hoisted(() => vi.fn());
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
  useRoute: () => ({ query: {} }),
}));

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(LoginView, { global: { plugins: [pinia] } });
}

async function fillRegisterForm(wrapper: ReturnType<typeof mountView>) {
  await wrapper.findAll('[role="tab"]')[1]!.trigger('click');
  await wrapper.get('#invite').setValue('INVITE-CODE');
  await wrapper.get('#name').setValue('测试成员');
  await wrapper.get('#student-number').setValue('2510305301');
  await wrapper.get('#password').setValue('password123');
}

describe('LoginView', () => {
  beforeEach(() => pushMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('keeps the success message after registration switches back to login mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response({ message: '申请已提交，等待管理员审核' }),
    );
    const wrapper = mountView();
    await fillRegisterForm(wrapper);

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.find('#invite').exists()).toBe(false);
    const success = wrapper.get('p.alert.success');
    expect(success.text()).toContain('申请已提交，等待管理员审核');
    wrapper.unmount();
  });

  it('clears messages only when the user switches tabs manually', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response({ message: '申请已提交，等待管理员审核' }),
    );
    const wrapper = mountView();
    await fillRegisterForm(wrapper);
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('p.alert.success').exists()).toBe(true);

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click');
    expect(wrapper.find('p.alert.success').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the server error and stays in register mode on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response({ message: '邀请码无效' }, 400),
    );
    const wrapper = mountView();
    await fillRegisterForm(wrapper);

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.find('#invite').exists()).toBe(true);
    expect(wrapper.get('p.alert.error').text()).toContain('邀请码无效');
    wrapper.unmount();
  });
});
