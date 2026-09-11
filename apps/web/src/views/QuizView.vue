<script setup lang="ts">
import { inject, ref, watch } from 'vue';
import { routeLocationKey, routerKey } from 'vue-router';
import { api, formatError } from '../lib/api';
import PageHeader from '../components/layout/PageHeader.vue';
import QuizStartPanel from '../components/quiz/QuizStartPanel.vue';
import QuizLibrary from '../components/quiz/QuizLibrary.vue';
import QuizPapers from '../components/quiz/QuizPapers.vue';
import QuizRunner from '../components/quiz/QuizRunner.vue';
import QuizHistory from '../components/quiz/QuizHistory.vue';
import QuizWrong from '../components/quiz/QuizWrong.vue';
import { useLatestRequest } from '../composables/useLatestRequest';
import type {
  QuizAttemptLifecycle,
  QuizStartResponse,
} from '../types';

type QuizAttemptPayload = QuizStartResponse & Partial<QuizAttemptLifecycle>;

const tabs = [
  { id: 'random', label: '随机练习' },
  { id: 'library', label: '浏览题库' },
  { id: 'papers', label: '往年真题' },
  { id: 'history', label: '答题历史' },
  { id: 'wrong', label: '错题' },
] as const;

type TabId = (typeof tabs)[number]['id'];

const route = inject(routeLocationKey, null);
const router = inject(routerKey, undefined);
const requestedMode = () =>
  tabs.some((item) => item.id === route?.query.mode)
    ? (route?.query.mode as TabId)
    : 'random';
const tab = ref<TabId>(requestedMode());
// 题库面板懒挂载后保持存活：跨页选题状态在切 Tab 后不丢失
const libraryMounted = ref(tab.value === 'library');
const attempt = ref<QuizAttemptPayload | null>(null);
const attemptError = ref('');
const attemptRequests = useLatestRequest();
const attemptLoading = attemptRequests.loading;

function switchTab(id: TabId) {
  tab.value = id;
  if (id === 'library') libraryMounted.value = true;
}

function queryAttemptId(): string {
  const value = route?.query.attempt;
  return typeof value === 'string' ? value : '';
}

async function replaceAttemptQuery(attemptId: string | null) {
  if (!router) return;
  const query = { ...(route?.query ?? {}) };
  if (attemptId) query.attempt = attemptId;
  else delete query.attempt;
  await router.replace({ query });
}

async function restoreAttempt(attemptId: string) {
  attemptError.value = '';
  await attemptRequests.runLatest(
    ({ signal }) =>
      api<QuizAttemptLifecycle>(
        `/quizzes/attempts/${encodeURIComponent(attemptId)}`,
        { signal },
      ),
    {
      commit(restored) {
        if (restored.attemptId !== attemptId) return;
        attempt.value = restored;
      },
      onError(caught) {
        attempt.value = null;
        attemptError.value = formatError(
          caught,
          '答题草稿加载失败，请稍后重试',
        );
      },
    },
  );
}

function onStarted(payload: QuizAttemptPayload) {
  attempt.value = payload;
  attemptError.value = '';
  void replaceAttemptQuery(payload.attemptId);
}

function restart() {
  attemptRequests.cancelLatest();
  attempt.value = null;
  attemptError.value = '';
  void replaceAttemptQuery(null);
}

watch(
  () => route?.query.mode,
  () => switchTab(requestedMode()),
);

watch(
  () => queryAttemptId(),
  (attemptId) => {
    if (!attemptId) {
      attemptRequests.cancelLatest();
      if (attempt.value) attempt.value = null;
      attemptError.value = '';
      return;
    }
    if (attempt.value?.attemptId === attemptId) return;
    void restoreAttempt(attemptId);
  },
  { immediate: true },
);
</script>

<template>
  <main class="page">
    <PageHeader title="题库" description="按题目快照由服务端自动判分，提交后显示解析并记录错题。">
      <template #breadcrumb>
        <RouterLink to="/">首页</RouterLink>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">题库</span>
      </template>
    </PageHeader>

    <section class="page-content">
      <p v-if="attemptLoading" class="empty">正在恢复答题草稿…</p>
      <div v-else-if="attemptError" class="alert error restore-error" role="alert">
        <span>{{ attemptError }}</span>
        <div class="restore-actions">
          <button
            v-if="queryAttemptId()"
            type="button"
            class="button ghost"
            @click="restoreAttempt(queryAttemptId())"
          >
            重试
          </button>
          <button type="button" class="button ghost" @click="restart">
            返回题库
          </button>
        </div>
      </div>
      <template v-else-if="!attempt">
        <div class="tabs" role="tablist" aria-label="题库功能">
          <button
            v-for="item in tabs"
            :key="item.id"
            type="button"
            role="tab"
            :aria-selected="tab === item.id"
            @click="switchTab(item.id)"
          >
            {{ item.label }}
          </button>
        </div>
        <QuizStartPanel v-show="tab === 'random'" @started="onStarted" />
        <QuizLibrary
          v-if="libraryMounted"
          v-show="tab === 'library'"
          @started="onStarted"
        />
        <QuizPapers v-if="tab === 'papers'" @started="onStarted" />
        <QuizHistory v-if="tab === 'history'" />
        <QuizWrong v-if="tab === 'wrong'" />
      </template>
      <QuizRunner
        v-else
        :key="attempt.attemptId"
        :attempt-id="attempt.attemptId"
        :questions="attempt.questions"
        :initial-state="attempt"
        @restart="restart"
      />
    </section>
  </main>
</template>

<style scoped>
.restore-error {
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.restore-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
