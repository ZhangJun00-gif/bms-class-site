<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ChevronDown, KeyRound, LogOut } from 'lucide-vue-next';
import { useAuthStore } from '../../stores/auth';
import { roleLabels } from '../../lib/labels';
import { formatError } from '../../lib/api';
import { useToast } from '../../composables/useToast';
import ChangePasswordDialog from './ChangePasswordDialog.vue';

const auth = useAuthStore();
const router = useRouter();
const toast = useToast();

const open = ref(false);
const passwordDialogOpen = ref(false);
const logoutBusy = ref(false);
const logoutError = ref('');
const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const firstItem = ref<HTMLButtonElement>();

const roleLabel = computed(() => (auth.user ? roleLabels[auth.user.role] : ''));

async function toggle() {
  if (!open.value) {
    open.value = true;
    logoutError.value = '';
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onKeydown);
    await nextTick();
    firstItem.value?.focus();
  } else {
    closeMenu();
  }
}

function closeMenu(returnFocus = true) {
  open.value = false;
  release();
  if (returnFocus) void nextTick(() => trigger.value?.focus());
}

function release() {
  document.removeEventListener('click', onOutsideClick);
  document.removeEventListener('keydown', onKeydown);
}

function onOutsideClick(event: MouseEvent) {
  if (root.value && !root.value.contains(event.target as Node)) {
    closeMenu();
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
  }
}

function openPasswordDialog() {
  closeMenu(false);
  passwordDialogOpen.value = true;
}

/** 菜单项已随菜单卸载，对话框关闭后把焦点还给菜单触发按钮 */
function closePasswordDialog() {
  passwordDialogOpen.value = false;
  void nextTick(() => trigger.value?.focus());
}

async function logout() {
  if (logoutBusy.value) return;
  logoutBusy.value = true;
  logoutError.value = '';
  try {
    await auth.logout();
    closeMenu(false);
    await router.push('/');
  } catch (caught) {
    logoutError.value = formatError(caught, '退出失败，请稍后重试');
    toast.error(logoutError.value);
  } finally {
    logoutBusy.value = false;
  }
}

onBeforeUnmount(release);
</script>

<template>
  <div v-if="auth.user" ref="root" class="member-menu">
    <button
      ref="trigger"
      type="button"
      class="member-trigger"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="member-name">{{ auth.user.displayName }}</span>
      <span class="member-role">{{ roleLabel }}</span>
      <ChevronDown :size="16" aria-hidden="true" />
    </button>
    <div v-if="open" class="member-dropdown" role="menu">
      <button ref="firstItem" type="button" role="menuitem" :disabled="logoutBusy" @click="openPasswordDialog">
        <KeyRound :size="16" aria-hidden="true" />
        修改密码
      </button>
      <button type="button" role="menuitem" :disabled="logoutBusy" @click="logout">
        <LogOut :size="16" aria-hidden="true" />
        {{ logoutBusy ? '正在退出…' : '退出登录' }}
      </button>
      <p v-if="logoutError" class="logout-error" role="alert">{{ logoutError }}</p>
    </div>
    <ChangePasswordDialog :open="passwordDialogOpen" @close="closePasswordDialog" />
  </div>
</template>

<style scoped>
.member-menu {
  position: relative;
}

.member-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
  transition: background 0.16s var(--ease-out), border-color 0.16s var(--ease-out);
}

.member-trigger:hover {
  background: var(--surface-muted);
  border-color: var(--border-strong);
}

.member-name {
  font-size: 14px;
  font-weight: 550;
}

.member-role {
  font-size: 12px;
  color: var(--accent-dark);
}

.member-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 176px;
  display: grid;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-m);
  z-index: calc(var(--z-header) + 1);
}

.member-dropdown button {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 10px 12px;
  border: 0;
  border-radius: var(--radius-s);
  background: none;
  color: var(--ink-soft);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background 0.14s var(--ease-out), color 0.14s var(--ease-out);
}

.member-dropdown button:hover {
  background: var(--surface-muted);
  color: var(--primary);
}

.member-dropdown button:disabled {
  opacity: 0.58;
  cursor: not-allowed;
}

.logout-error {
  margin: 4px 8px 6px;
  color: var(--danger);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

@media (max-width: 560px) {
  .member-trigger {
    max-width: 148px;
    padding: 0 10px;
  }

  .member-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .member-role {
    display: none;
  }
}
</style>
