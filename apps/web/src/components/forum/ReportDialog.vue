<script setup lang="ts">
import { ref, watch } from 'vue';
import BaseDialog from '../common/BaseDialog.vue';
import { api, formatError } from '../../lib/api';
import { useToast } from '../../composables/useToast';

export interface ReportTarget {
  kind: 'thread' | 'post';
  id: string;
  label: string;
}

const props = defineProps<{ open: boolean; target: ReportTarget | null }>();
const emit = defineEmits<{ close: [] }>();

const toast = useToast();
const reason = ref('');
const busy = ref(false);
const error = ref('');

watch(
  () => props.open,
  (open) => {
    if (open) {
      reason.value = '';
      error.value = '';
    }
  },
);

async function submit() {
  if (!props.target) return;
  busy.value = true;
  error.value = '';
  try {
    await api(`/forum/${props.target.kind === 'thread' ? 'threads' : 'posts'}/${props.target.id}/reports`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.value }),
    });
    toast.success('已提交举报，感谢反馈');
    emit('close');
  } catch (caught) {
    error.value = formatError(caught, '提交失败，请稍后重试');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <BaseDialog :open="open" title="举报内容" :width="440" @close="emit('close')">
    <form class="form" @submit.prevent="submit">
      <p v-if="error" class="alert error" role="alert">{{ error }}</p>
      <p v-if="target" class="report-target">举报对象：{{ target.label }}</p>
      <div class="field">
        <label for="report-reason">举报原因</label>
        <textarea id="report-reason" v-model="reason" required minlength="2" maxlength="500" placeholder="说明举报原因（2–500 字）"></textarea>
      </div>
      <button class="button" type="submit" :disabled="busy">{{ busy ? '正在提交…' : '提交举报' }}</button>
    </form>
  </BaseDialog>
</template>

<style scoped>
.report-target {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
