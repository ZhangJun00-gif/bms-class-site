import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiClientError, api, formatError, setCsrfToken } from '../lib/api';
import { clearNewsDetailCache } from '../lib/news';
import type { User } from '../types';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const ready = ref(false);
  const bootstrapError = ref('');
  const sessionEpoch = ref(0);
  const sessionChange = ref<'bootstrap' | 'login' | 'logout' | 'expired'>('bootstrap');
  let requestGeneration = 0;
  const isAuthenticated = computed(() => Boolean(user.value));
  const canEdit = computed(
    () => user.value?.role === 'EDITOR' || user.value?.role === 'ADMIN',
  );
  const isAdmin = computed(() => user.value?.role === 'ADMIN');

  async function bootstrap() {
    const generation = ++requestGeneration;
    bootstrapError.value = '';
    try {
      const result = await api<{ user: User; csrfToken: string }>('/auth/me', {}, { skipUnauthorizedHandler: true });
      if (generation !== requestGeneration) return;
      user.value = result.user;
      setCsrfToken(result.csrfToken);
      sessionChange.value = 'bootstrap';
      sessionEpoch.value += 1;
    } catch (caught) {
      if (generation !== requestGeneration) return;
      if (caught instanceof ApiClientError && caught.status === 401) {
        clearSession('bootstrap');
        return;
      }
      bootstrapError.value = formatError(
        caught,
        '无法确认登录状态，请稍后重试',
      );
      throw caught;
    } finally {
      if (generation === requestGeneration) ready.value = true;
    }
  }

  async function login(studentNumber: string, password: string) {
    const generation = ++requestGeneration;
    // 凭证错误返回 401，但这不是会话失效，不触发全局登出
    const result = await api<{ user: User; csrfToken: string }>(
      '/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ studentNumber, password }),
      },
      { skipUnauthorizedHandler: true },
    );
    if (generation !== requestGeneration) throw new DOMException('登录状态已变化', 'AbortError');
    user.value = result.user;
    setCsrfToken(result.csrfToken);
    // 换账号登录后，上一登录态的动态详情缓存一并失效
    clearNewsDetailCache();
    bootstrapError.value = '';
    ready.value = true;
    sessionChange.value = 'login';
    sessionEpoch.value += 1;
  }

  async function logout() {
    const generation = ++requestGeneration;
    try {
      await api(
        '/auth/logout',
        { method: 'POST' },
        { skipUnauthorizedHandler: true },
      );
    } catch (caught) {
      if (!(caught instanceof ApiClientError && caught.status === 401))
        throw caught;
    }
    if (generation === requestGeneration) clearSession('logout');
  }

  function clearSession(reason: 'bootstrap' | 'logout' | 'expired' = 'expired') {
    requestGeneration += 1;
    user.value = null;
    setCsrfToken('');
    // 会话结束/切换时清空按登录态分桶的详情缓存
    clearNewsDetailCache();
    ready.value = true;
    sessionChange.value = reason;
    sessionEpoch.value += 1;
  }

  function expireSession() {
    clearSession();
    ready.value = true;
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    // 旧密码校验失败也返回 401，但服务端会话仍有效，不触发全局登出
    await api(
      '/auth/change-password',
      {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      },
      { skipUnauthorizedHandler: true },
    );
  }

  return {
    user,
    ready,
    bootstrapError,
    sessionEpoch,
    sessionChange,
    isAuthenticated,
    canEdit,
    isAdmin,
    bootstrap,
    login,
    logout,
    expireSession,
    changePassword,
  };
});
