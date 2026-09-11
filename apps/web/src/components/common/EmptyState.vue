<script setup lang="ts">
import { Inbox } from 'lucide-vue-next';

withDefaults(defineProps<{ title: string; hint?: string }>(), { hint: '' });
</script>

<template>
  <div class="empty-state">
    <slot name="icon">
      <Inbox :size="32" aria-hidden="true" />
    </slot>
    <p class="empty-title">{{ title }}</p>
    <p v-if="hint" class="empty-hint">{{ hint }}</p>
    <slot />
  </div>
</template>

<style scoped>
.empty-state {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  padding: var(--space-16) var(--space-5);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-l);
  background: var(--surface-tint);
  color: var(--muted);
  text-align: center;
}

.empty-state > svg {
  color: var(--border-strong);
}

.empty-title {
  margin: 0;
  font-size: 15px;
  font-weight: 550;
  color: var(--ink-soft);
}

.empty-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
}
</style>
