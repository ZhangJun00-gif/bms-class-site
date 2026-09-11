<script setup lang="ts">
import { AlertTriangle, RotateCw } from 'lucide-vue-next';

withDefaults(defineProps<{ message: string; retryLabel?: string }>(), { retryLabel: '重试' });
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="error-state" role="alert">
    <AlertTriangle :size="22" aria-hidden="true" />
    <p>{{ message }}</p>
    <button type="button" class="button ghost" @click="emit('retry')">
      <RotateCw :size="16" />
      {{ retryLabel }}
    </button>
  </div>
</template>

<style scoped>
.error-state {
  display: grid;
  justify-items: center;
  gap: var(--space-3);
  padding: var(--space-10) var(--space-5);
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-l);
  background: var(--danger-bg);
  color: var(--danger);
  text-align: center;
}

.error-state p {
  margin: 0;
  line-height: 1.7;
}

.error-state .button {
  color: var(--danger);
  border-color: var(--danger-border);
}

.error-state .button:hover {
  background: #f9dfe3;
}
</style>
