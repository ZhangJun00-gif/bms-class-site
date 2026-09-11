<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import { ApiClientError, api, formatError, isAbortError } from '../../lib/api';
import type {
  KnowledgePreviewManifest,
  KnowledgeReaderBlockItem,
  KnowledgeReaderRangeItem,
  KnowledgeReaderRangeResponse,
} from '../../types';
import KnowledgeMarkdownHeading from './KnowledgeMarkdownHeading.vue';
import MarkdownKnowledgeBlock from './MarkdownKnowledgeBlock.vue';

const props = defineProps<{ documentId: string; versionId: string }>();

const MAX_ITEMS = 90;
const EDGE_BATCH = 32;
const viewport = ref<HTMLElement>();
const manifest = ref<KnowledgePreviewManifest | null>(null);
const items = ref<KnowledgeReaderRangeItem[]>([]);
const readyBlocks = ref(new Set<string>());
const loading = ref(true);
const edgeLoading = ref(false);
const error = ref('');
const topSpacer = ref(0);
const bottomSpacer = ref(0);
const canLoadBefore = ref(false);
const canLoadAfter = ref(false);
const heightCache = new Map<string, number>();
const topEvicted = new Map<string, number>();
const bottomEvicted = new Map<string, number>();
let controller: AbortController | null = null;
let generation = 0;
let renderGeneration = 0;
let resizeObserver: ResizeObserver | null = null;

const revision = computed(() => manifest.value?.previewRevision ?? '');

function anchor(item: KnowledgeReaderRangeItem) {
  return item.kind === 'HEADING' ? item.nodeId : item.renderBlockId;
}

function headingTag(level: number) {
  return `h${Math.min(6, Math.max(2, level))}` as
    | 'h2'
    | 'h3'
    | 'h4'
    | 'h5'
    | 'h6';
}

function estimatedHeight(item: KnowledgeReaderRangeItem) {
  return heightCache.get(item.sequenceKey) ??
    (item.kind === 'HEADING' ? 70 : 136);
}

function measureItems() {
  for (const element of viewport.value?.querySelectorAll<HTMLElement>(
    '[data-preview-sequence]',
  ) ?? []) {
    const key = element.dataset.previewSequence;
    if (key) heightCache.set(key, element.getBoundingClientRect().height);
  }
}

function visibleAnchor() {
  const root = viewport.value;
  if (!root) return null;
  const rootTop = root.getBoundingClientRect().top;
  for (const element of root.querySelectorAll<HTMLElement>(
    '[data-preview-sequence]',
  )) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom > rootTop + 1) {
      return {
        key: element.dataset.previewSequence!,
        top: rect.top - rootTop,
      };
    }
  }
  return null;
}

async function mutateWithAnchor(mutate: () => void) {
  const root = viewport.value;
  const stable = visibleAnchor();
  mutate();
  await nextTick();
  if (!root || !stable) return;
  const target = root.querySelector<HTMLElement>(
    `[data-preview-sequence="${stable.key}"]`,
  );
  if (!target) return;
  const rootTop = root.getBoundingClientRect().top;
  root.scrollTop += target.getBoundingClientRect().top - rootTop - stable.top;
}

function restoreSpacer(
  added: KnowledgeReaderRangeItem[],
  evicted: Map<string, number>,
  spacer: { value: number },
) {
  for (const item of added) {
    const height = evicted.get(item.sequenceKey);
    if (height === undefined) continue;
    spacer.value = Math.max(0, spacer.value - height);
    evicted.delete(item.sequenceKey);
  }
}

function trim(direction: 'BEFORE' | 'AFTER') {
  if (items.value.length <= MAX_ITEMS) return;
  measureItems();
  const count = items.value.length - MAX_ITEMS;
  if (direction === 'AFTER') {
    const removed = items.value.slice(0, count);
    items.value = items.value.slice(count);
    for (const item of removed) {
      const height = estimatedHeight(item);
      topSpacer.value += height;
      topEvicted.set(item.sequenceKey, height);
    }
    canLoadBefore.value = true;
  } else {
    const removed = items.value.slice(-count);
    items.value = items.value.slice(0, -count);
    for (const item of removed) {
      const height = estimatedHeight(item);
      bottomSpacer.value += height;
      bottomEvicted.set(item.sequenceKey, height);
    }
    canLoadAfter.value = true;
  }
}

