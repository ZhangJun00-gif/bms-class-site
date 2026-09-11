<script setup lang="ts">
import { computed } from 'vue';
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';

const props = defineProps<{ page: number; pageCount: number }>();
const emit = defineEmits<{ 'update:page': [page: number] }>();

const pages = computed(() => {
  if (props.pageCount > 7) return [];
  return Array.from({ length: props.pageCount }, (_, index) => index + 1);
});

function go(page: number) {
  if (page >= 1 && page <= props.pageCount) emit('update:page', page);
}
</script>

<template>
  <nav v-if="pageCount > 1" class="pagination" aria-label="分页">
    <button type="button" class="icon-button" aria-label="上一页" :disabled="page <= 1" @click="go(page - 1)">
      <ChevronLeft :size="18" />
    </button>
    <template v-if="pages.length">
      <button
        v-for="item in pages"
        :key="item"
        type="button"
        class="pagination-page"
        :class="{ active: item === page }"
        :aria-current="item === page ? 'page' : undefined"
        @click="go(item)"
      >
        {{ item }}
      </button>
    </template>
    <span v-else class="pagination-text">第 {{ page }} / {{ pageCount }} 页</span>
    <button type="button" class="icon-button" aria-label="下一页" :disabled="page >= pageCount" @click="go(page + 1)">
      <ChevronRight :size="18" />
    </button>
  </nav>
</template>

<style scoped>
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-6);
}

.pagination-page {
  min-width: 40px;
  height: 40px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--ink-soft);
  cursor: pointer;
  transition: background 0.16s var(--ease-out), border-color 0.16s var(--ease-out), color 0.16s var(--ease-out);
}

.pagination-page:hover {
  background: var(--surface-muted);
  border-color: var(--border-strong);
}

.pagination-page.active {
  background: var(--gradient-primary);
  border-color: transparent;
  color: #ffffff;
  font-weight: 600;
  box-shadow: 0 8px 16px -8px rgba(20, 31, 75, 0.5);
}

.pagination-text {
  color: var(--muted);
  font-size: 14px;
}
</style>
