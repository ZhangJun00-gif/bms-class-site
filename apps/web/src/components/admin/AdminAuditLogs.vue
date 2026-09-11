<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Download, RefreshCw, Search, X } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { api, apiFile, formatError } from '../../lib/api';
import { auditActionLabel, summarizeAuditMetadata } from '../../lib/audit';
import { formatDateTime } from '../../lib/formatters';
import { useToast } from '../../composables/useToast';
import type {
  AuditLogItem,
  AuditLogPage,
  ListResponse,
  Member,
} from '../../types';

interface AuditFilters {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
}

const PAGE_SIZE = 50;
const toast = useToast();
const listRequests = useLatestRequest();
const actorRequests = useLatestRequest();

const logs = ref<AuditLogItem[]>([]);
const nextCursor = ref<string | null>(null);
const loaded = ref(false);
const loadError = ref('');
const appendError = ref('');
const actors = ref<Member[]>([]);
const actorsError = ref('');
const exporting = ref(false);

const draft = reactive({
  actorId: '',
  action: '',
  targetType: '',
  targetId: '',
  from: '',
  to: '',
});
const appliedFilters = ref<AuditFilters>({});
const knownActions = computed(() =>
  Array.from(new Set(logs.value.map((log) => log.action))).sort(),
);
const knownTargetTypes = computed(() =>
  Array.from(new Set(logs.value.map((log) => log.targetType))).sort(),
);

onMounted(() => {
  void loadActors();
  void loadLogs(false);
});

function target(log: AuditLogItem) {
  return log.targetId ? `${log.targetType} · ${log.targetId}` : log.targetType;
}

function buildParams(filters: AuditFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return params;
}

function normalizedFilters(): AuditFilters | null {
  const from = draft.from ? new Date(draft.from) : null;
  const to = draft.to ? new Date(draft.to) : null;
  if (from && to && from > to) {
    loadError.value = '开始时间不能晚于结束时间';
    return null;
  }
  return {
    ...(draft.actorId ? { actorId: draft.actorId } : {}),
    ...(draft.action.trim() ? { action: draft.action.trim() } : {}),
    ...(draft.targetType.trim() ? { targetType: draft.targetType.trim() } : {}),
    ...(draft.targetId.trim() ? { targetId: draft.targetId.trim() } : {}),
    ...(from ? { from: from.toISOString() } : {}),
    ...(to ? { to: to.toISOString() } : {}),
  };
}

async function loadActors() {
  actorsError.value = '';
  await actorRequests.runLatest(
    ({ signal }) => api<ListResponse<Member>>('/users', { signal }),
    {
      commit(result) {
        actors.value = result.items;
      },
      onError(caught) {
        actorsError.value = formatError(caught, '操作者列表加载失败');
      },
    },
  );
}

async function loadLogs(append: boolean) {
  if (append && (!nextCursor.value || listRequests.loading.value)) return;
  const cursor = append ? nextCursor.value : null;
  if (!append) {
    loadError.value = '';
    appendError.value = '';
  }
  const params = buildParams(appliedFilters.value);
  params.set('pageSize', String(PAGE_SIZE));
  if (cursor) params.set('cursor', cursor);
  await listRequests.runLatest(
    ({ signal }) => api<AuditLogPage>(
      `/admin/audit-logs?${params.toString()}`,
      { signal },
    ),
    {
      commit(result) {
        const merged = append ? [...logs.value, ...result.items] : result.items;
        logs.value = Array.from(
          new Map(merged.map((log) => [log.id, log])).values(),
        );
        nextCursor.value = result.nextCursor;
        loaded.value = true;
      },
      onError(caught) {
        const message = formatError(caught, '审计日志加载失败');
        if (append) appendError.value = message;
        else loadError.value = message;
      },
    },
  );
}

function applyFilters() {
  const filters = normalizedFilters();
  if (!filters) return;
  appliedFilters.value = filters;
  nextCursor.value = null;
  void loadLogs(false);
}

function resetFilters() {
  Object.assign(draft, {
    actorId: '',
    action: '',
    targetType: '',
    targetId: '',
    from: '',
    to: '',
  });
  appliedFilters.value = {};
  nextCursor.value = null;
  void loadLogs(false);
}

