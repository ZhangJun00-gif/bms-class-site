<script setup lang="ts">
type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'muted' | '';

withDefaults(defineProps<{ text: string; tone?: Tone }>(), { tone: '' });
</script>

<template>
  <span class="badge" :class="tone || undefined">{{ text }}</span>
</template>
