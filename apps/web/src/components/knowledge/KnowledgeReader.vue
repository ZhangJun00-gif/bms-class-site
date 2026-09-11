<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import {
  ArrowLeft,
  BookOpenText,
  ListTree,
  Network,
  X,
} from 'lucide-vue-next';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import { ApiClientError, api, formatError, isAbortError } from '../../lib/api';
import { KNOWLEDGE_RENDERER_VERSION } from '../../lib/knowledgeMarkdown';
import type {
  KnowledgeReaderBlockItem,
  KnowledgeReaderManifest,
  KnowledgeReaderOutlineItem,
  KnowledgeReaderOutlineResponse,
  KnowledgeReaderRangeItem,
  KnowledgeReaderRangeResponse,
} from '../../types';
import KnowledgeMarkdownHeading from './KnowledgeMarkdownHeading.vue';
import KnowledgeMindMap from './KnowledgeMindMap.vue';
import KnowledgeOutline from './KnowledgeOutline.vue';
import MarkdownKnowledgeBlock from './MarkdownKnowledgeBlock.vue';

const props = defineProps<{
  libraryId: string;
  initialNodeId?: string;
  initialBlockId?: string;
  initialView?: 'READ' | 'MINDMAP';
}>();
const emit = defineEmits<{
  back: [];
  locate: [location: { nodeId: string; blockId?: string }];
  view: [view: 'READ' | 'MINDMAP'];
}>();

const MAX_DOM_ITEMS = 100;
const HEIGHT_CACHE_LIMIT = 1_000;
const EDGE_BATCH = 28;
const viewport = ref<HTMLElement>();
const manifest = ref<KnowledgeReaderManifest | null>(null);
const outlineItems = ref<KnowledgeReaderOutlineItem[]>([]);
const outlineTotal = ref(0);
const outlineDone = ref(false);
const rangeItems = ref<KnowledgeReaderRangeItem[]>([]);
const readyBlocks = ref(new Set<string>());
const activeNodeId = ref<string | null>(null);
const loading = ref(true);
const rangeLoading = ref(false);
const outlineLoading = ref(false);
const loadingBefore = ref(false);
const loadingAfter = ref(false);
const error = ref('');
const transientStatus = ref('');
const viewMode = ref<'READ' | 'MINDMAP'>(props.initialView ?? 'READ');
const outlineOpen = ref(
  typeof window.matchMedia === 'function'
    ? !window.matchMedia('(max-width: 900px)').matches
    : true,
);
const canLoadBefore = ref(false);
const canLoadAfter = ref(false);
const topSpacer = ref(0);
const bottomSpacer = ref(0);
const topEvicted = new Map<string, number>();
const bottomEvicted = new Map<string, number>();
const heightCache = new Map<string, number>();
const requestControllers = new Set<AbortController>();
let generation = 0;
let rangeGeneration = 0;
let renderScheduleGeneration = 0;
let scrollFrame = 0;
let itemResizeObserver: ResizeObserver | null = null;
let viewportResizeObserver: ResizeObserver | null = null;
let widthBucket = 0;
let pinnedLocation: { nodeId: string; blockId?: string } | null = null;
let renderBatchesPending = 0;

const readerRevision = computed(() => manifest.value?.readerRevision ?? '');
const outlineProgress = computed(() =>
  outlineTotal.value
    ? Math.min(1, outlineItems.value.length / outlineTotal.value)
    : outlineDone.value
      ? 1
      : 0,
);

function newController() {
  const controller = new AbortController();
  requestControllers.add(controller);
  controller.signal.addEventListener(
    'abort',
    () => requestControllers.delete(controller),
    { once: true },
  );
  return controller;
}

function abortRequests() {
  for (const controller of requestControllers) controller.abort();
  requestControllers.clear();
}

