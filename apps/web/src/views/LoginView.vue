<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AlertTriangle, CheckCircle2 } from 'lucide-vue-next';
import { api, formatError } from '../lib/api';
import { sanitizeRedirect } from '../lib/redirect';
import { nextTabIndex } from '../lib/tabs';
import { useAuthStore } from '../stores/auth';

const mode = ref<'login' | 'register'>('login');
const studentNumber = ref('');
const password = ref('');
const displayName = ref('');
const inviteCode = ref('');
const busy = ref(false);
const error = ref('');
const success = ref('');

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

/** 仅用户主动切换 tab 时清空提示，保留注册成功后的反馈 */
function switchMode(value: 'login' | 'register') {
  if (mode.value === value) return;
  mode.value = value;
  error.value = '';
  success.value = '';
}

const tabButtons = ref<HTMLButtonElement[]>([]);

/** WAI-ARIA tabs：←/→/Home/End 切换并移动焦点 */
function onTablistKeydown(event: KeyboardEvent, index: number) {
  const next = nextTabIndex(index, 2, event.key);
  if (next === null || next === index) return;
  event.preventDefault();
  switchMode(next === 0 ? 'login' : 'register');
  tabButtons.value[next]?.focus();
}

async function submit() {
  busy.value = true;
  error.value = '';
  success.value = '';
  try {
    if (mode.value === 'login') {
      await auth.login(studentNumber.value, password.value);
      await router.push(sanitizeRedirect(route.query.redirect));
    } else {
      // 邀请码/凭证错误返回 401，不是会话失效，不触发全局登出
      const result = await api<{ message: string }>(
        '/auth/register',
        {
          method: 'POST',
          body: JSON.stringify({
            inviteCode: inviteCode.value,
            displayName: displayName.value,
            studentNumber: studentNumber.value,
            password: password.value,
          }),
        },
        { skipUnauthorizedHandler: true },
      );
      mode.value = 'login';
      success.value = result.message;
      password.value = '';
    }
  } catch (caught) {
    error.value = formatError(caught, '操作失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="page">
    <section class="form-shell">
      <svg class="shell-ecg" viewBox="0 0 96 24" aria-hidden="true">
        <path d="M0,12 L28,12 L36,12 L41,3 L48,21 L55,7 L60,12 L96,12" />
      </svg>
      <h1>成员入口</h1>
      <p>
        班级内容仅对审核通过的成员开放。没有账号时，请使用管理员发放的邀请码申请。
      </p>

      <div class="segmented" role="tablist" aria-label="登录或申请账号">
        <button
          ref="tabButtons"
          type="button"
          role="tab"
          :aria-selected="mode === 'login'"
          :tabindex="mode === 'login' ? 0 : -1"
          :class="{ active: mode === 'login' }"
          @click="switchMode('login')"
          @keydown="onTablistKeydown($event, 0)"
        >
          登录
        </button>
        <button
          ref="tabButtons"
          type="button"
          role="tab"
          :aria-selected="mode === 'register'"
          :tabindex="mode === 'register' ? 0 : -1"
          :class="{ active: mode === 'register' }"
          @click="switchMode('register')"
          @keydown="onTablistKeydown($event, 1)"
        >
          申请账号
        </button>
      </div>

      <p v-if="error || auth.bootstrapError" class="alert error" role="alert">
        <AlertTriangle :size="17" aria-hidden="true" />
        {{ error || auth.bootstrapError }}
      </p>
      <p v-if="success" class="alert success" role="status">
        <CheckCircle2 :size="17" aria-hidden="true" />
        {{ success }}
      </p>

      <form class="form" @submit.prevent="submit">
        <template v-if="mode === 'register'">
          <div class="field">
            <label for="invite">邀请码</label>
            <input
              id="invite"
              v-model="inviteCode"
              required
              autocomplete="off"
            />
          </div>
          <div class="field">
            <label for="name">姓名</label>
            <input
              id="name"
              v-model="displayName"
              required
              minlength="2"
              autocomplete="name"
            />
          </div>
        </template>
        <div class="field">
          <label for="student-number">学号</label>
          <input
            id="student-number"
            v-model="studentNumber"
            required
            autocomplete="username"
          />
        </div>
        <div class="field">
          <label for="password">密码</label>
          <input
            id="password"
            v-model="password"
            required
            type="password"
            minlength="10"
            :autocomplete="
              mode === 'login' ? 'current-password' : 'new-password'
            "
          />
          <p v-if="mode === 'register'" class="field-hint">
            至少 10 位，且同时包含字母和数字。申请提交后需等待管理员审核。
          </p>
        </div>
        <button class="button" type="submit" :disabled="busy">
          {{ busy ? '正在提交…' : mode === 'login' ? '登录' : '提交审核' }}
        </button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.shell-ecg {
  display: block;
  width: 72px;
  height: 18px;
  margin-bottom: var(--space-4);
}

.shell-ecg path {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
