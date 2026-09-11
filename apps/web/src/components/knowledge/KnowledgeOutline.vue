<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ChevronDown, ChevronRight } from 'lucide-vue-next';
import KnowledgeMarkdownHeading from './KnowledgeMarkdownHeading.vue';
import type { KnowledgeReaderOutlineItem } from '../../types';

const props = defineProps<{
  items: KnowledgeReaderOutlineItem[];
  activeNodeId: string | null;
}>();
const emit = defineEmits<{ select: [nodeId: string] }>();

const scroller = ref<HTMLElement>();
const expanded = ref(new Set<string>());
const focusedNodeId = ref<string | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(600);
const estimatedRowHeight = 48;
const overscan = 18;

const itemById = computed(
  () => new Map(props.items.map((item) => [item.nodeId, item])),
);
const childIds = computed(() => {
  const result = new Map<string, string[]>();
  for (const item of props.items) {
    if (!item.parentId) continue;
    const children = result.get(item.parentId) ?? [];
    children.push(item.nodeId);
    result.set(item.parentId, children);
  }
  return result;
});
const visibleItems = computed(() =>
  props.items.filter((item) => {
    let parentId = item.parentId;
    while (parentId) {
      if (!expanded.value.has(parentId)) return false;
      parentId = itemById.value.get(parentId)?.parentId ?? null;
    }
    return true;
  }),
);
const startIndex = computed(() =>
  Math.max(
    0,
    Math.floor(scrollTop.value / estimatedRowHeight) - overscan,
  ),
);
const visibleCount = computed(
  () => Math.ceil(viewportHeight.value / estimatedRowHeight) + overscan * 2,
);
const endIndex = computed(() =>
  Math.min(visibleItems.value.length, startIndex.value + visibleCount.value),
);
const windowItems = computed(() =>
  visibleItems.value.slice(startIndex.value, endIndex.value),
);
const topSpacer = computed(() => startIndex.value * estimatedRowHeight);
const bottomSpacer = computed(
  () => (visibleItems.value.length - endIndex.value) * estimatedRowHeight,
);

function hasChildren(nodeId: string) {
  return Boolean(childIds.value.get(nodeId)?.length);
}

function toggle(nodeId: string) {
  const next = new Set(expanded.value);
  if (next.has(nodeId)) next.delete(nodeId);
  else next.add(nodeId);
  expanded.value = next;
}

function updateViewport() {
  const element = scroller.value;
  if (!element) return;
  scrollTop.value = element.scrollTop;
  viewportHeight.value = element.clientHeight;
}

function focusAt(index: number) {
  const item = visibleItems.value[Math.min(
    visibleItems.value.length - 1,
    Math.max(0, index),
  )];
  if (!item) return;
  focusedNodeId.value = item.nodeId;
  void nextTick(() => {
    scroller.value
      ?.querySelector<HTMLElement>(`[data-outline-node="${item.nodeId}"]`)
      ?.focus({ preventScroll: false });
  });
}

function onKeydown(event: KeyboardEvent, item: KnowledgeReaderOutlineItem) {
  const index = visibleItems.value.findIndex(
    (candidate) => candidate.nodeId === item.nodeId,
  );
  if (event.key === 'ArrowDown') focusAt(index + 1);
  else if (event.key === 'ArrowUp') focusAt(index - 1);
  else if (event.key === 'Home') focusAt(0);
  else if (event.key === 'End') focusAt(visibleItems.value.length - 1);
  else if (event.key === 'ArrowRight') {
    if (hasChildren(item.nodeId) && !expanded.value.has(item.nodeId))
      toggle(item.nodeId);
    else if (hasChildren(item.nodeId))
      focusAt(index + 1);
  } else if (event.key === 'ArrowLeft') {
    if (expanded.value.has(item.nodeId)) toggle(item.nodeId);
    else if (item.parentId) {
      const parentIndex = visibleItems.value.findIndex(
        (candidate) => candidate.nodeId === item.parentId,
      );
      focusAt(parentIndex);
    }
  } else if (event.key === 'Enter' || event.key === ' ') {
    emit('select', item.nodeId);
  } else return;
  event.preventDefault();
}

