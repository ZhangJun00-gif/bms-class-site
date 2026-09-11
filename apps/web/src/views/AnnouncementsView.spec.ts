import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import AnnouncementsView from './AnnouncementsView.vue';

vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), api: vi.fn() }));
const mockedApi = vi.mocked(api);
const notice = { id: 'notice-a', title: '<img src=x onerror=alert(1)>', body: '<script>alert(2)</script>\nPlain text', publishedAt: '2026-09-06T00:00:00Z', readAt: null };
let wrapper: VueWrapper;
async function setup() {
  useAuthStore().user = { id: 'member-a', role: 'MEMBER' } as never;
  mockedApi.mockImplementation(async (url) => String(url).includes('?') ? { items: [notice], nextCursor: null } : notice);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: AnnouncementsView }] });
  await router.push('/'); await router.isReady();
  wrapper = mount(RouterView, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
}

describe('announcement history integration', () => {
  beforeEach(() => { setActivePinia(createPinia()); mockedApi.mockReset(); });
  afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

  it('reads list and detail as text without recording a receipt', async () => {
    await setup();
    await wrapper.find('.announcement-list button').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain(notice.title);
    expect(wrapper.text()).toContain(notice.body);
    expect(wrapper.find('img, script').exists()).toBe(false);
    expect(mockedApi.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    wrapper.unmount();
    expect(mockedApi.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('records a receipt only from the explicit button and reloads its server state', async () => {
    await setup();
    await wrapper.find('.announcement-list button').trigger('click'); await flushPromises();
    const readAt = '2026-09-06T01:00:00Z';
    mockedApi.mockImplementation(async (url) => String(url).endsWith('/read') ? { id: notice.id, readAt } : String(url).endsWith('/status') ? { latest: { ...notice, readAt } } : { ...notice, readAt });
    await wrapper.find('.announcement-reader button').trigger('click'); await flushPromises();
    expect(mockedApi.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(mockedApi.mock.calls.find(([, options]) => options?.method === 'POST')?.[0]).toBe('/announcements/notice-a/read');
    expect(wrapper.text()).toContain('已确认阅读');
    expect(wrapper.find('.announcement-reader button').exists()).toBe(false);
  });

  it('ignores a pending detail response after an account switch', async () => {
    await setup();
    let resolve!: (value: unknown) => void;
    mockedApi.mockReturnValueOnce(new Promise((yes) => { resolve = yes; }));
    await wrapper.find('.announcement-list button').trigger('click');
    const auth = useAuthStore();
    auth.user = { id: 'member-b', role: 'MEMBER' } as never;
    auth.sessionEpoch += 1;
    mockedApi.mockResolvedValue({ items: [], nextCursor: null });
    await flushPromises();
    resolve(notice); await flushPromises();
    expect(wrapper.find('.announcement-reader').exists()).toBe(false);
    expect(wrapper.text()).not.toContain(notice.body);
  });

  it('does not reopen a detail left while explicit acknowledgement is pending', async () => {
    await setup();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 0; });
    await wrapper.find('.announcement-list button').trigger('click'); await flushPromises();
    let resolve!: (value: unknown) => void;
    const pending = new Promise((yes) => { resolve = yes; });
    const readAt = '2026-09-06T01:00:00Z';
    mockedApi.mockImplementation(async (url) => String(url).endsWith('/read') ? pending : String(url).endsWith('/status') ? { latest: { ...notice, readAt } } : { ...notice, readAt });
    await wrapper.find('.announcement-reader button').trigger('click');
    await wrapper.find('.button.ghost').trigger('click'); await flushPromises();
    expect(wrapper.find('.announcement-reader').exists()).toBe(false);
    resolve({ id: notice.id, readAt }); await flushPromises();
    expect(wrapper.find('.announcement-reader').exists()).toBe(false);
    expect(wrapper.find('.announcement-list').exists()).toBe(true);
  });

  it('keeps the reading view through same-account bootstrap and discards its older detail response', async () => {
    await setup();
    let resolveOld!: (value: unknown) => void;
    mockedApi.mockReturnValueOnce(new Promise((yes) => { resolveOld = yes; }));
    await wrapper.find('.announcement-list button').trigger('click');
    const auth = useAuthStore();
    const priorEpoch = auth.sessionEpoch;
    const fresh = { ...notice, body: 'Fresh server body', readAt: '2026-09-06T02:00:00Z' };
    mockedApi.mockImplementation(async (url) => String(url) === '/auth/me' ? { user: auth.user, csrfToken: 'synthetic-csrf' }
      : String(url).includes('?') ? { items: [fresh], nextCursor: null } : fresh);
    await auth.bootstrap(); await flushPromises();
    expect(auth.sessionEpoch).toBe(priorEpoch + 1);
    expect(wrapper.find('.announcement-reader').exists()).toBe(true);
    expect(wrapper.text()).toContain(fresh.body);
    expect(wrapper.text()).toContain('已确认阅读');
    resolveOld(notice); await flushPromises();
    expect(wrapper.text()).toContain(fresh.body);
    expect(wrapper.text()).not.toContain(notice.body);
    auth.sessionChange = 'login'; auth.sessionEpoch += 1;
    await flushPromises();
    expect(wrapper.find('.announcement-reader').exists()).toBe(false);
    expect(wrapper.find('.announcement-list').exists()).toBe(true);
  });
});