function itemAnchor(item: KnowledgeReaderRangeItem) {
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

function heightCacheKey(sequenceKey: string) {
  return `${readerRevision.value}\0${sequenceKey}\0${KNOWLEDGE_RENDERER_VERSION}\0${widthBucket}`;
}

function setCachedHeight(sequenceKey: string, height: number) {
  if (!Number.isFinite(height) || height <= 0) return;
  const key = heightCacheKey(sequenceKey);
  heightCache.delete(key);
  heightCache.set(key, height);
  while (heightCache.size > HEIGHT_CACHE_LIMIT) {
    const oldest = heightCache.keys().next().value as string | undefined;
    if (!oldest) break;
    heightCache.delete(oldest);
  }
}

function cachedHeight(item: KnowledgeReaderRangeItem) {
  const key = heightCacheKey(item.sequenceKey);
  const value = heightCache.get(key);
  if (value !== undefined) {
    heightCache.delete(key);
    heightCache.set(key, value);
    return value;
  }
  return item.kind === 'HEADING' ? 72 : 132;
}

function measureMountedItems() {
  const element = viewport.value;
  if (!element) return;
  for (const item of element.querySelectorAll<HTMLElement>(
    '[data-reader-sequence]',
  )) {
    const sequenceKey = item.dataset.readerSequence;
    if (sequenceKey) setCachedHeight(sequenceKey, item.getBoundingClientRect().height);
  }
}

function stableVisibleAnchor() {
  const element = viewport.value;
  if (!element) return null;
  const containerTop = element.getBoundingClientRect().top;
  const candidates = element.querySelectorAll<HTMLElement>(
    '[data-reader-sequence]',
  );
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    if (rect.bottom > containerTop + 1) {
      return {
        sequenceKey: candidate.dataset.readerSequence!,
        top: rect.top - containerTop,
      };
    }
  }
  return null;
}

function findMounted(sequenceKey: string) {
  return viewport.value?.querySelector<HTMLElement>(
    `[data-reader-sequence="${sequenceKey}"]`,
  );
}

function findPinnedMounted() {
  const element = viewport.value;
  if (!element || !pinnedLocation) return null;
  return pinnedLocation.blockId
    ? element.querySelector<HTMLElement>(
        `[data-block-id="${pinnedLocation.blockId}"]`,
      )
    : element.querySelector<HTMLElement>(
        `[data-heading-node="${pinnedLocation.nodeId}"]`,
      );
}

function mutationAnchor() {
  const element = viewport.value;
  const pinned = findPinnedMounted();
  if (element && pinned?.dataset.readerSequence) {
    return {
      sequenceKey: pinned.dataset.readerSequence,
      top: pinned.getBoundingClientRect().top - element.getBoundingClientRect().top,
    };
  }
  return stableVisibleAnchor();
}

function recordCompensation(
  reason: string,
  sequenceKey: string,
  previousTop: number,
  nextTop: number,
) {
  const deviation = nextTop - previousTop;
  const element = viewport.value;
  if (element) element.dataset.lastAnchorDeviation = deviation.toFixed(3);
  element?.dispatchEvent(
    new CustomEvent('knowledge-reader-anchor-compensated', {
      bubbles: true,
      detail: { reason, sequenceKey, previousTop, nextTop, deviation },
    }),
  );
}

async function mutateWithAnchor(reason: string, mutate: () => void) {
  const element = viewport.value;
  const anchor = mutationAnchor();
  mutate();
  await nextTick();
  if (!element || !anchor) return;
  const mounted = findMounted(anchor.sequenceKey);
  if (!mounted) return;
  const containerTop = element.getBoundingClientRect().top;
  const nextTop = mounted.getBoundingClientRect().top - containerTop;
  element.scrollTop += nextTop - anchor.top;
  const correctedTop = mounted.getBoundingClientRect().top - containerTop;
  recordCompensation(
    reason,
    anchor.sequenceKey,
    anchor.top,
    correctedTop,
  );
}

function restoreEvictedHeight(
  items: KnowledgeReaderRangeItem[],
  evicted: Map<string, number>,
  spacer: { value: number },
) {
  for (const item of items) {
    const height = evicted.get(item.sequenceKey);
    if (height === undefined) continue;
    spacer.value = Math.max(0, spacer.value - height);
    evicted.delete(item.sequenceKey);
  }
}

function trimItems(direction: 'BEFORE' | 'AFTER') {
  if (rangeItems.value.length <= MAX_DOM_ITEMS) return;
  measureMountedItems();
  const removeCount = rangeItems.value.length - MAX_DOM_ITEMS;
  if (direction === 'AFTER') {
    const removed = rangeItems.value.slice(0, removeCount);
    rangeItems.value = rangeItems.value.slice(removeCount);
    for (const item of removed) {
      const height = cachedHeight(item);
      topSpacer.value += height;
      topEvicted.set(item.sequenceKey, height);
    }
    canLoadBefore.value = true;
  } else {
    const removed = rangeItems.value.slice(-removeCount);
    rangeItems.value = rangeItems.value.slice(0, -removeCount);
    for (const item of removed) {
      const height = cachedHeight(item);
      bottomSpacer.value += height;
      bottomEvicted.set(item.sequenceKey, height);
    }
    canLoadAfter.value = true;
  }
}

