<script setup lang="ts">
import StatusBadge from '../common/StatusBadge.vue';
import type { ForumThread } from '../../types';

defineProps<{ threads: ForumThread[]; selectedId: string | null }>();
const emit = defineEmits<{ select: [thread: ForumThread] }>();
</script>

<template>
  <div class="thread-list" role="listbox" aria-label="主题列表">
    <button
      v-for="thread in threads"
      :key="thread.id"
      type="button"
      class="thread-item"
      :class="{ active: selectedId === thread.id }"
      role="option"
      :aria-selected="selectedId === thread.id"
      @click="emit('select', thread)"
    >
      <span class="thread-title-row">
        <StatusBadge v-if="thread.pinned" text="置顶" tone="accent" />
        <StatusBadge v-if="thread.locked" text="已锁定" tone="muted" />
        <strong class="thread-title">{{ thread.title }}</strong>
      </span>
      <span class="meta">
        <span>{{ thread.author.displayName }}</span>
        <span>{{ thread._count?.posts ?? 0 }} 条回复</span>
      </span>
    </button>
  </div>
</template>

<style scoped>
.thread-list {
  display: grid;
  border-top: 1px solid var(--border);
}

.thread-item {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-3);
  border: 0;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--border);
  border-radius: 0 var(--radius-m) var(--radius-m) 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s var(--ease-out), border-color 0.15s var(--ease-out);
}

.thread-item:hover {
  background: var(--surface-tint);
}

.thread-item.active {
  border-left-color: var(--accent);
  background: var(--accent-soft);
}

.thread-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.thread-title {
  color: var(--primary-dark);
  font-size: 15px;
  overflow-wrap: anywhere;
}
</style>
