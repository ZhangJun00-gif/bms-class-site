<script setup lang="ts">
withDefaults(defineProps<{ lines?: number; height?: number }>(), { lines: 3, height: 14 });
</script>

<template>
  <div class="skeleton-block" aria-hidden="true">
    <div
      v-for="line in lines"
      :key="line"
      class="skeleton-line"
      :style="{ height: `${height}px`, width: line === lines ? '58%' : '100%' }"
    />
  </div>
</template>

<style scoped>
.skeleton-block {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-5) 0;
}

.skeleton-line {
  border-radius: var(--radius-s);
  background: linear-gradient(90deg, var(--surface-muted) 25%, #f5f8fc 50%, var(--surface-muted) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
}

@keyframes skeleton-shimmer {
  0% {
    background-position: 180% 0;
  }

  100% {
    background-position: -20% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton-line {
    animation: none;
  }
}
</style>
