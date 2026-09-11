<script setup lang="ts">
import { ref } from 'vue';
import { Check, Copy } from 'lucide-vue-next';
import BaseDialog from '../common/BaseDialog.vue';

defineProps<{ open: boolean; title: string; value: string; description?: string }>();
const emit = defineEmits<{ close: [] }>();

const copied = ref(false);

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 2000);
  } catch {
    // 剪贴板不可用（非安全上下文等）：保持文本可见，由用户手动复制
  }
}
</script>

<template>
  <BaseDialog :open="open" :title="title" :width="440" @close="emit('close')">
    <div class="secret">
      <p v-if="description" class="secret-desc">{{ description }}</p>
      <div class="secret-value-row">
        <code class="secret-value">{{ value }}</code>
        <button type="button" class="icon-button" :aria-label="copied ? '已复制' : '复制'" @click="copy(value)">
          <Check v-if="copied" :size="17" class="secret-copied" />
          <Copy v-else :size="17" />
        </button>
      </div>
      <p class="secret-warning">此内容仅显示一次，关闭后不再出现在界面或状态中，请立即妥善保存。</p>
    </div>
    <template #footer>
      <button type="button" class="button" @click="emit('close')">我已保存，关闭</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.secret {
  display: grid;
  gap: var(--space-3);
}

.secret-desc {
  margin: 0;
  color: var(--ink-soft);
  line-height: 1.7;
}

.secret-value-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.secret-value {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-s);
  background: var(--surface-muted);
  font-size: 15px;
  overflow-wrap: anywhere;
  user-select: all;
}

.secret-copied {
  color: var(--success);
}

.secret-warning {
  margin: 0;
  color: var(--warning);
  font-size: 13px;
  line-height: 1.6;
}
</style>