function mergeRange(
  response: KnowledgeReaderRangeResponse,
  direction: 'BEFORE' | 'AFTER',
) {
  const existing = new Set(rangeItems.value.map((item) => item.sequenceKey));
  const added = response.items.filter((item) => !existing.has(item.sequenceKey));
  if (direction === 'BEFORE') {
    restoreEvictedHeight(added, topEvicted, topSpacer);
    rangeItems.value = [...added, ...rangeItems.value];
    canLoadBefore.value = response.hasBefore || topEvicted.size > 0;
  } else {
    restoreEvictedHeight(added, bottomEvicted, bottomSpacer);
    rangeItems.value = [...rangeItems.value, ...added];
    canLoadAfter.value = response.hasAfter || bottomEvicted.size > 0;
  }
  trimItems(direction);
}

function pruneAndScheduleBlocks() {
  const mountedKeys = new Set(
    rangeItems.value
      .filter((item): item is KnowledgeReaderBlockItem => item.kind === 'BLOCK')
      .map((item) => item.sequenceKey),
  );
  readyBlocks.value = new Set(
    [...readyBlocks.value].filter((key) => mountedKeys.has(key)),
  );
  const token = ++renderScheduleGeneration;
  const pending = [...mountedKeys].filter((key) => !readyBlocks.value.has(key));
  renderBatchesPending = pending.length;
  const run = async () => {
    if (token !== renderScheduleGeneration || !pending.length) return;
    const next = new Set(readyBlocks.value);
    for (const key of pending.splice(0, 2)) next.add(key);
    await mutateWithAnchor('RENDER_BATCH', () => {
      readyBlocks.value = next;
    });
    if (token !== renderScheduleGeneration) return;
    renderBatchesPending = pending.length;
    measureMountedItems();
    observeItems();
    if (!pending.length) {
      const target = pinnedLocation
        ? findLoadedTarget(pinnedLocation.nodeId, pinnedLocation.blockId)
        : undefined;
      if (target) await scrollToItem(target);
      return;
    }
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => void run(), { timeout: 120 });
    } else globalThis.setTimeout(() => void run(), 24);
  };
  void run();
}

function observeItems() {
  itemResizeObserver?.disconnect();
  const element = viewport.value;
  if (!element || typeof ResizeObserver === 'undefined') return;
  itemResizeObserver = new ResizeObserver((entries) => {
    const mountedItems = [
      ...element.querySelectorAll<HTMLElement>('[data-reader-sequence]'),
    ];
    const anchor = stableVisibleAnchor();
    const anchorElement = anchor ? findMounted(anchor.sequenceKey) : null;
    const anchorIndex = anchorElement ? mountedItems.indexOf(anchorElement) : -1;
    let heightDeltaAboveAnchor = 0;
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      const sequenceKey = target.dataset.readerSequence;
      if (!sequenceKey) continue;
      const key = heightCacheKey(sequenceKey);
      const previous = heightCache.get(key);
      const next = target.getBoundingClientRect().height;
      setCachedHeight(sequenceKey, next);
      if (previous === undefined || Math.abs(next - previous) < 0.25) continue;
      const targetIndex = mountedItems.indexOf(target);
      if (anchorIndex >= 0 && targetIndex >= 0 && targetIndex < anchorIndex) {
        heightDeltaAboveAnchor += next - previous;
      }
    }
    if (!anchor || Math.abs(heightDeltaAboveAnchor) < 0.25) return;
    const previousTop = anchor.top - heightDeltaAboveAnchor;
    element.scrollTop += heightDeltaAboveAnchor;
    const mounted = findMounted(anchor.sequenceKey);
    const containerTop = element.getBoundingClientRect().top;
    const corrected = mounted
      ? mounted.getBoundingClientRect().top - containerTop
      : previousTop;
    recordCompensation(
      'RESIZE_ABOVE_ANCHOR',
      anchor.sequenceKey,
      previousTop,
      corrected,
    );
  });
  for (const item of element.querySelectorAll<HTMLElement>(
    '[data-reader-sequence]',
  )) {
    itemResizeObserver.observe(item);
  }
}

