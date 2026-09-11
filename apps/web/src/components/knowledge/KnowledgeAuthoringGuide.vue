<script setup lang="ts">
import { ref } from 'vue';
import {
  knowledgeAuthoringGuideMarkdown,
} from '../../lib/knowledgeAuthoringGuide';
import { renderKnowledgeBlock } from '../../lib/knowledgeMarkdown';
import 'katex/dist/katex.min.css';

interface GuideSection {
  id: string;
  level: 2 | 3;
  title: string;
}

const article = ref<HTMLElement>();
const selectedSection = ref('');
const rendered = renderGuide(knowledgeAuthoringGuideMarkdown);

function renderGuide(markdown: string) {
  const template = document.createElement('template');
  template.innerHTML = renderKnowledgeBlock(markdown, []);
  const sections: GuideSection[] = [
    ...template.content.querySelectorAll<HTMLHeadingElement>('h2, h3'),
  ].map((heading, index) => {
    const id = `authoring-guide-section-${index + 1}`;
    heading.id = id;
    return {
      id,
      level: Number(heading.tagName.slice(1)) as 2 | 3,
      title: heading.textContent?.trim() || `第 ${index + 1} 节`,
    };
  });
  return { html: template.innerHTML, sections };
}

function jumpTo(id: string) {
  if (!id) return;
  selectedSection.value = id;
  article.value
    ?.querySelector<HTMLElement>(`[id="${id}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function selectSection(event: Event) {
  jumpTo((event.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="authoring-guide-layout">
    <nav class="authoring-guide-outline" aria-label="说明文档大纲">
      <strong>文档大纲</strong>
      <button
        v-for="section in rendered.sections"
        :key="section.id"
        type="button"
        :class="[`level-${section.level}`, { active: selectedSection === section.id }]"
        @click="jumpTo(section.id)"
      >
        {{ section.title }}
      </button>
    </nav>

    <label class="authoring-guide-picker">
      <span>跳转章节</span>
      <select :value="selectedSection" @change="selectSection">
        <option value="">选择章节</option>
        <option
          v-for="section in rendered.sections"
          :key="section.id"
          :value="section.id"
        >
          {{ section.level === 3 ? `　${section.title}` : section.title }}
        </option>
      </select>
    </label>

    <article
      ref="article"
      class="authoring-guide-document"
      v-html="rendered.html"
    />
  </div>
</template>

<style>
.authoring-guide-layout {
  min-width: 0;
  display: grid;
  grid-template-columns: 230px minmax(0, 760px);
  justify-content: center;
  gap: 28px;
}

.authoring-guide-outline {
  position: sticky;
  top: 0;
  align-self: start;
  max-height: calc(100dvh - 150px);
  display: grid;
  align-content: start;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  padding-right: 14px;
}

.authoring-guide-outline strong {
  padding: 6px 8px 10px;
  color: var(--primary-dark);
  font-size: 13px;
}

.authoring-guide-outline button {
  min-width: 0;
  border: 0;
  border-left: 2px solid transparent;
  padding: 6px 8px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}

.authoring-guide-outline button.level-3 {
  padding-left: 20px;
  font-size: 12px;
}

.authoring-guide-outline button:hover,
.authoring-guide-outline button.active {
  border-left-color: var(--accent);
  background: var(--surface-muted);
  color: var(--primary-dark);
}

.authoring-guide-picker {
  display: none;
}

.authoring-guide-document {
  min-width: 0;
  color: var(--ink);
  font-size: 15px;
  line-height: 1.78;
  overflow-wrap: anywhere;
}

.authoring-guide-document h1 {
  margin: 0 0 8px;
  font-size: 28px;
}

.authoring-guide-document h2 {
  margin: 42px 0 14px;
  padding-top: 4px;
  border-top: 1px solid var(--border-soft);
  font-size: 22px;
  scroll-margin-top: 18px;
}

.authoring-guide-document h3 {
  margin: 30px 0 10px;
  font-size: 18px;
  scroll-margin-top: 18px;
}

.authoring-guide-document p,
.authoring-guide-document ul,
.authoring-guide-document ol,
.authoring-guide-document blockquote,
.authoring-guide-document pre,
.authoring-guide-document table {
  margin-top: 0;
  margin-bottom: 1em;
}

.authoring-guide-document pre,
.authoring-guide-document table,
.authoring-guide-document .katex-display {
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
}

.authoring-guide-document pre {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-muted);
}

.authoring-guide-document code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.authoring-guide-document :not(pre) > code {
  padding: 0.12em 0.34em;
  border-radius: 4px;
  background: var(--surface-muted);
}

.authoring-guide-document table {
  display: block;
  width: max-content;
  min-width: min(100%, 520px);
  border-collapse: collapse;
}

.authoring-guide-document th,
.authoring-guide-document td {
  padding: 8px 11px;
  border: 1px solid var(--border);
  white-space: normal;
  vertical-align: top;
}

.authoring-guide-document blockquote {
  margin-left: 0;
  padding-left: 16px;
  border-left: 3px solid var(--accent);
  color: var(--ink-soft);
}

@media (max-width: 800px) {
  .authoring-guide-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }

  .authoring-guide-outline {
    display: none;
  }

  .authoring-guide-picker {
    position: sticky;
    z-index: 2;
    top: 0;
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    background: var(--surface);
    color: var(--ink-soft);
    font-size: 13px;
    font-weight: 600;
  }

  .authoring-guide-picker select {
    width: 100%;
    min-width: 0;
    min-height: 40px;
  }
}

@media (max-width: 560px) {
  .authoring-guide-document {
    font-size: 14px;
  }

  .authoring-guide-document h1 {
    font-size: 24px;
  }

  .authoring-guide-document h2 {
    font-size: 20px;
  }

  .authoring-guide-document h3 {
    font-size: 17px;
  }
}
</style>