function merge(
  response: KnowledgeReaderRangeResponse,
  direction: 'BEFORE' | 'AFTER',
) {
  const existing = new Set(items.value.map((item) => item.sequenceKey));
  const added = response.items.filter((item) => !existing.has(item.sequenceKey));
  if (direction === 'BEFORE') {
    restoreSpacer(added, topEvicted, topSpacer);
    items.value = [...added, ...items.value];
    canLoadBefore.value = response.hasBefore || topEvicted.size > 0;
  } else {
    restoreSpacer(added, bottomEvicted, bottomSpacer);
    items.value = [...items.value, ...added];
    canLoadAfter.value = response.hasAfter || bottomEvicted.size > 0;
  }
  trim(direction);
}

function scheduleBlocks() {
  const mounted = new Set(
    items.value
      .filter((item): item is KnowledgeReaderBlockItem => item.kind === 'BLOCK')
      .map((item) => item.sequenceKey),
  );
  readyBlocks.value = new Set(
    [...readyBlocks.value].filter((key) => mounted.has(key)),
  );
  const pending = [...mounted].filter((key) => !readyBlocks.value.has(key));
  const token = ++renderGeneration;
  const run = () => {
    if (token !== renderGeneration || !pending.length) return;
    const next = new Set(readyBlocks.value);
    for (const key of pending.splice(0, 2)) next.add(key);
    readyBlocks.value = next;
    void nextTick(observeResize);
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: 120 });
    } else globalThis.setTimeout(run, 24);
  };
  run();
}

function observeResize() {
  resizeObserver?.disconnect();
  const root = viewport.value;
  if (!root || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver((entries) => {
    const rootTop = root.getBoundingClientRect().top;
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      const key = element.dataset.previewSequence;
      if (!key) continue;
      const previous = heightCache.get(key);
      const next = element.getBoundingClientRect().height;
      heightCache.set(key, next);
      if (
        previous !== undefined &&
        Math.abs(next - previous) > 0.25 &&
        element.getBoundingClientRect().bottom <= rootTop + 1
      ) {
        root.scrollTop += next - previous;
      }
    }
  });
  for (const element of root.querySelectorAll<HTMLElement>(
    '[data-preview-sequence]',
  )) {
    resizeObserver.observe(element);
  }
}

async function fetchRange(
  target: string | undefined,
  before: number,
  after: number,
  signal: AbortSignal,
) {
  const params = new URLSearchParams({
    revision: revision.value,
    before: String(before),
    after: String(after),
  });
  if (target) params.set('anchor', target);
  return api<KnowledgeReaderRangeResponse>(
    `/knowledge/documents/${encodeURIComponent(props.documentId)}/versions/${encodeURIComponent(props.versionId)}/preview/range?${params.toString()}`,
    { signal },
  );
}

async function loadEdge(direction: 'BEFORE' | 'AFTER') {
  if (edgeLoading.value || !items.value.length) return;
  if (direction === 'BEFORE' ? !canLoadBefore.value : !canLoadAfter.value) return;
  edgeLoading.value = true;
  const current = generation;
  const request = new AbortController();
  controller = request;
  const target = anchor(
    direction === 'BEFORE' ? items.value[0]! : items.value.at(-1)!,
  );
  try {
    const response = await fetchRange(
      target,
      direction === 'BEFORE' ? EDGE_BATCH : 0,
      direction === 'AFTER' ? EDGE_BATCH : 0,
      request.signal,
    );
    if (current !== generation) return;
    await mutateWithAnchor(() => merge(response, direction));
    scheduleBlocks();
    observeResize();
  } catch (caught) {
    if (!isAbortError(caught)) {
      if (caught instanceof ApiClientError && caught.status === 409) {
        void initialize();
      } else error.value = formatError(caught, '候选相邻内容加载失败');
    }
  } finally {
    if (current === generation) edgeLoading.value = false;
  }
}

function onScroll() {
  const root = viewport.value;
  if (!root) return;
  if (root.scrollTop <= topSpacer.value + 360) void loadEdge('BEFORE');
  if (
    root.scrollHeight - root.scrollTop - root.clientHeight <=
    bottomSpacer.value + 520
  ) {
    void loadEdge('AFTER');
  }
}