async function loadOutline(currentGeneration: number) {
  const currentManifest = manifest.value;
  if (!currentManifest) return;
  outlineLoading.value = true;
  outlineDone.value = false;
  outlineItems.value = [];
  outlineTotal.value = 0;
  let cursor: string | null = null;
  try {
    do {
      const controller = newController();
      const params = new URLSearchParams({
        revision: currentManifest.readerRevision,
        limit: '100',
      });
      if (cursor) params.set('cursor', cursor);
      const response = await api<KnowledgeReaderOutlineResponse>(
        `/knowledge/libraries/${encodeURIComponent(props.libraryId)}/reader/outline?${params.toString()}`,
        { signal: controller.signal },
      );
      requestControllers.delete(controller);
      if (currentGeneration !== generation) return;
      outlineItems.value.push(...response.items);
      outlineTotal.value = response.total;
      cursor = response.nextCursor;
    } while (cursor);
    outlineDone.value = true;
  } catch (caught) {
    if (!isAbortError(caught) && currentGeneration === generation) {
      if (caught instanceof ApiClientError && caught.status === 409) {
        void refreshRevision();
      } else {
        transientStatus.value = formatError(caught, '大纲加载失败');
      }
    }
  } finally {
    if (currentGeneration === generation) outlineLoading.value = false;
  }
}

async function fetchRange(
  anchor: string | undefined,
  before: number,
  after: number,
  signal: AbortSignal,
) {
  const currentManifest = manifest.value;
  if (!currentManifest) throw new Error('READER_MANIFEST_MISSING');
  const params = new URLSearchParams({
    revision: currentManifest.readerRevision,
    before: String(before),
    after: String(after),
  });
  if (anchor) params.set('anchor', anchor);
  return api<KnowledgeReaderRangeResponse>(
    `/knowledge/libraries/${encodeURIComponent(props.libraryId)}/reader/range?${params.toString()}`,
    { signal },
  );
}

async function loadEdge(direction: 'BEFORE' | 'AFTER') {
  if (!rangeItems.value.length) return;
  const loadingFlag = direction === 'BEFORE' ? loadingBefore : loadingAfter;
  const allowed = direction === 'BEFORE' ? canLoadBefore.value : canLoadAfter.value;
  if (loadingFlag.value || !allowed) return;
  loadingFlag.value = true;
  const requestId = rangeGeneration;
  const controller = newController();
  const anchor = itemAnchor(
    direction === 'BEFORE'
      ? rangeItems.value[0]!
      : rangeItems.value.at(-1)!,
  );
  try {
    const response = await fetchRange(
      anchor,
      direction === 'BEFORE' ? EDGE_BATCH : 0,
      direction === 'AFTER' ? EDGE_BATCH : 0,
      controller.signal,
    );
    if (requestId !== rangeGeneration) return;
    await mutateWithAnchor(`LOAD_${direction}`, () =>
      mergeRange(response, direction),
    );
    pruneAndScheduleBlocks();
    observeItems();
  } catch (caught) {
    if (!isAbortError(caught)) {
      if (caught instanceof ApiClientError && caught.status === 409) {
        void refreshRevision();
      } else transientStatus.value = formatError(caught, '相邻内容加载失败');
    }
  } finally {
    requestControllers.delete(controller);
    loadingFlag.value = false;
  }
}

function findLoadedTarget(nodeId: string, blockId?: string) {
  return rangeItems.value.find(
    (item) =>
      (blockId && item.kind === 'BLOCK' && item.renderBlockId === blockId) ||
      (!blockId && item.kind === 'HEADING' && item.nodeId === nodeId),
  );
}

async function scrollToItem(item: KnowledgeReaderRangeItem) {
  await nextTick();
  const element = viewport.value;
  const target = findMounted(item.sequenceKey);
  if (!element || !target) return;
  const containerTop = element.getBoundingClientRect().top;
  const targetTop = target.getBoundingClientRect().top;
  element.scrollTop += targetTop - containerTop - 24;
}

