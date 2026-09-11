<script setup lang="ts">
import { computed } from 'vue';
import type { KnowledgeReaderBlockItem } from '../../types';
import { renderKnowledgeBlock } from '../../lib/knowledgeMarkdown';
import 'katex/dist/katex.min.css';

const props = defineProps<{ item: KnowledgeReaderBlockItem }>();
const html = computed(() =>
  renderKnowledgeBlock(props.item.markdown, props.item.images),
);
</script>

<template>
  <div class="knowledge-markdown-block" v-html="html" />
</template>

<style>
.knowledge-markdown-block {
  min-width: 0;
  color: var(--ink);
  font-size: 16px;
  line-height: 1.82;
  overflow-wrap: anywhere;
}

.knowledge-markdown-block > :first-child {
  margin-top: 0;
}

.knowledge-markdown-block > :last-child {
  margin-bottom: 0;
}

.knowledge-markdown-block p,
.knowledge-markdown-block ul,
.knowledge-markdown-block ol,
.knowledge-markdown-block blockquote,
.knowledge-markdown-block pre,
.knowledge-markdown-block table,
.knowledge-markdown-block .katex-display {
  margin: 0 0 1.15em;
}

.knowledge-markdown-block pre,
.knowledge-markdown-block table,
.knowledge-markdown-block .katex-display {
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
}

.knowledge-markdown-block pre {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-muted);
}

.knowledge-markdown-block code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.knowledge-markdown-block :not(pre) > code {
  padding: 0.12em 0.34em;
  border-radius: 4px;
  background: var(--surface-muted);
}

.knowledge-markdown-block table {
  width: max-content;
  min-width: min(100%, 520px);
  border-collapse: collapse;
}

.knowledge-markdown-block th,
.knowledge-markdown-block td {
  padding: 8px 11px;
  border: 1px solid var(--border);
  text-align: left;
}

.knowledge-markdown-block blockquote {
  padding-left: 16px;
  border-left: 3px solid var(--accent);
  color: var(--ink-soft);
}

.knowledge-markdown-block img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 18px auto;
  border-radius: var(--radius-s);
}

.knowledge-markdown-block .knowledge-image-unavailable {
  display: inline-block;
  padding: 6px 10px;
  border: 1px dashed var(--border-strong);
  color: var(--muted);
}

.knowledge-markdown-block .katex-display > .katex {
  text-align: left;
}
</style>
