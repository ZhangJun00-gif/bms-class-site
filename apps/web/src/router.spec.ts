import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import router from './router';

/**
 * 路由守卫配置锁定：管理后台（含题库上传/导入）仅 EDITOR/ADMIN 可达，
 * MEMBER 由 editor 守卫排除；题库页要求登录。
 */
describe('router guards', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('restricts /admin to editors so MEMBER never sees quiz upload or import', () => {
    const route = router.getRoutes().find((item) => item.path === '/admin');
    expect(route?.meta.editor).toBe(true);
  });

  it('requires authentication for /quiz', () => {
    const route = router.getRoutes().find((item) => item.path === '/quiz');
    expect(route?.meta.auth).toBe(true);
    expect(route?.meta.title).toBe('题库');
  });

  it('requires authentication for /daily', () => {
    const route = router.getRoutes().find((item) => item.path === '/daily');
    expect(route?.meta.auth).toBe(true);
    expect(route?.meta.title).toBe('每日一练');
  });

  it('requires authentication for the public credit-hour board', () => {
    const route = router.getRoutes().find((item) => item.path === '/credit-hours');
    expect(route?.meta.auth).toBe(true);
    expect(route?.meta.title).toBe('学时统计');
  });
});