async function locate(nodeId: string, blockId?: string) {
  setView('READ');
  transientStatus.value = '';
  pinnedLocation = { nodeId, ...(blockId ? { blockId } : {}) };
  const loaded = findLoadedTarget(nodeId, blockId);
  if (loaded) {
    await scrollToItem(loaded);
    activeNodeId.value = nodeId;
    emit('locate', { nodeId, ...(blockId ? { blockId } : {}) });
    return;
  }
  rangeLoading.value = true;
  const requestId = ++rangeGeneration;
  const controller = newController();
  try {
    const response = await fetchRange(
      blockId ?? nodeId,
      12,
      28,
      controller.signal,
    );
    if (requestId !== rangeGeneration) return;
    rangeItems.value = response.items;
    topSpacer.value = 0;
    bottomSpacer.value = 0;
    topEvicted.clear();
    bottomEvicted.clear();
    canLoadBefore.value = response.hasBefore;
    canLoadAfter.value = response.hasAfter;
    pruneAndScheduleBlocks();
    const target = findLoadedTarget(nodeId, blockId);
    if (target) await scrollToItem(target);
    activeNodeId.value = nodeId;
    emit('locate', { nodeId, ...(blockId ? { blockId } : {}) });
    observeItems();
  } catch (caught) {
    if (!isAbortError(caught)) {
      pinnedLocation = null;
      if (caught instanceof ApiClientError && caught.status === 409) {
        void refreshRevision(nodeId, blockId);
      } else transientStatus.value = formatError(caught, '章节定位失败');
    }
  } finally {
    requestControllers.delete(controller);
    if (requestId === rangeGeneration) rangeLoading.value = false;
  }
}

function setView(view: 'READ' | 'MINDMAP') {
  viewMode.value = view;
  emit('view', view);
}

function updateActiveHeading() {
  scrollFrame = 0;
  const element = viewport.value;
  if (!element) return;
  const containerTop = element.getBoundingClientRect().top;
  if (pinnedLocation) {
    const pinnedTarget = findPinnedMounted();
    const rect = pinnedTarget?.getBoundingClientRect();
    if (
      rect &&
      rect.bottom > containerTop + 1 &&
      rect.top < element.getBoundingClientRect().bottom - 1
    ) {
      activeNodeId.value = pinnedLocation.nodeId;
      return;
    }
    if (rangeLoading.value || renderBatchesPending > 0) return;
    pinnedLocation = null;
  }
  const headings = [...element.querySelectorAll<HTMLElement>('[data-heading-node]')];
  let active: HTMLElement | undefined;
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top <= containerTop + 92) active = heading;
    else break;
  }
  active ??= headings.find(
    (heading) => heading.getBoundingClientRect().bottom > containerTop,
  );
  const nodeId = active?.dataset.headingNode;
  if (nodeId && nodeId !== activeNodeId.value) {
    activeNodeId.value = nodeId;
    emit('locate', { nodeId });
  }
}

function onScroll() {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(updateActiveHeading);
  const element = viewport.value;
  if (!element) return;
  if (element.scrollTop <= topSpacer.value + 420) void loadEdge('BEFORE');
  const distanceFromBottom =
    element.scrollHeight - element.scrollTop - element.clientHeight;
  if (distanceFromBottom <= bottomSpacer.value + 680) void loadEdge('AFTER');
}

