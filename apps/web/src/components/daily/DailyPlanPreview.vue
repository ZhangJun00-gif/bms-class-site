<script setup lang="ts">
import StatusBadge from '../common/StatusBadge.vue';
import QuizQuestionImages from '../quiz/QuizQuestionImages.vue';
import type { DailyPracticePlanItem } from '../../types';

defineProps<{
  personalizedItems: DailyPracticePlanItem[];
  fixedItems: DailyPracticePlanItem[];
}>();
</script>

<template>
  <section class="daily-plan" aria-labelledby="daily-plan-title">
    <header class="plan-heading">
      <div>
        <p class="section-kicker">今日计划</p>
        <h2 id="daily-plan-title">练习题目</h2>
      </div>
      <strong class="question-total">
        个性化 {{ personalizedItems.length }} 题 + 固定 {{ fixedItems.length }} 题 = 今日共
        {{ personalizedItems.length + fixedItems.length }} 题
      </strong>
    </header>

    <section v-if="personalizedItems.length" class="plan-section" aria-labelledby="personalized-title">
      <h3 id="personalized-title">个性化练习</h3>
      <ol class="question-list">
        <li v-for="item in personalizedItems" :key="item.questionId">
          <article>
            <div class="question-tags">
              <StatusBadge :text="item.typeLabel" tone="accent" />
              <StatusBadge :text="item.subject" tone="muted" />
              <StatusBadge
                v-for="chapter in item.chapters"
                :key="chapter.id"
                :text="chapter.name"
              />
            </div>
            <p class="question-prompt">{{ item.prompt }}</p>
            <QuizQuestionImages
              v-if="item.images.length"
              :images="item.images"
              :alt-context="item.prompt"
            />
            <p class="question-reason">{{ item.reason }}</p>
          </article>
        </li>
      </ol>
    </section>

    <section v-if="fixedItems.length" class="plan-section fixed-section" aria-labelledby="fixed-title">
      <h3 id="fixed-title">管理员指定</h3>
      <ol
        class="question-list"
        :start="personalizedItems.length + 1"
        :style="{ counterReset: `daily-question ${personalizedItems.length}` }"
      >
        <li v-for="item in fixedItems" :key="item.questionId">
          <article>
            <div class="question-tags">
              <StatusBadge text="管理员指定" tone="warning" />
              <StatusBadge :text="item.typeLabel" tone="accent" />
              <StatusBadge :text="item.subject" tone="muted" />
              <StatusBadge
                v-for="chapter in item.chapters"
                :key="chapter.id"
                :text="chapter.name"
              />
            </div>
            <p class="question-prompt">{{ item.prompt }}</p>
            <QuizQuestionImages
              v-if="item.images.length"
              :images="item.images"
              :alt-context="item.prompt"
            />
          </article>
        </li>
      </ol>
    </section>
  </section>
</template>

<style scoped>
.daily-plan {
  display: grid;
  gap: var(--space-6);
}

.plan-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.plan-heading h2,
.section-kicker,
.plan-section h3,
.question-prompt,
.question-reason {
  margin: 0;
}

.plan-heading h2 {
  margin-top: 3px;
  font-size: 22px;
}

.section-kicker {
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
}

.question-total {
  color: var(--ink-soft);
  font-size: 13px;
  text-align: right;
}

.plan-section {
  display: grid;
  gap: var(--space-3);
}

.plan-section h3 {
  font-size: 16px;
}

.fixed-section {
  padding-top: var(--space-5);
  border-top: 1px solid var(--border);
}

.question-list {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: daily-question;
}

.question-list li {
  counter-increment: daily-question;
  min-width: 0;
  padding: var(--space-4) 0 var(--space-4) 42px;
  border-bottom: 1px solid var(--border);
}

.question-list li::before {
  content: counter(daily-question, decimal-leading-zero);
  float: left;
  margin-left: -42px;
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
}

.question-list article {
  min-width: 0;
  display: grid;
  gap: var(--space-2);
}

.question-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.question-prompt {
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.question-reason {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.65;
}

@media (max-width: 560px) {
  .plan-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .question-total {
    text-align: left;
  }

  .question-list li {
    padding-left: 34px;
  }

  .question-list li::before {
    margin-left: -34px;
  }
}
</style>
