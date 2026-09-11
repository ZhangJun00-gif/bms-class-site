<script setup lang="ts">
import { ShieldCheck, Target } from 'lucide-vue-next';
import StatusBadge from '../common/StatusBadge.vue';
import { dailyPracticeGenerationLabels } from '../../lib/labels';
import type {
  DailyPracticeGenerationSource,
  DailyPracticeLearningSummary,
} from '../../types';

defineProps<{
  summary: DailyPracticeLearningSummary;
  generationSource: DailyPracticeGenerationSource;
}>();
</script>

<template>
  <section class="learning-summary" aria-labelledby="daily-summary-title">
    <header class="section-heading">
      <div>
        <p class="section-kicker">学习状态</p>
        <h2 id="daily-summary-title">{{ summary.headline }}</h2>
      </div>
      <StatusBadge
        :text="dailyPracticeGenerationLabels[generationSource]"
        :tone="generationSource === 'PRO_MAX' ? 'accent' : 'warning'"
      />
    </header>
    <p class="summary-overview">{{ summary.overview }}</p>
    <div class="summary-columns">
      <section aria-labelledby="daily-strengths-title">
        <h3 id="daily-strengths-title">
          <ShieldCheck :size="17" aria-hidden="true" />
          掌握较稳
        </h3>
        <ul v-if="summary.strengths.length">
          <li v-for="entry in summary.strengths" :key="`${entry.knowledgeAlias}-${entry.text}`">
            {{ entry.text }}
          </li>
        </ul>
        <p v-else class="empty-copy">当前记录还不足以确认稳定优势。</p>
      </section>
      <section aria-labelledby="daily-priorities-title">
        <h3 id="daily-priorities-title">
          <Target :size="17" aria-hidden="true" />
          优先复习
        </h3>
        <ul v-if="summary.priorities.length">
          <li v-for="entry in summary.priorities" :key="`${entry.knowledgeAlias}-${entry.text}`">
            {{ entry.text }}
          </li>
        </ul>
        <p v-else class="empty-copy">暂时没有明确的优先复习项。</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.learning-summary {
  display: grid;
  gap: var(--space-5);
  padding-block: var(--space-6);
  border-block: 1px solid var(--border);
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.section-heading h2,
.section-kicker,
.summary-overview,
.summary-columns h3,
.empty-copy {
  margin: 0;
}

.section-heading h2 {
  margin-top: 3px;
  font-size: 22px;
  line-height: 1.45;
}

.section-kicker {
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
}

.summary-overview {
  max-width: var(--measure);
  color: var(--ink-soft);
  line-height: 1.8;
}

.summary-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-8);
}

.summary-columns section {
  min-width: 0;
}

.summary-columns h3 {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 15px;
}

.summary-columns h3 svg {
  color: var(--accent-dark);
}

.summary-columns ul {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  padding-left: 20px;
  color: var(--ink-soft);
  line-height: 1.7;
}

.summary-columns li,
.empty-copy {
  overflow-wrap: anywhere;
}

.empty-copy {
  margin-top: var(--space-3);
  color: var(--muted);
  font-size: 13px;
}

@media (max-width: 700px) {
  .summary-columns {
    grid-template-columns: 1fr;
    gap: var(--space-5);
  }
}

@media (max-width: 560px) {
  .section-heading {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
