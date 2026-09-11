import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SiteHeader from './SiteHeader.vue';

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/login', component: { template: '<div />' } },
      { path: '/news', component: { template: '<div />' } },
      { path: '/knowledge', component: { template: '<div />' } },
      { path: '/daily', component: { template: '<div />' } },
      { path: '/credit-hours', component: { template: '<div />' } },
      { path: '/quiz', component: { template: '<div />' } },
      { path: '/albums', component: { template: '<div />' } },
      { path: '/forum', component: { template: '<div />' } },
      { path: '/admin', component: { template: '<div />' } },
    ],
  });
}

describe('SiteHeader daily navigation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not expose authenticated study links to guests', async () => {
    const router = createTestRouter();
    await router.push('/');
    await router.isReady();
    const wrapper = mount(SiteHeader, {
      global: { plugins: [router], stubs: { MemberMenu: true } },
    });
    expect(wrapper.find('.desktop-nav').text()).not.toContain('每日一练');
    expect(wrapper.find('.desktop-nav').text()).not.toContain('题库');
    expect(wrapper.find('.desktop-nav').text()).not.toContain('学时统计');
  });
});
