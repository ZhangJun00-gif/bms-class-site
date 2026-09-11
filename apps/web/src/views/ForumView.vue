<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ArrowLeft, Flag, MessageSquarePlus } from 'lucide-vue-next';
import PageHeader from '../components/layout/PageHeader.vue';
import EmptyState from '../components/common/EmptyState.vue';
import ErrorState from '../components/common/ErrorState.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import PaginationControl from '../components/common/PaginationControl.vue';
import ThreadList from '../components/forum/ThreadList.vue';
import ThreadDetail from '../components/forum/ThreadDetail.vue';
import ThreadComposerDialog from '../components/forum/ThreadComposerDialog.vue';
import ForumReportsDialog from '../components/forum/ForumReportsDialog.vue';
import { useLatestRequest } from '../composables/useLatestRequest';
import { api, formatError } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import type { ForumThread, ForumThreadListResponse } from '../types';

const auth = useAuthStore();

const page = ref(1);
const pageSize = 20;
const data = ref<ForumThreadListResponse | null>(null);
const loaded = ref(false);
const error = ref('');
const requests = useLatestRequest();
const loading = requests.loading;
let stablePage = page.value;
const threads = computed(() => data.value?.items ?? []);
const pageCount = computed(() =>
  Math.max(1, Math.ceil((data.value?.total ?? 0) / pageSize)),
);

async function reload(
  nextPage = page.value,
  navigate = false,
) {
  error.value = '';
  if (navigate) page.value = nextPage;
  const fetchPage = (targetPage: number, signal: AbortSignal) =>
    api<ForumThreadListResponse>(
      `/forum/threads?page=${targetPage}&pageSize=${pageSize}`,
      { signal },
    );
  const task = async ({ signal }: { signal: AbortSignal }) => {
    const result = await fetchPage(nextPage, signal);
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
    if (result.page <= lastPage) return result;
    const corrected = await fetchPage(lastPage, signal);
    const correctedLastPage = Math.max(1, Math.ceil(corrected.total / pageSize));
    if (corrected.page > correctedLastPage) {
      throw new Error('论坛主题在加载期间发生变化，请重试');
    }
    return corrected;
  };
  const callbacks = {
    commit(result: ForumThreadListResponse) {
      data.value = result;
      page.value = result.page;
      stablePage = result.page;
      loaded.value = true;
    },
    onError(caught: unknown) {
      page.value = stablePage;
      error.value = formatError(caught, '论坛主题加载失败');
    },
  };
  return requests.runLatest(task, callbacks);
}

const selectedId = ref<string | null>(null);
const composing = ref(false);
const reportsOpen = ref(false);

function select(thread: ForumThread) {
  selectedId.value = thread.id;
}

function back() {
  selectedId.value = null;
}

function onCreated(thread: ForumThread) {
  selectedId.value = thread.id;
  void reload();
}

function onDeleted() {
  selectedId.value = null;
  void reload();
}

onMounted(() => void reload());
</script>

<template>
  <main class="page">
    <PageHeader title="班级论坛" description="围绕课程与班级事务展开有序讨论。">
      <template #breadcrumb>
        <RouterLink to="/">首页</RouterLink>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">班级论坛</span>
      </template>
      <template #actions>
        <button
          v-if="auth.canEdit"
          type="button"
          class="button secondary"
          @click="reportsOpen = true"
        >
          <Flag :size="17" aria-hidden="true" />
          待处理举报
        </button>
        <button type="button" class="button" @click="composing = true">
          <MessageSquarePlus :size="17" aria-hidden="true" />
          发布主题
        </button>
      </template>
    </PageHeader>

    <section class="page-content">
      <p v-if="error && loaded" class="alert error" role="alert">
        {{ error }}
        <button type="button" class="button ghost" @click="reload()">重试</button>
      </p>
      <!-- 已有数据时静默刷新，避免回复后整屏闪骨架与详情重挂载 -->
      <div v-if="loading && !loaded">
        <SkeletonBlock v-for="index in 4" :key="index" :lines="2" />
      </div>
      <ErrorState v-else-if="error && !loaded" :message="error" @retry="reload()" />
      <EmptyState
        v-else-if="!threads.length"
        title="暂无主题"
        hint="点击右上角「发布主题」发起第一个讨论"
      />
      <div v-else class="forum-layout" :class="{ 'has-selection': selectedId }">
        <aside class="forum-aside">
          <ThreadList
            :threads="threads"
            :selected-id="selectedId"
            @select="select"
          />
        </aside>
        <section class="forum-detail">
          <button type="button" class="button ghost back-button" @click="back">
            <ArrowLeft :size="16" aria-hidden="true" />
            返回主题列表
          </button>
          <ThreadDetail
            v-if="selectedId"
            :key="selectedId"
            :thread-id="selectedId"
            @deleted="onDeleted"
            @changed="reload"
          />
          <EmptyState
            v-else
            title="选择一个主题查看讨论"
            class="detail-placeholder"
          />
        </section>
      </div>
      <PaginationControl
        v-if="loaded"
        :page="page"
        :page-count="pageCount"
        @update:page="reload($event, true)"
      />
    </section>

    <ThreadComposerDialog
      :open="composing"
      @close="composing = false"
      @saved="onCreated"
    />
    <ForumReportsDialog :open="reportsOpen" @close="reportsOpen = false" />
  </main>
</template>

<style scoped>
.forum-layout {
  display: grid;
  grid-template-columns: minmax(260px, 0.85fr) minmax(0, 1.5fr);
  gap: var(--space-8);
  align-items: start;
}

.forum-aside {
  min-width: 0;
}

.forum-detail {
  min-width: 0;
}

.back-button {
  display: none;
  margin-bottom: var(--space-4);
}

@media (max-width: 900px) {
  .forum-layout {
    grid-template-columns: 1fr;
  }

  /* 移动端：列表与详情二选一展示，而不是堆成长页面 */
  .forum-layout.has-selection .forum-aside {
    display: none;
  }

  .forum-layout:not(.has-selection) .forum-detail {
    display: none;
  }

  .back-button {
    display: inline-flex;
  }
}
</style>
