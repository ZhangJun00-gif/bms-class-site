import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth';
import AdminCreditHourCreateDialog from './AdminCreditHourCreateDialog.vue';
import ConfirmDialog from '../common/ConfirmDialog.vue';
import { useConfirm } from '../../composables/useConfirm';

const members = [
  { id: 'admin', displayName: '管理员', role: 'ADMIN', status: 'ACTIVE' },
  { id: 'a', displayName: '甲同学', role: 'MEMBER', status: 'ACTIVE' },
  { id: 'b', displayName: '乙同学', role: 'MEMBER', status: 'ACTIVE' },
  { id: 'c', displayName: '未审核成员', role: 'MEMBER', status: 'PENDING' },
];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function input(selector: string, value: string, event = 'input') {
  const element = document.querySelector<HTMLInputElement>(selector)!;
  element.value = value;
  element.dispatchEvent(new Event(event, { bubbles: true }));
}
function check(name: string, checked = true) {
  const element = document.querySelector<HTMLInputElement>(`[aria-label="选择 ${name}"]`)!;
  element.checked = checked; element.dispatchEvent(new Event('change', { bubbles: true }));
}
function submit() { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
async function openBatch() {
  const wrapper = mount(AdminCreditHourCreateDialog, { props: { open: true }, attachTo: document.body });
  await flushPromises();
  const batch = document.querySelector<HTMLInputElement>('input[value="batch"]')!;
  batch.checked = true; batch.dispatchEvent(new Event('change', { bubbles: true }));
  input('#credit-activity', '集体活动'); input('#credit-description', '已核验活动记录');
  await flushPromises();
  return wrapper;
}

describe('credit-hour batch entry', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useAuthStore().user = { id: 'admin', displayName: '管理员', role: 'ADMIN', status: 'ACTIVE' };
    useConfirm().settle(false);
  });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

  it('keeps individual overrides and search selections, resets explicitly, and confirms final per-user values', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/users') ? json({ items: members }) : json({ id: 'batch', count: 2, items: [] }));
    const wrapper = await openBatch();
    expect(document.querySelector('[aria-label="选择 管理员"]')).toBeNull();
    expect(document.querySelector('[aria-label="选择 未审核成员"]')).toBeNull();
    expect(document.querySelectorAll('.batch-entry')).toHaveLength(0);
    check('甲同学'); check('乙同学'); await flushPromises();
    input('#credit-hours', '2'); input('[aria-label="甲同学 学时"]', '3'); await flushPromises();
    input('#credit-hours', '4'); input('#credit-member-search', '乙'); await flushPromises();
    expect(document.querySelector<HTMLInputElement>('[aria-label="甲同学 学时"]')?.value).toBe('3');
    expect(document.querySelector<HTMLInputElement>('[aria-label="乙同学 学时"]')?.value).toBe('4');
    expect(document.querySelectorAll('.batch-entry')).toHaveLength(2);
    document.querySelector<HTMLButtonElement>('[aria-label="重置 甲同学 为统一学时"]')!.click(); await flushPromises();
    expect(document.querySelector<HTMLInputElement>('[aria-label="甲同学 学时"]')?.value).toBe('4');
    input('[aria-label="甲同学 学时"]', '5'); await flushPromises();
    submit(); await flushPromises();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(document.body.textContent).toContain('2 人 · 9.0 小时');
    submit(); await flushPromises();
    const [url, init] = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(url)).toContain('/admin/credit-hours/submission-batches');
    expect(JSON.parse(String(init?.body))).toEqual({ type: 'QUALITY', activityName: '集体活动', description: '已核验活动记录', entries: [{ userId: 'a', hours: 5 }, { userId: 'b', hours: 4 }] });
    expect(wrapper.emitted('saved')).toEqual([['QUALITY', 2]]);
    wrapper.unmount();
  });

  it('retains the exact payload/key and locks edits after an unknown result, then retries once', async () => {
    let attempts = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/users')) return json({ items: members });
      if (++attempts === 1) throw new TypeError('Failed to fetch');
      return json({ id: 'batch', count: 1, items: [] });
    });
    const wrapper = await openBatch(); check('甲同学'); await flushPromises();
    submit(); await flushPromises(); submit(); await flushPromises();
    expect(document.body.textContent).toContain('录入结果尚未确认');
    expect(document.querySelector<HTMLInputElement>('#credit-hours')?.disabled).toBe(true);
    expect(document.querySelector('[aria-label="关闭对话框"]')).toBeNull();
    submit(); await flushPromises();
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]![1]?.body).toBe(posts[0]![1]?.body);
    expect(new Headers(posts[1]![1]?.headers).get('Idempotency-Key')).toBe(new Headers(posts[0]![1]?.headers).get('Idempotency-Key'));
    expect(wrapper.emitted('saved')).toHaveLength(1);
    wrapper.unmount();
  });

  it('rejects invalid individual hours and retains a rejected batch for correction with a new key', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/users') ? json({ items: members }) : json({ message: '成员状态已变化' }, 400));
    const wrapper = await openBatch(); check('甲同学'); await flushPromises();
    input('[aria-label="甲同学 学时"]', '1000.5'); await flushPromises(); submit(); await flushPromises();
    expect(document.body.textContent).toContain('每位成员学时须为');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    input('[aria-label="甲同学 学时"]', '1'); await flushPromises(); submit(); await flushPromises(); submit(); await flushPromises();
    expect(document.body.textContent).toContain('成员状态已变化');
    expect(document.querySelector<HTMLInputElement>('[aria-label="甲同学 学时"]')?.value).toBe('1');
    input('[aria-label="甲同学 学时"]', '2'); await flushPromises(); submit(); await flushPromises(); submit(); await flushPromises();
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(new Headers(posts[1]![1]?.headers).get('Idempotency-Key')).not.toBe(new Headers(posts[0]![1]?.headers).get('Idempotency-Key'));
    wrapper.unmount();
  });

  it('keeps unsaved entries when closing is declined', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ items: members }));
    const confirmation = mount(ConfirmDialog, { attachTo: document.body });
    const wrapper = await openBatch();
    document.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click(); await flushPromises();
    expect(useConfirm().state.open).toBe(true);
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('.dialog-overlay:not([inert]) button')].find((button) => button.textContent === '取消')!;
    cancel.click(); await flushPromises();
    expect(wrapper.emitted('close')).toBeUndefined();
    expect(document.querySelector<HTMLInputElement>('#credit-activity')?.value).toBe('集体活动');
    wrapper.unmount();
    confirmation.unmount();
  });

  it.each(['batch', 'single'])('can discard and close %s entry after visiting batch mode with the real confirmation dialog', async (mode) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ items: members }));
    const confirmation = mount(ConfirmDialog, { attachTo: document.body });
    const wrapper = await openBatch();
    if (mode === 'single') {
      const single = document.querySelector<HTMLInputElement>('input[value="single"]')!;
      single.checked = true; single.dispatchEvent(new Event('change', { bubbles: true }));
      await flushPromises();
    }
    document.querySelector<HTMLButtonElement>('[aria-label="关闭对话框"]')!.click(); await flushPromises();
    const overlays = [...document.querySelectorAll<HTMLElement>('.dialog-overlay')];
    const upper = overlays.find((overlay) => !overlay.hasAttribute('inert'))!;
    const lower = overlays.find((overlay) => overlay.hasAttribute('inert'))!;
    expect(upper.textContent).toContain('放弃未保存录入');
    expect(upper.style.zIndex).toBe('calc(var(--z-dialog) + 10)');
    expect(lower.style.zIndex).toBe('calc(var(--z-dialog) + 0)');
    [...upper.querySelectorAll('button')].find((button) => button.textContent?.trim() === '放弃录入')!.click();
    await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(1);
    await wrapper.setProps({ open: false });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    wrapper.unmount(); confirmation.unmount();
  });
});
