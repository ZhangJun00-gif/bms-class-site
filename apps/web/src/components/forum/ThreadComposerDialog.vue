<script setup lang="ts">
import { ref, watch } from 'vue';
import BaseDialog from '../common/BaseDialog.vue';
import { api, formatError } from '../../lib/api';
import { useToast } from '../../composables/useToast';
import type { ForumThread } from '../../types';

const props = defineProps<{ open: boolean; initial?: ForumThread | null }>();
const emit = defineEmits<{ close: []; saved: [thread: ForumThread] }>();

const toast = useToast();
const title = ref('');
const body = ref('');
const busy = ref(false);
const error = ref('');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    title.value = props.initial?.title ?? '';
    body.value = props.initial?.body ?? '';
    error.value = '';
  },
);

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    const payload = JSON.stringify({ title: title.value, body: body.value });
    const thread = props.initial
      ? await api<ForumThread>(`/forum/threads/${props.initial.id}`, { method: 'PATCH', body: payload })
      : await api<ForumThread>('/forum/threads', { method: 'POST', body: payload });
    toast.success(props.initial ? '主题已更新' : '主题已发布');
    emit('saved', thread);
    emit('close');
  } catch (caught) {
    error.value = formatError(caught, '保存失败，请稍后重试');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <BaseDialog :open="open" :title="initial ? '编辑主题' : '发布主题'" @close="emit('close')">
    <form class="form" @submit.prevent="submit">
      <p v-if="error" class="alert error" role="alert">{{ error }}</p>
      <div class="field">
        <label for="thread-title">标题</label>
        <input id="thread-title" v-model="title" required minlength="2" maxlength="160" placeholder="清晰描述讨论主题" />
      </div>
      <div class="field">
        <label for="thread-body">内容</label>
        <textarea id="thread-body" v-model="body" required placeholder="补充具体内容"></textarea>
      </div>
      <button class="button" type="submit" :disabled="busy">{{ busy ? '正在提交…' : initial ? '保存修改' : '发布主题' }}</button>
    </form>
  </BaseDialog>
</template>
