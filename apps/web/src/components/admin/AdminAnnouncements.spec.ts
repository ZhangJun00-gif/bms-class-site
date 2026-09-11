import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, api } from '../../lib/api';
import AdminAnnouncements from './AdminAnnouncements.vue';
import { useAuthStore } from '../../stores/auth';

const confirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../../composables/useConfirm', () => ({ useConfirm: () => ({ confirm }) }));
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: vi.fn() }));
const mockedApi = vi.mocked(api);
const draft = { id: 'draft-a', status: 'DRAFT', title: 'Draft title', body: '<img src=x onerror="alert(1)">\n<script>alert(2)</script>', revision: 3, updatedAt: '2026-09-06T00:00:00Z' };
let wrapper: VueWrapper;
function button(text: string) {
  const element = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
  expect(element, text).toBeDefined();
  return element!;
}
async function setup() {
  useAuthStore().user = { id: 'admin-a', role: 'ADMIN' } as never;
  mockedApi.mockImplementation(async (url) => String(url).includes('?') ? { items: [draft], nextCursor: null } : draft);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: AdminAnnouncements }] });
  await router.push('/'); await router.isReady();
  wrapper = mount(RouterView, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
}
async function openDraft() {
  document.querySelector<HTMLButtonElement>('.announcement-directory li button')!.click();
  await flushPromises();
}

describe('administrator announcement integration', () => {
  beforeEach(() => { setActivePinia(createPinia()); mockedApi.mockReset(); confirm.mockReset().mockResolvedValue(false); });
  afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; });

  it('renders preview as plain text and publishes only after explicit confirmation', async () => {
    await setup(); await openDraft();
    button('预览').click(); await flushPromises();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(draft.body);
    expect(dialog.querySelector('img, script')).toBeNull();
    expect(mockedApi.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    mockedApi.mockImplementation(async (url) => String(url).endsWith('/publish') ? { ...draft, status: 'PUBLISHED', revision: 4 } : { items: [draft], nextCursor: null });
    button('确认发布').click(); await flushPromises();
    expect(mockedApi).toHaveBeenCalledWith('/admin/announcements/draft-a/publish', { method: 'POST', body: JSON.stringify({ expectedRevision: 3 }) });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('prevents publishing unsaved changes from the preview', async () => {
    await setup(); await openDraft();
    await wrapper.find('#announcement-body').setValue('Local unsaved revision');
    button('预览').click(); await flushPromises();
    expect(button('确认发布').disabled).toBe(true);
    expect(document.body.textContent).toContain('尚未保存当前预览');
    expect(mockedApi.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('preserves conflicting local draft and requires approval before reload', async () => {
    await setup(); await openDraft();
    await wrapper.find('#announcement-body').setValue('Local unsaved revision');
    mockedApi.mockRejectedValueOnce(new ApiClientError('conflict', 409));
    await wrapper.find('.announcement-editor form').trigger('submit'); await flushPromises();
    expect((wrapper.find('#announcement-body').element as HTMLTextAreaElement).value).toBe('Local unsaved revision');
    expect(button('保存草稿').disabled).toBe(true);
    const calls = mockedApi.mock.calls.length;
    button('重新载入').click(); await flushPromises();
    expect(confirm).toHaveBeenCalledOnce();
    expect(mockedApi).toHaveBeenCalledTimes(calls);
    expect((wrapper.find('#announcement-body').element as HTMLTextAreaElement).value).toBe('Local unsaved revision');
    confirm.mockResolvedValueOnce(true);
    mockedApi.mockResolvedValueOnce({ ...draft, body: 'Server revision', revision: 4 });
    button('重新载入').click(); await flushPromises();
    expect((wrapper.find('#announcement-body').element as HTMLTextAreaElement).value).toBe('Server revision');
    expect(button('保存草稿').disabled).toBe(false);
  });

  it('preserves an unsaved draft during same-account focus revalidation', async () => {
    await setup(); await openDraft();
    await wrapper.find('#announcement-body').setValue('Unsaved local text');
    const auth = useAuthStore();
    auth.sessionChange = 'bootstrap'; auth.sessionEpoch += 1;
    await flushPromises();
    expect((wrapper.find('#announcement-body').element as HTMLTextAreaElement).value).toBe('Unsaved local text');
  });

  it('clears prior draft on the same account logging in again', async () => {
    await setup(); await openDraft();
    await wrapper.find('#announcement-body').setValue('Prior login text');
    const auth = useAuthStore();
    auth.sessionChange = 'login'; auth.sessionEpoch += 1;
    await flushPromises();
    expect((wrapper.find('#announcement-body').element as HTMLTextAreaElement).value).toBe('');
  });

  it('does not refill an old account mutation or unlock the new account save', async () => {
    await setup(); await openDraft();
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    const oldRequest = new Promise((yes) => { resolveOld = yes; });
    const newRequest = new Promise((yes) => { resolveNew = yes; });
    mockedApi.mockImplementation(async (_url, options) => options?.method === 'PATCH' ? oldRequest : options?.method === 'POST' ? newRequest : { items: [], nextCursor: null });
    await wrapper.find('#announcement-body').setValue('Old account pending text');
    await wrapper.find('.announcement-editor form').trigger('submit');
    const auth = useAuthStore();
    auth.user = { id: 'admin-b', role: 'ADMIN' } as never;
    auth.sessionChange = 'bootstrap'; auth.sessionEpoch += 1;
    await flushPromises();
    expect((wrapper.find('#announcement-body').element as HTMLTextAreaElement).value).toBe('');
    await wrapper.find('#announcement-title').setValue('New account title');
    await wrapper.find('#announcement-body').setValue('New account text');
    await wrapper.find('.announcement-editor form').trigger('submit');
    resolveOld({ ...draft, body: 'Old account pending text', revision: 4 }); await flushPromises();
    expect((wrapper.find('#announcement-body').element as HTMLTextAreaElement).value).toBe('New account text');
    expect(button('正在保存').disabled).toBe(true);
    resolveNew({ ...draft, id: 'new', title: 'New account title', body: 'New account text' }); await flushPromises();
    expect(button('保存草稿').disabled).toBe(false);
  });
});