async function initialize() {
  const current = ++generation;
  controller?.abort();
  renderGeneration += 1;
  loading.value = true;
  error.value = '';
  items.value = [];
  readyBlocks.value = new Set();
  topSpacer.value = 0;
  bottomSpacer.value = 0;
  topEvicted.clear();
  bottomEvicted.clear();
  heightCache.clear();
  const request = new AbortController();
  controller = request;
  try {
    const result = await api<KnowledgePreviewManifest>(
      `/knowledge/documents/${encodeURIComponent(props.documentId)}/versions/${encodeURIComponent(props.versionId)}/preview`,
      { signal: request.signal },
    );
    if (current !== generation) return;
    manifest.value = result;
    if (result.firstAnchor) {
      const response = await fetchRange(
        result.firstAnchor,
        0,
        40,
        request.signal,
      );
      if (current !== generation) return;
      items.value = response.items;
      canLoadBefore.value = response.hasBefore;
      canLoadAfter.value = response.hasAfter;
      scheduleBlocks();
      await nextTick();
      observeResize();
    }
  } catch (caught) {
    if (!isAbortError(caught) && current === generation) {
      error.value = formatError(caught, '候选文档预览加载失败');
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}

watch(
  () => [props.documentId, props.versionId],
  () => void initialize(),
);
onMounted(() => void initialize());
onBeforeUnmount(() => {
  generation += 1;
  controller?.abort();
  resizeObserver?.disconnect();
});
</script>

<template>
  <section class="candidate-preview" aria-label="候选文档预览">
    <div v-if="loading" class="preview-loading">
      <SkeletonBlock v-for="index in 5" :key="index" :lines="2" />
    </div>
    <ErrorState v-else-if="error" :message="error" @retry="initialize" />
    <template v-else-if="manifest">
      <header class="preview-header">
        <span>版本标识</span>
        <KnowledgeMarkdownHeading tag="h1" :markdown="manifest.titleMarkdown" :fallback="manifest.title" />
        <p>{{ manifest.libraryName }} · {{ manifest.headingCount }} 个标题 · {{ manifest.blockCount }} 个正文块</p>
      </header>
      <div ref="viewport" class="preview-scroll" :aria-busy="edgeLoading" @scroll.passive="onScroll">
        <div class="preview-spacer" :style="{ height: `${topSpacer}px` }" aria-hidden="true" />
        <template v-for="item in items" :key="item.sequenceKey">
          <section
            v-if="item.kind === 'HEADING'"
            class="preview-heading"
            :class="`level-${item.level}`"
            :data-preview-sequence="item.sequenceKey"
          >
            <KnowledgeMarkdownHeading :tag="headingTag(item.level)" :markdown="item.titleMarkdown" :fallback="item.title" />
          </section>
          <section v-else class="preview-block" :data-preview-sequence="item.sequenceKey">
            <MarkdownKnowledgeBlock v-if="readyBlocks.has(item.sequenceKey)" :item="item" />
            <div v-else class="preview-placeholder" :style="{ minHeight: `${estimatedHeight(item)}px` }" aria-label="正在排版正文" />
          </section>
        </template>
        <div class="preview-spacer" :style="{ height: `${bottomSpacer}px` }" aria-hidden="true" />
        <p v-if="edgeLoading" class="preview-status" role="status">正在加载相邻内容</p>
        <p v-if="!items.length" class="preview-status">该候选没有可预览正文。</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.candidate-preview {
  min-width: 0;
  height: min(760px, calc(100dvh - 170px));
  min-height: 520px;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.preview-header {
  padding: 16px max(20px, calc((100% - 760px) / 2));
  border-bottom: 1px solid var(--border);
}

.preview-header > span,
.preview-header p {
  color: var(--muted);
  font-size: 12px;
}

.preview-header :deep(h1) {
  margin-top: 4px;
  color: var(--primary-dark);
  font-size: 24px;
  line-height: 1.35;
}

.preview-header p {
  margin: 6px 0 0;
}

.preview-scroll {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overflow-anchor: none;
  padding: 0 max(20px, calc((100% - 760px) / 2));
}

.preview-heading,
.preview-block {
  width: min(100%, 760px);
  margin-inline: auto;
}

.preview-heading {
  padding: 24px 0 10px;
  color: var(--primary-dark);
}

.preview-heading.level-2 { padding-top: 38px; font-size: 26px; }
.preview-heading.level-3 { padding-top: 30px; font-size: 22px; }
.preview-heading.level-4 { font-size: 19px; }
.preview-heading.level-5,
.preview-heading.level-6 { font-size: 17px; }

.preview-block {
  padding: 5px 0 10px;
}

.preview-placeholder {
  border-radius: var(--radius-s);
  background: var(--surface-muted);
}

.preview-status {
  padding: 12px;
  color: var(--muted);
  text-align: center;
}

.preview-loading {
  padding: var(--space-6);
}

@media (max-width: 560px) {
  .candidate-preview {
    height: calc(100dvh - 125px);
    min-height: 460px;
  }

  .preview-header,
  .preview-scroll {
    padding-inline: 14px;
  }
}
</style>
