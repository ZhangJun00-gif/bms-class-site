<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { BookOpen, LockKeyhole, Search, Users } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import { api, formatError, isAbortError } from '../../lib/api';
import { formatDate } from '../../lib/formatters';
import type {
  KnowledgeLibrary,
  KnowledgeLibraryDirectoryResponse,
  KnowledgeLibraryScope,
} from '../../types';

const props = defineProps<{ subjectId: string }>();
const emit = defineEmits<{ open: [library: KnowledgeLibrary] }>();

const scope = ref<'ALL' | KnowledgeLibraryScope>('ALL');
const searchInput = ref('');
const appliedQuery = ref('');
const page = ref(1);
const data = ref<KnowledgeLibraryDirectoryResponse | null>(null);
const loading = ref(false);
const error = ref('');
let controller: AbortController | null = null;
let requestGeneration = 0;

const libraries = computed(() => data.value?.items ?? []);
const pageCount = computed(() =>
  Math.max(1, Math.ceil((data.value?.total ?? 0) / (data.value?.pageSize ?? 20))),
);

async function load() {
  const generation = ++requestGeneration;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = '';
  const params = new URLSearchParams({
    subjectId: props.subjectId,
    page: String(page.value),
    pageSize: '20',
  });
  if (scope.value !== 'ALL') params.set('scope', scope.value);
  if (appliedQuery.value) params.set('query', appliedQuery.value);
  try {
    const result = await api<KnowledgeLibraryDirectoryResponse>(
      `/knowledge/libraries?${params.toString()}`,
      { signal: controller.signal },
    );
    if (generation === requestGeneration) data.value = result;
  } catch (caught) {
    if (generation === requestGeneration && !isAbortError(caught)) {
      error.value = formatError(caught, '知识库目录加载失败');
    }
  } finally {
    if (generation === requestGeneration) loading.value = false;
  }
}

function applySearch() {
  appliedQuery.value = searchInput.value.trim();
  page.value = 1;
  void load();
}

function changePage(nextPage: number) {
  page.value = Math.min(pageCount.value, Math.max(1, nextPage));
  void load();
}

watch(
  () => props.subjectId,
  () => {
    page.value = 1;
    data.value = null;
    void load();
  },
  { immediate: true },
);

watch(scope, () => {
  page.value = 1;
  void load();
});

onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section class="library-directory" aria-label="知识库目录">
    <div class="directory-tools">
      <div class="scope-segments" role="group" aria-label="知识库范围">
        <button type="button" :class="{ active: scope === 'ALL' }" @click="scope = 'ALL'">全部</button>
        <button type="button" :class="{ active: scope === 'SHARED' }" @click="scope = 'SHARED'">共享</button>
        <button type="button" :class="{ active: scope === 'PRIVATE' }" @click="scope = 'PRIVATE'">我的</button>
      </div>
      <form class="directory-search" role="search" @submit.prevent="applySearch">
        <label class="sr-only" for="library-query">搜索知识库</label>
        <input id="library-query" v-model="searchInput" maxlength="160" placeholder="搜索知识库名称" />
        <button type="submit" class="icon-button" title="搜索" aria-label="搜索知识库">
          <Search :size="17" aria-hidden="true" />
        </button>
      </form>
    </div>

    <div v-if="loading && !data" class="directory-loading">
      <SkeletonBlock v-for="index in 4" :key="index" :lines="2" />
    </div>
    <ErrorState v-else-if="error && !data" :message="error" @retry="load" />
    <EmptyState
      v-else-if="!libraries.length"
      title="当前学科暂无可阅读知识库"
      hint="可切换范围或调整搜索条件"
    />
    <div v-else class="library-rows" :aria-busy="loading">
      <button
        v-for="library in libraries"
        :key="library.id"
        type="button"
        class="library-row"
        @click="emit('open', library)"
      >
        <span class="library-icon" aria-hidden="true">
          <LockKeyhole v-if="library.scope === 'PRIVATE'" :size="18" />
          <Users v-else :size="18" />
        </span>
        <span class="library-copy">
          <strong>{{ library.name }}</strong>
          <span class="library-meta">
            <span>{{ library.scope === 'PRIVATE' ? '我的知识库' : '共享知识库' }}</span>
            <span>{{ library.reader?.h2Count ?? 0 }} 个章节</span>
            <span>{{ library.reader?.documentCount ?? 0 }} 次提交</span>
            <time v-if="library.reader?.contentUpdatedAt">更新于 {{ formatDate(library.reader.contentUpdatedAt) }}</time>
          </span>
        </span>
        <BookOpen :size="18" aria-hidden="true" />
      </button>
    </div>

    <div v-if="data && pageCount > 1" class="directory-pagination" aria-label="目录分页">
      <button type="button" class="button ghost" :disabled="page <= 1" @click="changePage(page - 1)">上一页</button>
      <span>第 {{ page }} / {{ pageCount }} 页</span>
      <button type="button" class="button ghost" :disabled="page >= pageCount" @click="changePage(page + 1)">下一页</button>
    </div>
    <p v-if="error && data" class="alert danger" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.library-directory {
  display: grid;
  gap: var(--space-5);
}

.directory-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.scope-segments {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-muted);
}

.scope-segments button {
  min-height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.scope-segments button.active {
  background: var(--surface);
  color: var(--primary);
  box-shadow: var(--shadow-s);
}

.directory-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: min(360px, 100%);
}

.directory-search input {
  width: 100%;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface);
}

.library-rows {
  display: grid;
  border-top: 1px solid var(--border);
}

.library-row {
  min-width: 0;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) 24px;
  align-items: center;
  gap: var(--space-3);
  padding: 15px 10px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
}

.library-row:hover,
.library-row:focus-visible {
  background: var(--surface-tint);
}

.library-icon {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  color: var(--accent-dark);
  background: var(--surface);
}

.library-copy {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.library-copy strong {
  overflow-wrap: anywhere;
}

.library-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  color: var(--muted);
  font-size: 13px;
}

.directory-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
}

.directory-pagination .button {
  min-height: 36px;
  padding: 0 14px;
  border-radius: var(--radius-s);
}

@media (max-width: 640px) {
  .directory-tools {
    align-items: stretch;
    flex-direction: column;
  }

  .directory-search {
    width: 100%;
  }

  .scope-segments {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
  }

  .library-row {
    grid-template-columns: 36px minmax(0, 1fr) 20px;
    padding-inline: 4px;
  }
}
</style>
