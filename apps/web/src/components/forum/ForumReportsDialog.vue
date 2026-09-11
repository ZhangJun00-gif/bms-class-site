<script setup lang="ts">
import { ref, watch } from 'vue';
import BaseDialog from '../common/BaseDialog.vue';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import { api, formatError } from '../../lib/api';
import { formatDateTime } from '../../lib/formatters';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import type { ForumReport, ListResponse } from '../../types';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { confirm } = useConfirm();
const toast = useToast();
const reports = ref<ForumReport[]>([]);
const loading = ref(false);
const error = ref('');
const busyId = ref('');

watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
  { immediate: true },
);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const result = await api<ListResponse<ForumReport>>('/forum/reports');
    reports.value = result.items;
  } catch (caught) {
    error.value = formatError(caught, '举报列表加载失败');
  } finally {
    loading.value = false;
  }
}

function targetLabel(report: ForumReport) {
  return report.threadId
    ? `主题 ${report.threadId}`
    : `回复 ${report.postId ?? '未知'}`;
}

async function resolve(report: ForumReport) {
  const ok = await confirm({
    title: '处理举报',
    body: `确认已核查“${targetLabel(report)}”，并将这条举报标记为已处理？`,
    confirmText: '标记已处理',
  });
  if (!ok) return;
  busyId.value = report.id;
  try {
    await api(`/forum/reports/${report.id}/resolve`, { method: 'PATCH' });
    toast.success('举报已处理');
    await load();
  } catch (caught) {
    toast.error(formatError(caught, '举报处理失败'));
  } finally {
    busyId.value = '';
  }
}
</script>

<template>
  <BaseDialog
    :open="open"
    title="待处理举报"
    :width="720"
    @close="emit('close')"
  >
    <SkeletonBlock v-if="loading" :lines="5" />
    <ErrorState
      v-else-if="error"
      :message="error"
      retry-label="重试加载举报"
      @retry="load"
    />
    <EmptyState v-else-if="!reports.length" title="暂无待处理举报" />
    <div v-else class="report-list">
      <article v-for="report in reports" :key="report.id" class="report-item">
        <div class="report-main">
          <strong>{{ targetLabel(report) }}</strong>
          <p>{{ report.reason }}</p>
          <div class="meta">
            <span>举报人：{{ report.reporter.displayName }}</span>
            <time>{{ formatDateTime(report.createdAt) }}</time>
          </div>
        </div>
        <button
          type="button"
          class="button secondary"
          :disabled="busyId === report.id"
          @click="resolve(report)"
        >
          {{ busyId === report.id ? '处理中…' : '标记已处理' }}
        </button>
      </article>
    </div>
  </BaseDialog>
</template>

<style scoped>
.report-list {
  display: grid;
  border-top: 1px solid var(--border);
}

.report-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-5);
  align-items: center;
  padding: var(--space-5) 0;
  border-bottom: 1px solid var(--border);
}

.report-main {
  min-width: 0;
}

.report-main strong,
.report-main p {
  overflow-wrap: anywhere;
}

.report-main p {
  margin: var(--space-2) 0;
  line-height: 1.7;
}

@media (max-width: 560px) {
  .report-item {
    grid-template-columns: 1fr;
  }

  .report-item .button {
    width: 100%;
  }
}
</style>
