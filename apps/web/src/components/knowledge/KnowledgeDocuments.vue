<script setup lang="ts">
import { ref, watch } from 'vue';
import { FileText } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import { api, formatError } from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/formatters';
import { indexStatusLabels, indexStatusTones, knowledgeKindLabels } from '../../lib/labels';
import type { KnowledgeDocument, KnowledgeDocumentDetail } from '../../types';

const props = defineProps<{ documents: KnowledgeDocument[]; selectedId: string | null }>();
const emit = defineEmits<{ select: [id: string | null] }>();

const detail = ref<KnowledgeDocumentDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref('');
// 递增请求序号：快速切换文档时，迟到的旧响应不得覆盖当前选择
let detailRequestId = 0;

async function loadDetail(id: string) {
  const requestId = ++detailRequestId;
  detailLoading.value = true;
  detailError.value = '';
  try {
    const result = await api<KnowledgeDocumentDetail>(`/knowledge/${id}`);
    if (requestId === detailRequestId) detail.value = result;
  } catch (caught) {
    if (requestId === detailRequestId)
      detailError.value = formatError(caught, '资料加载失败');
  } finally {
    if (requestId === detailRequestId) detailLoading.value = false;
  }
}

watch(
  () => props.selectedId,
  (id) => {
    detail.value = null;
    detailError.value = '';
    detailLoading.value = false;
    // 切换选择后旧请求的迟到响应一律丢弃
    detailRequestId += 1;
    if (!id) return;
    void loadDetail(id);
  },
  { immediate: true },
);

async function retry() {
  const id = props.selectedId;
  if (!id) return;
  detail.value = null;
  await loadDetail(id);
}
</script>

<template>
  <div class="documents-layout">
    <div class="documents-list">
      <EmptyState v-if="!documents.length" title="暂无已发布资料" hint="编辑发布资料后会显示在这里" />
      <div v-else class="list">
        <button
          v-for="document in documents"
          :key="document.id"
          type="button"
          class="document-item"
          :class="{ active: selectedId === document.id }"
          @click="emit('select', document.id)"
        >
          <span class="document-title">
            <FileText :size="15" aria-hidden="true" />
            <strong>{{ document.title }}</strong>
          </span>
          <span class="meta">
            <span>{{ document.subject.name }}</span>
            <StatusBadge :text="knowledgeKindLabels[document.kind]" tone="accent" />
            <StatusBadge :text="indexStatusLabels[document.indexStatus]" :tone="indexStatusTones[document.indexStatus] as ''" />
            <span v-if="document.fileSize">{{ formatBytes(document.fileSize) }}</span>
            <time>{{ formatDate(document.publishedAt) }}</time>
          </span>
        </button>
      </div>
    </div>

    <div class="documents-reader">
      <EmptyState v-if="!selectedId" title="选择左侧资料开始阅读" />
      <SkeletonBlock v-else-if="detailLoading" :lines="6" />
      <ErrorState v-else-if="detailError" :message="detailError" @retry="retry" />
      <article v-else-if="detail" class="reader">
        <h2 class="reader-title">{{ detail.title }}</h2>
        <div class="meta reader-meta">
          <StatusBadge :text="knowledgeKindLabels[detail.kind]" tone="accent" />
          <span>{{ detail.subject.name }}</span>
          <span v-if="detail.fileSize">{{ formatBytes(detail.fileSize) }}</span>
          <span v-if="detail.sourceName">{{ detail.sourceName }}</span>
          <time>{{ formatDate(detail.publishedAt) }}</time>
        </div>
        <p v-if="detail.kind !== 'ARTICLE'" class="alert info">
          这是一份{{ knowledgeKindLabels[detail.kind] }}，正文不在此展示，请通过「AI 问答」检索其中的内容。
        </p>
        <!-- 文章正文由后端 sanitize-html 清洗 -->
        <div v-else-if="detail.body" class="rich-text" v-html="detail.body" />
        <p v-else class="alert info">本文暂无正文内容。</p>
      </article>
    </div>
  </div>
</template>

<style scoped>
.documents-layout {
  display: grid;
  grid-template-columns: minmax(260px, 0.85fr) minmax(0, 1.5fr);
  gap: var(--space-8);
  align-items: start;
}

.documents-list,
.documents-reader {
  min-width: 0;
}

.document-item {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-3);
  border: 0;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--border);
  border-radius: 0 var(--radius-m) var(--radius-m) 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s var(--ease-out), border-color 0.15s var(--ease-out);
}

.document-item:hover {
  background: var(--surface-tint);
}

.document-item.active {
  border-left-color: var(--accent);
  background: var(--accent-soft);
}

.document-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--primary-dark);
  overflow-wrap: anywhere;
}

.document-title svg {
  flex: none;
  color: var(--accent-dark);
}

.reader {
  display: grid;
  gap: var(--space-4);
}

.reader-title {
  margin: 0;
  font-size: 22px;
  overflow-wrap: anywhere;
}

.reader-meta {
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
}

@media (max-width: 900px) {
  .documents-layout {
    grid-template-columns: 1fr;
  }
}
</style>
