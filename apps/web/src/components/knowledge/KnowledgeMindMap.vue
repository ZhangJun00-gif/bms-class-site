<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Maximize2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-vue-next';
import { Markmap } from 'markmap-view';
import { renderKnowledgeHeading } from '../../lib/knowledgeMarkdown';
import type { KnowledgeReaderOutlineItem } from '../../types';

interface MindMapNode {
  content: string;
  payload?: { nodeId?: string; title?: string; fold?: number };
  children: MindMapNode[];
}

const props = defineProps<{
  libraryName: string;
  items: KnowledgeReaderOutlineItem[];
  complete: boolean;
  progress: number;
}>();
const emit = defineEmits<{ select: [nodeId: string] }>();

const svg = ref<SVGElement>();
const error = ref('');
let markmap: Markmap | null = null;
let expandedMode: 'INITIAL' | 'ALL' | 'COLLAPSED' = 'INITIAL';

function escapeHtml(value: string) {
  const element = document.createElement('span');
  element.textContent = value;
  return element.innerHTML;
}

function tree(mode = expandedMode): MindMapNode {
  const nodeById = new Map<string, MindMapNode>();
  const root: MindMapNode = {
    content: escapeHtml(props.libraryName),
    payload: { title: props.libraryName },
    children: [],
  };
  for (const item of props.items) {
    nodeById.set(item.nodeId, {
      content: renderKnowledgeHeading(item.titleMarkdown, item.title),
      payload: { nodeId: item.nodeId, title: item.title },
      children: [],
    });
  }
  for (const item of props.items) {
    const node = nodeById.get(item.nodeId)!;
    const parent = item.parentId ? nodeById.get(item.parentId) : root;
    (parent ?? root).children.push(node);
  }
  const applyFold = (node: MindMapNode, depth: number) => {
    if (node.children.length) {
      if (mode === 'COLLAPSED' && depth >= 1) node.payload!.fold = 2;
      else if (mode === 'INITIAL' && depth >= 1) node.payload!.fold = 1;
      else node.payload!.fold = 0;
    }
    for (const child of node.children) applyFold(child, depth + 1);
  };
  applyFold(root, 0);
  return root;
}

function nodeDatum(node: SVGGElement | null | undefined) {
  return (node as unknown as { __data__?: MindMapNode } | null | undefined)
    ?.__data__;
}

function enhanceNodes() {
  const element = svg.value;
  if (!element) return;
  for (const node of element.querySelectorAll<SVGGElement>('g.markmap-node')) {
    const datum = nodeDatum(node);
    const title = datum?.payload?.title;
    const nodeId = datum?.payload?.nodeId;
    node.setAttribute('tabindex', nodeId ? '0' : '-1');
    if (title) node.setAttribute('aria-label', title);
  }
}

async function render() {
  if (!props.complete || !svg.value) return;
  error.value = '';
  try {
    if (!markmap) {
      markmap = Markmap.create(svg.value, {
        autoFit: true,
        duration: 220,
        embedGlobalCSS: true,
        fitRatio: 0.92,
        initialExpandLevel: -1,
        maxInitialScale: 1.2,
        maxWidth: 280,
        nodeMinHeight: 24,
        paddingX: 12,
        spacingHorizontal: 92,
        spacingVertical: 14,
        color: (node) =>
          ['#176d73', '#344e8a', '#9a5a34', '#7a446b'][
            node.state.depth % 4
          ]!,
      });
    }
    await markmap.setData(tree());
    await markmap.fit();
    await nextTick();
    enhanceNodes();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '思维导图加载失败';
  }
}

async function setMode(mode: typeof expandedMode) {
  expandedMode = mode;
  await render();
}

function zoom(scale: number) {
  void markmap?.rescale(scale);
}

function fit() {
  void markmap?.fit();
}

function onClick(event: MouseEvent) {
  const target = event.target as Element | null;
  if (!target?.closest('foreignObject')) return;
  const group = target.closest<SVGGElement>('g.markmap-node');
  const datum = nodeDatum(group);
  const nodeId = datum?.payload?.nodeId;
  if (nodeId) emit('select', nodeId);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const group = (event.target as Element | null)?.closest<SVGGElement>(
    'g.markmap-node',
  );
  const datum = nodeDatum(group);
  const nodeId = datum?.payload?.nodeId;
  if (nodeId) {
    event.preventDefault();
    emit('select', nodeId);
  }
}

watch(
  () => [props.items, props.complete, props.libraryName],
  () => void render(),
  { deep: true },
);

onMounted(() => void render());
onBeforeUnmount(() => {
  markmap?.destroy();
  markmap = null;
});
</script>

<template>
  <section class="mindmap-workspace" aria-label="知识库思维导图">
    <div class="mindmap-controls" aria-label="思维导图控制">
      <button type="button" class="icon-button" title="放大" aria-label="放大" @click="zoom(1.2)"><ZoomIn :size="17" /></button>
      <button type="button" class="icon-button" title="缩小" aria-label="缩小" @click="zoom(0.8)"><ZoomOut :size="17" /></button>
      <button type="button" class="icon-button" title="适配画布" aria-label="适配画布" @click="fit"><Maximize2 :size="17" /></button>
      <button type="button" class="icon-button" title="重置" aria-label="重置" @click="setMode('INITIAL')"><RotateCcw :size="17" /></button>
      <button type="button" class="icon-button" title="全部展开" aria-label="全部展开" @click="setMode('ALL')"><ChevronsUpDown :size="17" /></button>
      <button type="button" class="icon-button" title="收起到章节" aria-label="收起到章节" @click="setMode('COLLAPSED')"><ChevronsDownUp :size="17" /></button>
    </div>
    <div v-if="!complete" class="mindmap-status" role="status">
      正在加载完整标题树 {{ Math.round(progress * 100) }}%
    </div>
    <div v-else-if="error" class="mindmap-status error" role="alert">{{ error }}</div>
    <svg
      v-show="complete && !error"
      ref="svg"
      class="mindmap-canvas"
      @click="onClick"
      @keydown="onKeydown"
    />
  </section>
</template>

<style scoped>
.mindmap-workspace {
  position: relative;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  background: var(--surface);
}

.mindmap-controls {
  position: absolute;
  z-index: 2;
  top: 12px;
  right: 12px;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.mindmap-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.mindmap-status {
  height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
  color: var(--muted);
}

.mindmap-status.error {
  color: var(--danger);
}

@media (max-width: 560px) {
  .mindmap-controls {
    top: 8px;
    right: 8px;
    left: 8px;
  }
}
</style>