async function initialize(
  preferredNodeId = props.initialNodeId,
  preferredBlockId = props.initialBlockId,
) {
  const currentGeneration = ++generation;
  let initialTarget: KnowledgeReaderRangeItem | undefined;
  ++rangeGeneration;
  abortRequests();
  renderScheduleGeneration += 1;
  loading.value = true;
  error.value = '';
  transientStatus.value = '';
  manifest.value = null;
  outlineItems.value = [];
  outlineDone.value = false;
  rangeItems.value = [];
  readyBlocks.value = new Set();
  topSpacer.value = 0;
  bottomSpacer.value = 0;
  topEvicted.clear();
  bottomEvicted.clear();
  heightCache.clear();
  pinnedLocation = null;
  renderBatchesPending = 0;
  const controller = newController();
  try {
    await document.fonts?.ready.catch(() => undefined);
    const result = await api<KnowledgeReaderManifest>(
      `/knowledge/libraries/${encodeURIComponent(props.libraryId)}/reader`,
      { signal: controller.signal },
    );
    if (currentGeneration !== generation) return;
    manifest.value = result;
    void loadOutline(currentGeneration);
    if (!result.hasContent || !result.firstAnchor) {
      loading.value = false;
      return;
    }
    let anchor = preferredBlockId ?? preferredNodeId ?? result.firstAnchor;
    if (preferredNodeId || preferredBlockId) {
      const params = new URLSearchParams({ revision: result.readerRevision });
      if (preferredNodeId) params.set('nodeId', preferredNodeId);
      if (preferredBlockId) params.set('blockId', preferredBlockId);
      const context = await api<{
        anchor: string;
        nodeId: string;
        renderBlockId: string | null;
      }>(
        `/knowledge/libraries/${encodeURIComponent(props.libraryId)}/reader-context?${params.toString()}`,
        { signal: controller.signal },
      );
      anchor = context.renderBlockId ?? context.anchor;
      activeNodeId.value = context.nodeId;
      pinnedLocation = {
        nodeId: context.nodeId,
        ...(preferredBlockId && context.renderBlockId
          ? { blockId: context.renderBlockId }
          : {}),
      };
    }
    const response = await fetchRange(
      anchor,
      preferredNodeId || preferredBlockId ? 12 : 0,
      32,
      controller.signal,
    );
    if (currentGeneration !== generation) return;
    rangeItems.value = response.items;
    canLoadBefore.value = response.hasBefore;
    canLoadAfter.value = response.hasAfter;
    initialTarget = response.items.find(
      (item) => itemAnchor(item) === anchor,
    );
    activeNodeId.value ??= initialTarget?.nodeId ?? response.items[0]?.nodeId ?? null;
    pruneAndScheduleBlocks();
  } catch (caught) {
    if (currentGeneration === generation && !isAbortError(caught)) {
      error.value = formatError(caught, '知识库阅读器加载失败');
    }
  } finally {
    requestControllers.delete(controller);
    if (currentGeneration === generation) {
      loading.value = false;
      await nextTick();
      if (initialTarget && (preferredNodeId || preferredBlockId)) {
        await scrollToItem(initialTarget);
      }
      observeItems();
    }
  }
}

async function refreshRevision(nodeId = activeNodeId.value ?? undefined, blockId?: string) {
  transientStatus.value = '知识库已更新，正在恢复阅读位置';
  await initialize(nodeId, blockId);
}

function setupViewportResizeObserver() {
  viewportResizeObserver?.disconnect();
  const element = viewport.value;
  if (!element || typeof ResizeObserver === 'undefined') return;
  widthBucket = Math.round(element.clientWidth / 40);
  viewportResizeObserver = new ResizeObserver(() => {
    const nextBucket = Math.round(element.clientWidth / 40);
    if (nextBucket === widthBucket) return;
    const anchor = stableVisibleAnchor();
    widthBucket = nextBucket;
    requestAnimationFrame(() => {
      if (!anchor) return;
      const mounted = findMounted(anchor.sequenceKey);
      if (!mounted) return;
      const containerTop = element.getBoundingClientRect().top;
      const nextTop = mounted.getBoundingClientRect().top - containerTop;
      element.scrollTop += nextTop - anchor.top;
      recordCompensation(
        'WIDTH_BUCKET_CHANGED',
        anchor.sequenceKey,
        anchor.top,
        mounted.getBoundingClientRect().top - containerTop,
      );
      observeItems();
    });
  });
  viewportResizeObserver.observe(element);
}

watch(
  () => props.libraryId,
  () => void initialize(),
);
watch(
  () => props.initialView,
  (view) => {
    if (view) viewMode.value = view;
  },
);
watch(rangeItems, () => void nextTick(observeItems), { deep: false });
watch(viewport, setupViewportResizeObserver);

onMounted(() => {
  setupViewportResizeObserver();
  void initialize();
});

onBeforeUnmount(() => {
  generation += 1;
  abortRequests();
  itemResizeObserver?.disconnect();
  viewportResizeObserver?.disconnect();
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
});
</script>

