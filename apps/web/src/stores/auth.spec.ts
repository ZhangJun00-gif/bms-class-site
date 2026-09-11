import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUnauthorizedHandler } from '../lib/api';
import { useAuthStore } from './auth';

const user = {
  id: 'admin-1',
  displayName: '测试管理员',
  role: 'ADMIN' as const,
  status: 'ACTIVE' as const,
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('auth store session handling', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setUnauthorizedHandler(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it('does not erase an existing user when bootstrap hits a network failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ user, csrfToken: 'csrf' }))
      .mockRejectedValueOnce(new TypeError('network down'));
    const auth = useAuthStore();
    await auth.login('2510305300', 'password123');

    await expect(auth.bootstrap()).rejects.toBeInstanceOf(TypeError);
    expect(auth.user).toEqual(user);
    expect(auth.bootstrapError).toBe('网络连接失败，请检查网络后重试');
  });

  it('clears the local session when bootstrap receives 401', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ user, csrfToken: 'csrf' }))
      .mockResolvedValueOnce(jsonResponse({ message: '请先登录' }, 401));
    const auth = useAuthStore();
    await auth.login('2510305300', 'password123');

    await auth.bootstrap();
    expect(auth.user).toBeNull();
    expect(auth.ready).toBe(true);
  });

  it('finishes local logout when the server session is already invalid', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ user, csrfToken: 'csrf' }))
      .mockResolvedValueOnce(jsonResponse({ message: '请先登录' }, 401));
    const auth = useAuthStore();
    await auth.login('2510305300', 'password123');

    await expect(auth.logout()).resolves.toBeUndefined();
    expect(auth.user).toBeNull();
  });

  it('keeps the session and skips the unauthorized handler when the current password is wrong', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ user, csrfToken: 'csrf' }))
      .mockResolvedValueOnce(jsonResponse({ message: '当前密码错误' }, 401));
    const auth = useAuthStore();
    await auth.login('2510305300', 'password123');

    await expect(auth.changePassword('wrong-password', 'new-password-1')).rejects.toMatchObject({
      status: 401,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(auth.user).toEqual(user);
  });

  it('does not trigger the unauthorized handler on a failed login', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ message: '学号或密码错误' }, 401),
    );
    const auth = useAuthStore();

    await expect(auth.login('2510305300', 'bad-password')).rejects.toMatchObject({
      status: 401,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(auth.user).toBeNull();
  });
});
