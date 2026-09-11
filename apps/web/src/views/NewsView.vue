<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import PageHeader from '../components/layout/PageHeader.vue';
import EmptyState from '../components/common/EmptyState.vue';
import ErrorState from '../components/common/ErrorState.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import StatusBadge from '../components/common/StatusBadge.vue';
import PaginationControl from '../components/common/PaginationControl.vue';
import NewsDetailDialog from '../components/news/NewsDetailDialog.vue';
import { useAsyncState } from '../composables/useAsyncState';
import { useAuthStore } from '../stores/auth';
import { fetchNewsSummaries } from '../lib/news';
import { formatDateTime } from '../lib/formatters';
import type { NewsSummary } from '../types';

const auth = useAuthStore();
const page = ref(1);
const pageSize = 10;
// 最近一次成功加载的页码：翻页失败时回滚页码，保持页码指示与内容一致
const loadedPage = ref(1);
const { data, loading, loaded, error, reload } = useAsyncState(async () => {
  try {
    const result = await fetchNewsSummaries(
      auth.isAuthenticated,
      page.value,
      pageSize,
    );
    loadedPage.value = result.page;
    return result;
  } catch (caught) {
    if (page.value !== loadedPage.value) page.value = loadedPage.value;
    throw caught;
  }
});
const items = computed(() => data.value?.items ?? []);
const pageCount = computed(() =>
  Math.max(1, Math.ceil((data.value?.total ?? 0) / pageSize)),
);

// 服务端分页：翻页重新请求；旧数据在请求期间保持渲染，避免列表高度跳动
watch(page, () => {
  void reload();
});

// total 收缩（动态被删除/归档）导致页码越界时回退到最后一页，watch(page) 自动重取
watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});

// 登录状态变化：切换公开/成员端点（详情缓存由 auth store 统一失效）
watch(
  () => auth.isAuthenticated,
  () => {
    selected.value = null;
    if (page.value !== 1) page.value = 1;
    else void reload();
  },
);

const selected = ref<NewsSummary | null>(null);
</script>

<template>
  <main class="page">
    <PageHeader title="班级动态" description="记录课程、活动与共同成长。">
      <template #breadcrumb>
        <RouterLink to="/">首页</RouterLink>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">班级动态</span>
      </template>
    </PageHeader>

    <section class="page-content">
      <div v-if="loading && !data">
        <SkeletonBlock v-for="index in 3" :key="index" :lines="3" />
      </div>
      <ErrorState v-else-if="error && !data" :message="error" @retry="reload" />
      <EmptyState
        v-else-if="loaded && !items.length"
        title="暂无动态"
        hint="动态发布后会显示在这里"
      />
      <template v-else>
        <p v-if="error" class="alert error" role="alert">
          {{ error }}
          <button type="button" class="alert-retry" @click="reload">重试</button>
        </p>
        <div class="list" :aria-busy="loading || undefined">
          <article
            v-for="item in items"
            :key="item.id"
            class="list-item news-item"
            role="button"
            tabindex="0"
            :aria-label="`阅读全文：${item.title}`"
            @click="selected = item"
            @keydown.enter.prevent="selected = item"
            @keydown.space.prevent="selected = item"
          >
            <div class="news-item-head">
              <h2>{{ item.title }}</h2>
              <StatusBadge v-if="item.visibility === 'MEMBERS'" text="成员可见" tone="accent" />
            </div>
            <p class="clamp-2">{{ item.summary }}</p>
            <div class="meta">
              <span>{{ item.author.displayName }}</span>
              <time :datetime="item.publishedAt ?? undefined">{{ formatDateTime(item.publishedAt) }}</time>
              <span class="news-more" aria-hidden="true">阅读全文</span>
            </div>
          </article>
        </div>
        <PaginationControl :page="page" :page-count="pageCount" @update:page="page = $event" />
      </template>
    </section>

    <NewsDetailDialog :item="selected" @close="selected = null" />
  </main>
</template>

<style scoped>
.news-item-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.news-item-head h2 {
  overflow-wrap: anywhere;
}

.news-item {
  cursor: pointer;
}

.news-more {
  color: var(--accent-dark);
  font-size: 13px;
}

.news-item:hover .news-more,
.news-item:focus-visible .news-more {
  text-decoration: underline;
}

.alert-retry {
  margin-left: var(--space-2);
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
</style>
