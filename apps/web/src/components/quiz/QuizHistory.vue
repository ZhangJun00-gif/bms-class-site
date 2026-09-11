<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import PaginationControl from '../common/PaginationControl.vue';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { api, formatError } from '../../lib/api';
import { formatDateTime } from '../../lib/formatters';
import type { QuizHistoryResponse } from '../../types';

const page = ref(1);
const pageSize = 20;
const data = ref<QuizHistoryResponse | null>(null);
const loaded = ref(false);
const error = ref('');
const requests = useLatestRequest();
const loading = requests.loading;
let stablePage = page.value;
const items = computed(() => data.value?.items ?? []);
const pageCount = computed(() =>
  Math.max(1, Math.ceil((data.value?.total ?? 0) / pageSize)),
);

async function load(nextPage = page.value, navigate = false) {
  error.value = '';
  if (navigate) page.value = nextPage;
  const fetchPage = (targetPage: number, signal: AbortSignal) =>
    api<QuizHistoryResponse>(
      `/quizzes/history?page=${targetPage}&pageSize=${pageSize}`,
      { signal },
    );
  const task = async ({ signal }: { signal: AbortSignal }) => {
    const result = await fetchPage(nextPage, signal);
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
    if (result.page <= lastPage) return result;
    const corrected = await fetchPage(lastPage, signal);
    const correctedLastPage = Math.max(1, Math.ceil(corrected.total / pageSize));
    if (corrected.page > correctedLastPage) {
      throw new Error('答题历史在加载期间发生变化，请重试');
    }
    return corrected;
  };
  const callbacks = {
    commit(result: QuizHistoryResponse) {
      data.value = result;
      page.value = result.page;
      stablePage = result.page;
      loaded.value = true;
    },
    onError(caught: unknown) {
      page.value = stablePage;
      error.value = formatError(caught, '答题历史加载失败');
    },
  };
  await requests.runLatest(task, callbacks);
}

onMounted(() => void load());
</script>

<template>
  <div>
    <p v-if="error && loaded" class="alert error" role="alert">
      {{ error }}
      <button type="button" class="button ghost" @click="load()">重试</button>
    </p>
    <SkeletonBlock v-if="loading && !loaded" :lines="4" />
    <ErrorState v-else-if="error && !loaded" :message="error" @retry="load()" />
    <EmptyState v-else-if="!items.length" title="暂无答题记录" hint="完成一次答题后会记录在这里" />
    <div v-else class="table-wrap" :aria-busy="loading || undefined">
      <table>
        <thead>
          <tr>
            <th scope="col">提交时间</th>
            <th scope="col">得分</th>
            <th scope="col">题数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td>{{ formatDateTime(item.submittedAt ?? item.createdAt) }}</td>
            <td>{{ item.score ?? '—' }}</td>
            <td>{{ item.total }}</td>
          </tr>
        </tbody>
      </table>
      <PaginationControl
        :page="page"
        :page-count="pageCount"
        @update:page="load($event, true)"
      />
    </div>
  </div>
</template>