<template>
  <section class="reader-shell" :class="{ 'outline-visible': outlineOpen }">
    <header class="reader-toolbar">
      <button type="button" class="icon-button" title="返回知识库目录" aria-label="返回知识库目录" @click="emit('back')">
        <ArrowLeft :size="18" aria-hidden="true" />
      </button>
      <strong class="reader-library-name">{{ manifest?.libraryName || '知识库' }}</strong>
      <div class="reader-view-switch" role="group" aria-label="查看方式">
        <button type="button" :class="{ active: viewMode === 'READ' }" @click="setView('READ')">
          <BookOpenText :size="16" aria-hidden="true" />
          阅读
        </button>
        <button type="button" :class="{ active: viewMode === 'MINDMAP' }" @click="setView('MINDMAP')">
          <Network :size="16" aria-hidden="true" />
          思维导图
        </button>
      </div>
      <button type="button" class="icon-button outline-button" :title="outlineOpen ? '收起大纲' : '打开大纲'" :aria-label="outlineOpen ? '收起大纲' : '打开大纲'" :aria-expanded="outlineOpen" @click="outlineOpen = !outlineOpen">
        <ListTree :size="18" aria-hidden="true" />
      </button>
    </header>

    <div v-if="loading" class="reader-initial-loading">
      <SkeletonBlock v-for="index in 5" :key="index" :lines="2" />
    </div>
    <ErrorState v-else-if="error" :message="error" @retry="initialize()" />
    <div v-else class="reader-workspace">
      <button v-if="outlineOpen" type="button" class="outline-backdrop" aria-label="关闭大纲" @click="outlineOpen = false" />
      <aside class="reader-outline-panel" :aria-hidden="!outlineOpen">
        <div class="outline-panel-header">
          <strong>大纲</strong>
          <button type="button" class="icon-button small" title="关闭大纲" aria-label="关闭大纲" @click="outlineOpen = false"><X :size="16" /></button>
        </div>
        <KnowledgeOutline :items="outlineItems" :active-node-id="activeNodeId" @select="locate($event)" />
        <div v-if="outlineLoading" class="outline-progress" role="status">
          已加载 {{ outlineItems.length }} / {{ outlineTotal || '…' }} 个标题
        </div>
      </aside>

      <div class="reader-main">
        <KnowledgeMindMap
          v-if="viewMode === 'MINDMAP' && manifest"
          :library-name="manifest.libraryName"
          :items="outlineItems"
          :complete="outlineDone"
          :progress="outlineProgress"
          @select="locate($event)"
        />
        <div
          v-else
          ref="viewport"
          class="reader-scroll"
          :aria-busy="rangeLoading || loadingBefore || loadingAfter"
          @scroll.passive="onScroll"
        >
          <div v-if="transientStatus" class="reader-status" role="status">{{ transientStatus }}</div>
          <div v-if="loadingBefore" class="edge-loading" role="status">正在加载前文</div>
          <div class="reader-spacer" :style="{ height: `${topSpacer}px` }" aria-hidden="true" />
          <template v-for="item in rangeItems" :key="item.sequenceKey">
            <section
              v-if="item.kind === 'HEADING'"
              class="reader-heading"
              :class="`level-${item.level}`"
              :data-reader-sequence="item.sequenceKey"
              :data-heading-node="item.nodeId"
              :data-node-id="item.nodeId"
            >
              <KnowledgeMarkdownHeading :tag="headingTag(item.level)" :markdown="item.titleMarkdown" :fallback="item.title" />
            </section>
            <section
              v-else
              class="reader-block"
              :data-reader-sequence="item.sequenceKey"
              :data-node-id="item.nodeId"
              :data-block-id="item.renderBlockId"
            >
              <MarkdownKnowledgeBlock v-if="readyBlocks.has(item.sequenceKey)" :item="item" />
              <div v-else class="block-render-placeholder" :style="{ minHeight: `${cachedHeight(item)}px` }" aria-label="正在排版正文" />
            </section>
          </template>
          <div class="reader-spacer" :style="{ height: `${bottomSpacer}px` }" aria-hidden="true" />
          <div v-if="loadingAfter" class="edge-loading" role="status">正在加载后文</div>
          <p v-if="manifest && !manifest.hasContent" class="reader-empty">该知识库暂无可阅读内容。</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.reader-shell {
  min-width: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: calc(100vh - var(--header-height));
  height: calc(100dvh - var(--header-height));
  min-height: 620px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.reader-toolbar {
  min-width: 0;
  min-height: 58px;
  display: grid;
  grid-template-columns: 40px minmax(120px, 1fr) auto 40px;
  align-items: center;
  gap: var(--space-3);
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.reader-library-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reader-view-switch {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-muted);
}

.reader-view-switch button {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.reader-view-switch button.active {
  background: var(--surface);
  color: var(--primary);
  box-shadow: var(--shadow-s);
}

.reader-workspace {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 0 minmax(0, 1fr);
  transition: grid-template-columns 0.18s var(--ease-out);
}

.reader-shell.outline-visible .reader-workspace {
  grid-template-columns: minmax(280px, 310px) minmax(0, 1fr);
}

.reader-outline-panel {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border-right: 1px solid var(--border);
  background: var(--surface);
  visibility: hidden;
}

.outline-visible .reader-outline-panel {
  visibility: visible;
}

.outline-panel-header {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px 6px 15px;
  border-bottom: 1px solid var(--border);
}

.outline-progress {
  padding: 9px 12px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}

.reader-main,
.reader-scroll {
  min-width: 0;
  min-height: 0;
}

.reader-scroll {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  overflow-anchor: none;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 0 max(24px, calc((100% - 760px) / 2));
}

.reader-heading,
.reader-block {
  width: min(100%, 760px);
  margin-inline: auto;
  box-sizing: border-box;
}

.reader-heading {
  padding: 28px 0 12px;
  color: var(--primary-dark);
}

.reader-heading.level-2 {
  padding-top: 44px;
  font-size: 28px;
  line-height: 1.35;
}

.reader-heading.level-3 {
  padding-top: 34px;
  font-size: 23px;
  line-height: 1.4;
}

.reader-heading.level-4 {
  font-size: 19px;
  line-height: 1.45;
}

.reader-heading.level-5,
.reader-heading.level-6 {
  font-size: 17px;
  line-height: 1.5;
}

.reader-block {
  padding: 6px 0 12px;
}

.block-render-placeholder {
  border-radius: var(--radius-s);
  background: linear-gradient(90deg, var(--surface-muted), var(--surface), var(--surface-muted));
  background-size: 220% 100%;
  animation: reader-placeholder 1.4s ease-in-out infinite;
}

.reader-status {
  position: sticky;
  z-index: 2;
  top: 8px;
  width: fit-content;
  max-width: calc(100% - 24px);
  margin: 8px auto;
  padding: 7px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface);
  color: var(--ink-soft);
  font-size: 13px;
  box-shadow: var(--shadow-s);
}

.edge-loading,
.reader-empty {
  padding: 14px;
  color: var(--muted);
  text-align: center;
}

.reader-initial-loading {
  padding: var(--space-8);
}

.outline-backdrop {
  display: none;
}

@keyframes reader-placeholder {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}

@media (max-width: 900px) {
  .reader-shell {
    min-height: 600px;
  }

  .reader-workspace,
  .reader-shell.outline-visible .reader-workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .reader-outline-panel {
    position: absolute;
    z-index: 5;
    inset: 0 auto 0 0;
    width: min(340px, 88vw);
    border-right: 1px solid var(--border-strong);
    box-shadow: var(--shadow-m);
    transform: translateX(-102%);
    transition: transform 0.18s var(--ease-out);
    visibility: visible;
  }

  .outline-visible .reader-outline-panel {
    transform: translateX(0);
  }

  .outline-backdrop {
    position: absolute;
    z-index: 4;
    inset: 0;
    display: block;
    border: 0;
    background: rgba(18, 27, 44, 0.28);
  }
}

@media (max-width: 560px) {
  .reader-shell {
    min-height: 540px;
  }

  .reader-toolbar {
    min-height: 94px;
    grid-template-columns: 40px minmax(0, 1fr) 40px;
    grid-template-areas:
      'back name outline'
      'switch switch switch';
  }

  .reader-toolbar > :first-child { grid-area: back; }
  .reader-library-name { grid-area: name; text-align: center; }
  .reader-view-switch { grid-area: switch; justify-self: center; }
  .outline-button { grid-area: outline; }

  .reader-scroll {
    padding-inline: 18px;
  }

  .reader-heading.level-2 {
    font-size: 25px;
  }

  .reader-heading.level-3 {
    font-size: 21px;
  }

  .reader-outline-panel {
    width: 100%;
  }
}
</style>
