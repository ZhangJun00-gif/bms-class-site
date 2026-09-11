<script setup lang="ts">
import { ref, watch } from 'vue';
import BaseDialog from '../common/BaseDialog.vue';
import { useAuthStore } from '../../stores/auth';
import { formatError } from '../../lib/api';
import { useToast } from '../../composables/useToast';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const auth = useAuthStore();
const toast = useToast();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const busy = ref(false);
const error = ref('');

watch(
  () => props.open,
  (open) => {
    if (open) {
      currentPassword.value = '';
      newPassword.value = '';
      confirmPassword.value = '';
      error.value = '';
    }
  },
);

async function submit() {
  error.value = '';
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次输入的新密码不一致';
    return;
  }
  busy.value = true;
  try {
    await auth.changePassword(currentPassword.value, newPassword.value);
    toast.success('密码已更新，其他设备的会话已退出');
    emit('close');
  } catch (caught) {
    error.value = formatError(caught, '修改密码失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <BaseDialog :open="open" title="修改密码" :width="440" @close="emit('close')">
    <form class="form" @submit.prevent="submit">
      <p v-if="error" class="alert error" role="alert">{{ error }}</p>
      <div class="field">
        <label for="current-password">当前密码</label>
        <input id="current-password" v-model="currentPassword" type="password" required autocomplete="current-password" />
      </div>
      <div class="field">
        <label for="new-password">新密码</label>
        <input
          id="new-password"
          v-model="newPassword"
          type="password"
          required
          minlength="10"
          autocomplete="new-password"
        />
        <p class="field-hint">至少 10 位，且同时包含字母和数字。</p>
      </div>
      <div class="field">
        <label for="confirm-password">确认新密码</label>
        <input id="confirm-password" v-model="confirmPassword" type="password" required autocomplete="new-password" />
      </div>
      <button class="button" type="submit" :disabled="busy">{{ busy ? '正在提交…' : '确认修改' }}</button>
    </form>
  </BaseDialog>
</template>
