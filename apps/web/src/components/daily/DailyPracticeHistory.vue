<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { CheckCircle2, ChevronDown, XCircle } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import PaginationControl from '../common/PaginationControl.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { getDailyHistory, getDailyHistoryDetail } from '../../lib/dailyPractice';
import { formatError } from '../../lib/api';
import { formatDateTime } from '../../lib/formatters';
import {
  dailyPracticeGenerationLabels,
  dailyPracticeStatusLabels,
  dailyPracticeStatusTones,
} from '../../lib/labels';
import type { DailyPracticeHistoryDetail, DailyPracticeHistoryItem } from '../../types';

const items = ref<DailyPracticeHistoryItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 5;
const loaded = ref(false);
const error = ref('');
const expandedId = ref('');
const details = ref<Record<string, DailyPracticeHistoryDetail>>({});
const detailLoadingId = ref('');
const detailErrors = ref<Record<string, string>>({});
const listRequests = useLatestRequest();
const detailRequests = useLatestRequest();
const loading = listRequests.loading;
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const expandedDetail = computed(() =>
  expandedId.value ? details.value[expandedId.value] : undefined,
);

async function load(nextPage = page.value, navigate = false) {
  error.value = '';
  const task = async ({ signal }: { signal: AbortSignal }) => {
    const result = await getDailyHistory(nextPage, pageSize, { signal });
    const correctedPage = Math.max(1, Math.ceil(result.total / pageSize));
    if (result.total > 0 && !result.items.length && nextPage > correctedPage) {
      return getDailyHistory(correctedPage, pageSize, { signal });
    }
    return result;
  };
  const callbacks = {
    commit(result: Awaited<ReturnType<typeof getDailyHistory>>) {
      items.value = result.items;
      total.value = result.total;
      page.value = result.page;
      loaded.value = true;
    },
    onError(caught: unknown) {
      error.value = formatError(caught, '历史练习加载失败');
    },
  };
  if (navigate) await listRequests.runPage(page, nextPage, task, callbacks);
  else await listRequests.runLatest(task, callbacks);
}

async function loadDetail(planRevisionId: string) {
  detailLoadingId.value = planRevisionId;
  detailErrors.value = Object.fromEntries(
    Object.entries(detailErrors.value).filter(([key]) => key !== planRevisionId),
  );
  await detailRequests.runLatest(
    ({ signal }) => getDailyHistoryDetail(planRevisionId, { signal }),
    {
      commit(result) {
        if (expandedId.value === planRevisionId) {
          details.value[planRevisionId] = result;
        }
      },
      onError(caught) {
        if (expandedId.value === planRevisionId) {
          detailErrors.value[planRevisionId] = formatError(
            caught,
            '练习详情加载失败',
          );
        }
      },
      onFinally() {
        if (detailLoadingId.value === planRevisionId) detailLoadingId.value = '';
      },
    },
  );
}

function toggleDetail(item: DailyPracticeHistoryItem) {
  if (expandedId.value === item.planRevisionId) {
    expandedId.value = '';
    detailRequests.cancelLatest();
    detailLoadingId.value = '';
    return;
  }
  detailRequests.cancelLatest();
  detailLoadingId.value = '';
  expandedId.value = item.planRevisionId;
  if (!details.value[item.planRevisionId] && detailLoadingId.value !== item.planRevisionId) {
    void loadDetail(item.planRevisionId);
  }
}

function orderedItems(detail: DailyPracticeHistoryDetail) {
  return [...detail.personalizedItems, ...detail.fixedItems].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
}

function resultFor(detail: DailyPracticeHistoryDetail, questionId: string) {
  return detail.resultSummary.find((entry) => entry.questionId === questionId) ?? null;
}

onMounted(() => void load());
</script>