function revealAncestors(nodeId: string | null) {
  if (!nodeId) return;
  const next = new Set(expanded.value);
  let parentId = itemById.value.get(nodeId)?.parentId ?? null;
  while (parentId) {
    next.add(parentId);
    parentId = itemById.value.get(parentId)?.parentId ?? null;
  }
  expanded.value = next;
}

watch(
  () => props.items,
  (items) => {
    const next = new Set(expanded.value);
    for (const item of items) if (hasChildren(item.nodeId)) next.add(item.nodeId);
    expanded.value = next;
    focusedNodeId.value ??= items[0]?.nodeId ?? null;
  },
  { immediate: true },
);

watch(
  () => props.activeNodeId,
  (nodeId) => {
    revealAncestors(nodeId);
    if (!nodeId) return;
    void nextTick(() => {
      const element = scroller.value?.querySelector<HTMLElement>(
        `[data-outline-node="${nodeId}"]`,
      );
      element?.scrollIntoView({ block: 'nearest' });
    });
  },
);
</script>

<template>
  <nav
    ref="scroller"
    class="knowledge-outline"
    aria-label="知识库大纲"
    @scroll.passive="updateViewport"
  >
    <div role="tree" aria-label="标题大纲">
      <div :style="{ height: `${topSpacer}px` }" aria-hidden="true" />
      <div
        v-for="item in windowItems"
        :key="item.nodeId"
        class="outline-row"
        role="treeitem"
        :aria-level="item.level - 1"
        :aria-current="activeNodeId === item.nodeId ? 'location' : undefined"
        :aria-expanded="hasChildren(item.nodeId) ? expanded.has(item.nodeId) : undefined"
        :style="{ '--outline-depth': item.level - 2 }"
      >
        <button
          v-if="hasChildren(item.nodeId)"
          type="button"
          class="outline-toggle"
          :aria-label="expanded.has(item.nodeId) ? '收起章节' : '展开章节'"
          :title="expanded.has(item.nodeId) ? '收起章节' : '展开章节'"
          @click.stop="toggle(item.nodeId)"
        >
          <ChevronDown v-if="expanded.has(item.nodeId)" :size="14" aria-hidden="true" />
          <ChevronRight v-else :size="14" aria-hidden="true" />
        </button>
        <span v-else class="outline-toggle-spacer" aria-hidden="true" />
        <button
          type="button"
          class="outline-title"
          :class="{ active: activeNodeId === item.nodeId }"
          :tabindex="focusedNodeId === item.nodeId ? 0 : -1"
          :data-outline-node="item.nodeId"
          @focus="focusedNodeId = item.nodeId"
          @keydown="onKeydown($event, item)"
          @click="emit('select', item.nodeId)"
        >
          <KnowledgeMarkdownHeading :markdown="item.titleMarkdown" :fallback="item.title" />
        </button>
      </div>
      <div :style="{ height: `${bottomSpacer}px` }" aria-hidden="true" />
    </div>
  </nav>
</template>

<style scoped>
.knowledge-outline {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 8px 6px 24px;
  overscroll-behavior: contain;
}

.outline-row {
  min-height: 48px;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: start;
  padding-left: calc(var(--outline-depth) * 14px);
}

.outline-toggle,
.outline-toggle-spacer {
  width: 24px;
  height: 36px;
  display: grid;
  place-items: center;
}

.outline-toggle {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.outline-title {
  min-width: 0;
  min-height: 38px;
  display: block;
  padding: 8px 9px;
  border: 0;
  border-left: 2px solid transparent;
  border-radius: 0 var(--radius-s) var(--radius-s) 0;
  background: transparent;
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.55;
  text-align: left;
  cursor: pointer;
}

.outline-title:hover {
  background: var(--surface-muted);
  color: var(--primary);
}

.outline-title.active {
  border-left-color: var(--accent);
  background: var(--accent-soft);
  color: var(--primary-dark);
  font-weight: 600;
}

.outline-title:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
</style>
