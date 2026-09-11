import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteItem } from '../../types';
import AdminInvites from './AdminInvites.vue';

const confirmMock = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));
vi.mock('../../composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: toastInfo }),
}));

const SecretDialogStub = defineComponent({
  props: ['open', 'title', 'value', 'description'],
  emits: ['close'],
  template: `
    <div v-if="open" class="secret-dialog-stub">
      <strong>{{ title }}</strong><code>{{ value }}</code><span>{{ description }}</span>
      <button type="button" @click="$emit('close')">关闭一次性明文</button>
    </div>
  `,
});

function invite(overrides: Partial<InviteItem> = {}): InviteItem {
  return {
    id: 'invite-1',
    label: '班级成员',
    active: true,
    state: 'ACTIVE',
    maxUses: 5,
    usedCount: 1,
    expiresAt: '2026-08-20T00:00:00.000Z',
    revokedAt: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function mountInvites() {
  const wrapper = mount(AdminInvites, {
    global: { stubs: { SecretDialog: SecretDialogStub } },
  });
  await flushPromises();
  return wrapper;
}

describe('AdminInvites', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    toastSuccess.mockReset();
    toastError.mockReset();
    toastInfo.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it('lists invite metadata without ever rendering invite plaintext', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      items: [
        invite(),
        invite({
          id: 'invite-2',
          label: '已撤销邀请',
          active: false,
          state: 'REVOKED',
          revokedAt: '2026-08-12T00:00:00.000Z',
        }),
      ],
      total: 2,
    }));
    const wrapper = await mountInvites();

    expect(wrapper.text()).toContain('班级成员');
    expect(wrapper.text()).toContain('已撤销邀请');
    expect(wrapper.text()).not.toContain('SECRET-CODE');

    await wrapper.get('#invite-state').setValue('REVOKED');
    expect(wrapper.text()).not.toContain('班级成员');
    expect(wrapper.text()).toContain('已撤销邀请');
  });

  it('shows a newly created code once and clears it without adding plaintext to the list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/v1/invites' && init?.method === 'POST') {
        return response({
          id: 'invite-new',
          code: 'SECRET-CODE',
          label: '新成员',
          maxUses: 3,
          usedCount: 0,
          expiresAt: '2026-08-20T00:00:00.000Z',
        }, 201);
      }
      return response({
        items: [invite({ id: 'invite-new', label: '新成员', maxUses: 3, usedCount: 0 })],
        total: 1,
      });
    });
    const wrapper = await mountInvites();

    await wrapper.get('#invite-label').setValue('新成员');
    await wrapper.get('#invite-max-uses').setValue(3);
    await wrapper.get('.invite-form').trigger('submit');
    await flushPromises();

    expect(wrapper.get('.secret-dialog-stub').text()).toContain('SECRET-CODE');
    const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      label: '新成员',
      maxUses: 3,
    });

    await wrapper.get('.secret-dialog-stub button').trigger('click');
    expect(wrapper.find('.secret-dialog-stub').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('SECRET-CODE');
    expect(toastInfo).toHaveBeenCalledWith('邀请码已从界面清除');
  });

  it('revokes an active invite after confirmation and removes the action immediately', async () => {
    const activeInvite = invite();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (init?.method === 'POST') {
        return response(invite({
          active: false,
          state: 'REVOKED',
          revokedAt: '2026-08-12T00:00:00.000Z',
        }));
      }
      return response({ items: [activeInvite], total: 1 });
    });
    const wrapper = await mountInvites();

    await wrapper.findAll('button').find((button) => button.text().includes('撤销'))!.trigger('click');
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/invites/invite-1/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(wrapper.text()).toContain('已撤销');
    expect(wrapper.findAll('button').some((button) => button.text() === '撤销')).toBe(false);
    expect(toastSuccess).toHaveBeenCalledWith('邀请码已撤销');
  });
});
