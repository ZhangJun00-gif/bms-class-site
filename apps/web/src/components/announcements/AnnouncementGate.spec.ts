import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';
import { useAnnouncementsStore } from '../../stores/announcements';
import AnnouncementGate from './AnnouncementGate.vue';

vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: vi.fn() }));
const mockedApi = vi.mocked(api);
const notice = { id: 'latest', title: '<img src=x onerror=alert(1)>', body: '<script>alert(2)</script>', readAt: null };
let wrapper: VueWrapper;
async function setup() {
  useAuthStore().user = { id: 'member-a', role: 'MEMBER' } as never;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
  await router.push('/'); await router.isReady();
  wrapper = mount(AnnouncementGate, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
}

describe('mandatory announcement gate integration', () => {
  beforeEach(() => { setActivePinia(createPinia()); mockedApi.mockReset(); vi.stubGlobal('BroadcastChannel', undefined); });
  afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('renders inert plain text and cannot dismiss or acknowledge through escape', async () => {
    mockedApi.mockResolvedValue({ latest: notice }); await setup();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(notice.body);
    expect(dialog.querySelector('img, script')).toBeNull();
    expect(document.querySelector('[aria-label="关闭对话框"]')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await flushPromises();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mockedApi.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it.each([null, { ...notice, readAt: '2026-09-06T00:00:00Z' }])('does not flash a dialog while checking a read or absent notice', async (latest) => {
    let resolve!: (value: unknown) => void;
    mockedApi.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await setup();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
    resolve({ latest }); await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('preserves an unread dialog and its content during same-account identity revalidation', async () => {
    mockedApi.mockResolvedValueOnce({ latest: notice }); await setup();
    const dialog = document.querySelector('[role="dialog"]');
    let resolve!: (value: unknown) => void;
    mockedApi.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    useAuthStore().sessionEpoch += 1;
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog?.textContent).toContain(notice.body);
    resolve({ latest: { ...notice, readAt: '2026-09-06T00:00:00Z' } }); await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps a failed acknowledgement blocked and closes only after successful receipt refresh', async () => {
    mockedApi.mockResolvedValue({ latest: notice }); await setup();
    const click = () => document.querySelector<HTMLButtonElement>('.acknowledge')!.click();
    mockedApi.mockRejectedValueOnce(new TypeError('offline'));
    click(); await flushPromises();
    expect(useAnnouncementsStore().blocked).toBe(true);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    mockedApi.mockResolvedValueOnce({ id: 'latest', readAt: '2026-09-06T00:00:00Z' });
    mockedApi.mockResolvedValueOnce({ latest: { ...notice, readAt: '2026-09-06T00:00:00Z' } });
    click(); await flushPromises();
    expect(useAnnouncementsStore().blocked).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mockedApi.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(2);
  });
});
