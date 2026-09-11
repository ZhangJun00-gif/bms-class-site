<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <header class="page-header">
    <nav v-if="$slots.breadcrumb" class="breadcrumb" aria-label="面包屑">
      <slot name="breadcrumb" />
    </nav>
    <div class="page-header-row">
      <div class="page-header-text">
        <h1>{{ title }}</h1>
        <p v-if="description">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="page-header-actions">
        <slot name="actions" />
      </div>
    </div>
  </header>
</template>

<style scoped>
.page-header {
  position: relative;
  border-bottom: 1px solid var(--border);
  background:
    radial-gradient(ellipse 60% 120% at 92% 0%, rgba(15, 138, 150, 0.07), transparent 65%),
    var(--surface);
  padding: var(--space-10) max(24px, 7vw) var(--space-8);
  overflow: hidden;
}

/* 左侧竖向渐变条，期刊栏目标记 */
.page-header::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: linear-gradient(180deg, var(--accent-vivid), var(--primary));
}

.breadcrumb {
  margin-bottom: var(--space-3);
  color: var(--muted);
  font-size: 13px;
}

.breadcrumb :deep(a) {
  color: var(--muted);
  text-decoration: none;
}

.breadcrumb :deep(a:hover) {
  color: var(--accent-dark);
}

.page-header-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-5);
  flex-wrap: wrap;
}

.page-header-text h1 {
  margin: 0 0 var(--space-2);
  font-size: 32px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.page-header-text p {
  margin: 0;
  max-width: var(--measure);
  color: var(--muted);
  line-height: 1.8;
}

.page-header-actions {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}

@media (max-width: 560px) {
  .page-header {
    padding: var(--space-8) 18px var(--space-6);
  }

  .page-header-text h1 {
    font-size: 25px;
  }
}
</style>