async function exportCsv() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const params = buildParams(appliedFilters.value);
    params.set('limit', '5000');
    const result = await apiFile(`/admin/audit-logs.csv?${params.toString()}`);
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    const truncated = result.headers.get('x-result-truncated') === 'true';
    const limit = result.headers.get('x-result-limit') ?? '5000';
    if (truncated) toast.info(`CSV 已导出前 ${limit} 条，符合条件的结果已达到上限`);
    else toast.success('审计日志 CSV 已导出');
  } catch (caught) {
    toast.error(formatError(caught, '审计日志导出失败'));
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <section aria-label="审计日志" class="audit-section">
    <header class="audit-heading">
      <div>
        <h2>审计日志</h2>
        <p>按稳定时间游标加载，导出使用当前已应用的筛选条件。</p>
      </div>
      <div class="heading-actions">
        <button
          type="button"
          class="icon-button"
          title="刷新审计日志"
          aria-label="刷新审计日志"
          :disabled="listRequests.loading.value"
          @click="loadLogs(false)"
        >
          <RefreshCw :size="16" aria-hidden="true" />
        </button>
        <button type="button" class="button secondary" :disabled="exporting" @click="exportCsv">
          <Download :size="16" aria-hidden="true" />
          {{ exporting ? '正在导出…' : '导出 CSV' }}
        </button>
      </div>
    </header>

    <form class="audit-filters" @submit.prevent="applyFilters">
      <div class="field">
        <label for="audit-actor">操作者</label>
        <select id="audit-actor" v-model="draft.actorId">
          <option value="">全部操作者</option>
          <option v-for="actor in actors" :key="actor.id" :value="actor.id">
            {{ actor.displayName }}
          </option>
        </select>
        <small v-if="actorsError" class="filter-error">{{ actorsError }}</small>
      </div>
      <div class="field">
        <label for="audit-action">动作</label>
        <input id="audit-action" v-model="draft.action" list="audit-actions" maxlength="100" placeholder="精确动作名" />
        <datalist id="audit-actions">
          <option v-for="action in knownActions" :key="action" :value="action" />
        </datalist>
      </div>
      <div class="field">
        <label for="audit-target-type">目标类型</label>
        <input id="audit-target-type" v-model="draft.targetType" list="audit-target-types" maxlength="80" placeholder="例如 Album" />
        <datalist id="audit-target-types">
          <option v-for="type in knownTargetTypes" :key="type" :value="type" />
        </datalist>
      </div>
      <div class="field">
        <label for="audit-target-id">目标 ID</label>
        <input id="audit-target-id" v-model="draft.targetId" maxlength="64" />
      </div>
      <div class="field">
        <label for="audit-from">开始时间</label>
        <input id="audit-from" v-model="draft.from" type="datetime-local" />
      </div>
      <div class="field">
        <label for="audit-to">结束时间</label>
        <input id="audit-to" v-model="draft.to" type="datetime-local" />
      </div>
      <div class="filter-actions">
        <button type="submit" class="button" :disabled="listRequests.loading.value">
          <Search :size="16" aria-hidden="true" />
          查询
        </button>
        <button type="button" class="button ghost" :disabled="listRequests.loading.value" @click="resetFilters">
          <X :size="16" aria-hidden="true" />
          清空
        </button>
      </div>
    </form>

    <p v-if="loadError && loaded" class="alert error" role="alert">{{ loadError }}</p>
    <SkeletonBlock v-if="listRequests.loading.value && !loaded" :lines="6" />
    <ErrorState
      v-else-if="loadError && !loaded"
      :message="loadError"
      retry-label="重试加载审计日志"
      @retry="loadLogs(false)"
    />
    <EmptyState v-else-if="!logs.length" title="暂无符合条件的审计日志" />
    <div v-else class="table-wrap audit-table">
      <table>
        <thead>
          <tr>
            <th scope="col">时间</th>
            <th scope="col">操作者</th>
            <th scope="col">动作</th>
            <th scope="col">目标</th>
            <th scope="col">详情摘要</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in logs" :key="log.id">
            <td data-label="时间">{{ formatDateTime(log.createdAt) }}</td>
            <td data-label="操作者">{{ log.actor?.displayName ?? '系统' }}</td>
            <td data-label="动作">{{ auditActionLabel(log.action) }}</td>
            <td data-label="目标" class="audit-target">{{ target(log) }}</td>
            <td data-label="详情" class="audit-details">{{ summarizeAuditMetadata(log.metadata) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="appendError" class="alert error" role="alert">{{ appendError }}</p>
    <button
      v-if="nextCursor"
      type="button"
      class="button ghost load-more"
      :disabled="listRequests.loading.value"
      @click="loadLogs(true)"
    >
      {{ listRequests.loading.value ? '正在加载…' : '加载更多记录' }}
    </button>
  </section>
</template>

<style scoped>
.audit-section {
  display: grid;
  gap: var(--space-5);
}

.audit-heading,
.heading-actions,
.filter-actions {
  display: flex;
  align-items: center;
}

.audit-heading {
  justify-content: space-between;
  gap: var(--space-3);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.audit-heading h2 {
  margin: 0;
  font-size: 18px;
}

.audit-heading p {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.heading-actions,
.filter-actions {
  gap: var(--space-2);
}

.audit-filters {
  display: grid;
  grid-template-columns: repeat(3, minmax(180px, 1fr));
  gap: var(--space-4);
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--border);
}

.filter-actions {
  align-self: end;
}

.filter-error {
  color: var(--danger);
}

.audit-target,
.audit-details {
  white-space: normal;
  overflow-wrap: anywhere;
}

.audit-details {
  min-width: 240px;
  color: var(--ink-soft);
  line-height: 1.6;
}

.load-more {
  justify-self: center;
}

@media (max-width: 900px) {
  .audit-filters {
    grid-template-columns: repeat(2, minmax(180px, 1fr));
  }
}

@media (max-width: 820px) {
  .audit-table {
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  table,
  tbody {
    display: block;
  }

  thead {
    display: none;
  }

  tbody tr {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-5) 0;
    border-bottom: 1px solid var(--border);
  }

  td {
    display: grid;
    grid-template-columns: 74px minmax(0, 1fr);
    gap: var(--space-3);
    min-width: 0;
    padding: 0;
    border: 0;
    white-space: normal;
  }

  td::before {
    content: attr(data-label);
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }
}

@media (max-width: 560px) {
  .audit-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .heading-actions .button {
    flex: 1;
  }

  .audit-filters {
    grid-template-columns: 1fr;
  }

  .filter-actions .button {
    flex: 1;
  }
}
</style>
