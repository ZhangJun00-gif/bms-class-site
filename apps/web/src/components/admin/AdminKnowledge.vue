<script setup lang="ts">
import KnowledgeLibraryManager from '../knowledge/KnowledgeLibraryManager.vue';

withDefaults(defineProps<{ active?: boolean }>(), { active: true });
</script>

<template>
  <section aria-label="共享知识库">
    <KnowledgeLibraryManager scope="SHARED" :active="active" />
  </section>
</template>