<template>
  <section class="history-section" aria-labelledby="daily-history-title">
    <header>
      <p class="section-kicker">History</p>
      <h2 id="daily-history-title">练习历史</h2>
    </header>
    <p v-if="error && loaded" class="alert error" role="alert">{{ error }}</p>
    <SkeletonBlock v-if="loading && !loaded" :lines="4" />
    <ErrorState v-else-if="error && !loaded" :message="error" @retry="load()" />
    <EmptyState
      v-else-if="loaded && !items.length"
      title="暂无每日练习记录"
      hint="完成每日一练后会显示在这里"
    />
    <template v-else>
      <ol class="history-list">
        <li v-for="item in items" :key="item.planRevisionId">
          <div class="history-main">
            <strong>{{ item.practiceDate }}</strong>
            <div class="history-badges">
              <StatusBadge
                :text="dailyPracticeStatusLabels[item.status]"
                :tone="dailyPracticeStatusTones[item.status] as ''"
              />
              <StatusBadge :text="dailyPracticeGenerationLabels[item.generationSource]" tone="muted" />
            </div>
          </div>
          <p>
            个性化 {{ item.questionCount }} 题 · 固定 {{ item.fixedQuestionCount }} 题
            <template v-if="item.attempt?.submittedAt">
              · 得分 {{ item.attempt.score }} / {{ item.attempt.total }}
            </template>
          </p>
          <time :datetime="item.attempt?.submittedAt ?? item.generatedAt">
            {{ formatDateTime(item.attempt?.submittedAt ?? item.generatedAt) }}
          </time>
          <button
            type="button"
            class="history-detail-toggle"
            :aria-expanded="expandedId === item.planRevisionId"
            @click="toggleDetail(item)"
          >
            <ChevronDown :size="15" :class="{ open: expandedId === item.planRevisionId }" />详情
          </button>
          <div v-if="expandedId === item.planRevisionId" class="history-detail">
            <p v-if="detailLoadingId === item.planRevisionId" class="detail-hint" role="status">
              正在加载详情…
            </p>
            <div v-else-if="detailErrors[item.planRevisionId]" class="detail-error" role="alert">
              <p>{{ detailErrors[item.planRevisionId] }}</p>
              <button type="button" class="button ghost" @click="loadDetail(item.planRevisionId)">
                重试
              </button>
            </div>
            <template v-else-if="expandedDetail">
              <p v-if="expandedDetail.summary?.headline" class="detail-headline">
                {{ expandedDetail.summary.headline }}
              </p>
              <ol class="detail-items">
                <li v-for="entry in orderedItems(expandedDetail)" :key="entry.questionId">
                  <div class="detail-item-head">
                    <span class="detail-ordinal">{{ entry.ordinal }}</span>
                    <StatusBadge :text="entry.typeLabel" tone="accent" />
                    <StatusBadge
                      v-if="entry.source === 'ADMIN_FIXED'"
                      text="管理员指定"
                      tone="warning"
                    />
                    <StatusBadge :text="entry.subject" tone="muted" />
                    <span
                      v-if="resultFor(expandedDetail, entry.questionId)"
                      class="detail-result"
                      :data-correct="resultFor(expandedDetail, entry.questionId)?.correct"
                    >
                      <template v-if="resultFor(expandedDetail, entry.questionId)?.correct">
                        <CheckCircle2 :size="13" />答对
                      </template>
                      <template v-else>
                        <XCircle :size="13" />答错
                      </template>
                      ·
                      {{ resultFor(expandedDetail, entry.questionId)?.score }}/{{
                        resultFor(expandedDetail, entry.questionId)?.maxScore
                      }}
                    </span>
                  </div>
                  <p class="detail-prompt">{{ entry.prompt }}</p>
                  <p v-if="entry.reason" class="detail-reason">{{ entry.reason }}</p>
                </li>
              </ol>
            </template>
          </div>
        </li>
      </ol>
      <PaginationControl
        :page="page"
        :page-count="pageCount"
        @update:page="load($event, true)"
      />
    </template>
  </section>
</template>

<style scoped>
.history-section {
  display: grid;
  gap: var(--space-5);
}

.history-section h2,
.section-kicker,
.history-list,
.history-list p {
  margin: 0;
}

.history-section h2 {
  margin-top: 3px;
  font-size: 22px;
}

.section-kicker {
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
  text-transform: uppercase;
}

.history-list {
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border);
}

.history-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border);
}

.history-main,
.history-badges {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.history-list p,
.history-list time {
  color: var(--muted);
  font-size: 13px;
}

.history-list time {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
}

.history-detail-toggle {
  grid-column: 1 / -1;
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  color: var(--accent-dark);
  background: transparent;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}

.history-detail-toggle svg {
  transition: transform 0.15s ease;
}

.history-detail-toggle svg.open {
  transform: rotate(180deg);
}

.history-detail {
  grid-column: 1 / -1;
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-tint);
}

.detail-hint,
.detail-error p {
  color: var(--muted);
  font-size: 13px;
}

.detail-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.detail-error p {
  margin: 0;
  color: var(--danger);
}

.detail-headline {
  color: var(--ink-soft);
  font-size: 13px;
  font-weight: 650;
}

.detail-items {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.detail-items li {
  display: grid;
  gap: 4px;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
}

.detail-items li:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.detail-item-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.detail-ordinal {
  min-width: 22px;
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
}

.detail-result {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
}

.detail-result[data-correct='true'] {
  color: #17623b;
}

.detail-result[data-correct='false'] {
  color: #8b322a;
}

.detail-prompt {
  color: var(--ink);
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.detail-reason {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 560px) {
  .history-list li {
    grid-template-columns: 1fr;
  }

  .history-list time {
    grid-column: 1;
    grid-row: auto;
  }
}
</style>
