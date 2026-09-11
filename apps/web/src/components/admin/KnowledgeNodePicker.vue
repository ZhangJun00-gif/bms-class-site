<script setup lang="ts">
import { ChevronDown, ChevronRight, Search } from 'lucide-vue-next';
import { computed, ref } from 'vue';
import type { AiQuestionGenerationNode } from '../../types';

const props = defineProps<{
  nodes: AiQuestionGenerationNode[];
  modelValue: string[];
  loading?: boolean;
  total?: number;
  query?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string[]];
  'update:query': [value: string];
  search: [];
  loadMore: [];
}>();

const collapsed = ref(new Set<string>());
const selected = computed(() => new Set(props.modelValue));
const visibleNodes = computed(() => {
  const byId = new Map(props.nodes.map((node) => [node.id, node]));
  return props.nodes.filter((node) => {
    let parentId = node.parentId;
    while (parentId) {
      if (collapsed.value.has(parentId)) return false;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return true;
  });
});

function leafIds(node: AiQuestionGenerationNode) {
  return node.leafNodeIds.length
    ? node.leafNodeIds
    : node.hasChildren
      ? []
      : [node.id];
}

function isChecked(node: AiQuestionGenerationNode) {
  const ids = leafIds(node);
  return ids.length > 0 && ids.every((id) => selected.value.has(id));
}

function isIndeterminate(node: AiQuestionGenerationNode) {
  const ids = leafIds(node);
  return ids.some((id) => selected.value.has(id)) && !isChecked(node);
}

function isDisabled(node: AiQuestionGenerationNode) {
  if (isChecked(node)) return false;
  const ids = leafIds(node);
  if (!ids.length) return true;
  return new Set([...props.modelValue, ...ids]).size > 20;
}

function toggleNode(node: AiQuestionGenerationNode) {
  const ids = leafIds(node);
  if (!ids.length) return;
  const next = new Set(props.modelValue);
  if (isChecked(node)) ids.forEach((id) => next.delete(id));
  else ids.forEach((id) => next.add(id));
  if (next.size > 20) return;
  emit('update:modelValue', [...next]);
}

function toggleCollapsed(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}
</script>

<template>
  <div class="node-picker">
    <form class="node-search" role="search" @submit.prevent="emit('search')">
      <Search :size="16" aria-hidden="true" />
      <input
        :value="query"
        aria-label="搜索知识节点"
        placeholder="搜索标题或路径"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      />
      <button type="submit" class="button ghost" :disabled="loading">搜索</button>
    </form>

    <div class="node-selection-meta" aria-live="polite">
      已选择 {{ modelValue.length }} / 20 条末级证据
    </div>

    <div class="node-tree" role="tree" aria-label="知识证据节点">
      <p v-if="loading && !nodes.length" class="empty-copy" role="status">正在加载节点…</p>
      <p v-else-if="!nodes.length" class="empty-copy">当前知识库没有可用于出题的节点</p>
      <div
        v-for="node in visibleNodes"
        v-else
        :key="node.id"
        class="node-row"
        role="treeitem"
        :aria-level="node.level"
        :aria-checked="isIndeterminate(node) ? 'mixed' : isChecked(node)"
        :aria-expanded="node.hasChildren ? !collapsed.has(node.id) : undefined"
        :style="{ '--node-depth': Math.max(0, node.level - 2) }"
      >
        <button
          v-if="node.hasChildren"
          type="button"
          class="node-expand"
          :aria-label="collapsed.has(node.id) ? '展开子节点' : '收起子节点'"
          @click="toggleCollapsed(node.id)"
        >
          <ChevronRight v-if="collapsed.has(node.id)" :size="15" />
          <ChevronDown v-else :size="15" />
        </button>
        <span v-else class="node-expand-spacer" aria-hidden="true" />
        <label class="node-label">
          <input
            type="checkbox"
            :checked="isChecked(node)"
            :indeterminate="isIndeterminate(node)"
            :disabled="isDisabled(node)"
            @change="toggleNode(node)"
          />
          <span>
            <strong>{{ node.title }}</strong>
            <small v-if="node.hasChildren">
              {{ node.breadcrumb }} · 全选其下 {{ node.leafNodeCount }} 条末级证据{{ node.leafNodeCount > 20 ? '（超过单任务上限）' : '' }}
            </small>
            <small v-else>{{ node.breadcrumb }} · {{ node.chunkCount }} 分片 · {{ node.tokenCount }} token</small>
          </span>
        </label>
      </div>
    </div>

    <button
      v-if="nodes.length < (total ?? nodes.length)"
      type="button"
      class="button ghost load-more"
      :disabled="loading"
      @click="emit('loadMore')"
    >
      {{ loading ? '加载中…' : '继续加载' }}
    </button>
  </div>
</template>

<style scoped>
.node-picker {
  min-width: 0;
  display: grid;
  gap: var(--space-3);
}

.node-search {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
}

.node-search input {
  min-width: 0;
}

.node-selection-meta,
.empty-copy {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.node-tree {
  max-height: 480px;
  overflow: auto;
  border-block: 1px solid var(--border);
}

.node-row {
  min-width: 0;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  align-items: start;
  padding: 9px 8px 9px calc(8px + var(--node-depth) * 18px);
  border-bottom: 1px solid var(--border);
}

.node-expand,
.node-expand-spacer {
  width: 28px;
  height: 28px;
}

.node-expand {
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
}

.node-label {
  min-width: 0;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: var(--space-2);
  cursor: pointer;
}

.node-label input {
  width: 18px;
  height: 18px;
  margin-top: 3px;
  accent-color: var(--accent);
}

.node-label span {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.node-label strong,
.node-label small {
  overflow-wrap: anywhere;
}

.node-label strong {
  font-size: 13px;
  line-height: 1.45;
}

.node-label small {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.45;
}

.load-more {
  justify-self: center;
}

@media (max-width: 560px) {
  .node-tree {
    max-height: 360px;
  }

  .node-search {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .node-search .button {
    grid-column: 1 / -1;
  }
}
</style>
