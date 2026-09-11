<script setup lang="ts">
import { computed } from 'vue';
import { renderKnowledgeHeading } from '../../lib/knowledgeMarkdown';

const props = withDefaults(
  defineProps<{
    markdown: string;
    fallback: string;
    tag?: 'span' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  }>(),
  { tag: 'span' },
);

const html = computed(() =>
  renderKnowledgeHeading(props.markdown, props.fallback),
);
</script>

<template>
  <component
    :is="tag"
    class="knowledge-markdown-heading"
    :aria-label="fallback"
    v-html="html"
  />
</template>

<style scoped>
.knowledge-markdown-heading {
  margin: 0;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}
</style>
