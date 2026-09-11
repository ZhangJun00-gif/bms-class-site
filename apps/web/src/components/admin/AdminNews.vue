<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import {
  Archive,
  ArchiveRestore,
  FilePlus2,
  RotateCw,
  Trash2,
} from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import PaginationControl from '../common/PaginationControl.vue';
import { ApiClientError, api, formatError } from '../../lib/api';
import { invalidateNewsDetail } from '../../lib/news';
import { formatDateTime } from '../../lib/formatters';
import { adminTabGuardKey } from '../../lib/adminTabGuard';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useToast } from '../../composables/useToast';
import { useAuthStore } from '../../stores/auth';
import type {
  ContentStatus,
  NewsEditableStatus,
  NewsItem,
  NewsMutationResult,
  NewsPageResponse,
  NewsSummary,
  NewsUpdateRequest,
  NewsWriteRequest,
  Visibility,
} from '../../types';
import RichTextEditor from './RichTextEditor.vue';

const auth = useAuthStore();
const toast = useToast();
const { confirm } = useConfirm();

type StatusFilter = '' | ContentStatus;
const statusTabs: Array<{ value: StatusFilter; label: string }> = [
  { value: '', label: '全部' },
  { value: 'DRAFT', label: '草稿' },
  { value: 'PUBLISHED', label: '已发布' },
  { value: 'ARCHIVED', label: '已归档' },
];
const statusLabels: Record<ContentStatus, string> = {
  DRAFT: '草稿',
  PUBLISHED: '已发布',
  ARCHIVED: '已归档',
};
const statusTones = {
  DRAFT: 'warning',
  PUBLISHED: 'success',
  ARCHIVED: 'muted',
} as const;

/* ---------- 表单与版本基线 ---------- */

const title = ref('');
const summary = ref('');
const body = ref('');
const visibility = ref<Visibility>('MEMBERS');
const status = ref<NewsEditableStatus>('PUBLISHED');
const editingId = ref<string | null>(null);
const editingStatus = ref<ContentStatus | null>(null);
/** 最近一次成功加载/保存的 updatedAt，作为条件更新的版本基线 */
const baselineUpdatedAt = ref('');
const busy = ref(false);
const loadingRecordId = ref('');
const error = ref('');
/** 409 冲突：本地内容保持不动，提供重新加载入口 */
const conflict = ref(false);

function formSnapshot() {
  return JSON.stringify({
    title: title.value,
    summary: summary.value,
    body: body.value,
    visibility: visibility.value,
    status: status.value,
  });
}

const savedSnapshot = ref(formSnapshot());
const dirty = computed(() => formSnapshot() !== savedSnapshot.value);

function applyRecord(record: NewsItem) {
  editingId.value = record.id;
  editingStatus.value = record.status;
  title.value = record.title;
  summary.value = record.summary;
  body.value = record.body;
  visibility.value = record.visibility;
  status.value = record.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT';
  baselineUpdatedAt.value = record.updatedAt ?? '';
  error.value = '';
  conflict.value = false;
  savedSnapshot.value = formSnapshot();
}

function resetForm() {
  editingId.value = null;
  editingStatus.value = null;
  title.value = '';
  summary.value = '';
  body.value = '';
  visibility.value = 'MEMBERS';
  status.value = 'PUBLISHED';
  baselineUpdatedAt.value = '';
  error.value = '';
  conflict.value = false;
  savedSnapshot.value = formSnapshot();
}

/* ---------- 已归档记录（只读面板） ---------- */

const archivedRecord = ref<NewsItem | null>(null);
const archivedError = ref('');
const actionBusy = ref<'' | 'archive' | 'restore' | 'delete'>('');

/* ---------- 管理列表：状态筛选 + 服务端分页 ---------- */

const statusFilter = ref<StatusFilter>('');
const page = ref(1);
const pageSize = 20;
const manageData = ref<NewsPageResponse | null>(null);
const manageLoaded = ref(false);
const manageError = ref('');
const listRequests = useLatestRequest();
const detailRequests = useLatestRequest();
const manageLoading = listRequests.loading;
let stableManagePage = page.value;
const records = computed(() => manageData.value?.items ?? []);
const pageCount = computed(() =>
  Math.max(1, Math.ceil((manageData.value?.total ?? 0) / pageSize)),
);

function cancelDetailLoad() {
  detailRequests.cancelLatest();
  loadingRecordId.value = '';
}

async function reloadManage(nextPage = page.value, navigate = false) {
  const requestedStatus = statusFilter.value;
  const statusParam = requestedStatus ? `&status=${requestedStatus}` : '';
  manageError.value = '';
  if (navigate) page.value = nextPage;
  const fetchPage = (targetPage: number, signal: AbortSignal) =>
    api<NewsPageResponse>(
      `/news/manage?page=${targetPage}&pageSize=${pageSize}${statusParam}`,
      { signal },
    );
  const task = async ({ signal }: { signal: AbortSignal }) => {
    const result = await fetchPage(nextPage, signal);
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
    if (result.page <= lastPage) return result;

    const corrected = await fetchPage(lastPage, signal);
    const correctedLastPage = Math.max(
      1,
      Math.ceil(corrected.total / pageSize),
    );
    if (corrected.page > correctedLastPage) {
      throw new Error('动态列表在加载期间发生变化，请重试');
    }
    return corrected;
  };
  const callbacks = {
    commit(result: NewsPageResponse) {
      if (statusFilter.value !== requestedStatus) return;
      manageData.value = result;
      page.value = result.page;
      stableManagePage = result.page;
      manageLoaded.value = true;
    },
    onError(caught: unknown) {
      if (statusFilter.value === requestedStatus) {
        page.value = stableManagePage;
        manageError.value = formatError(caught, '动态列表加载失败');
      }
    },
  };
  return listRequests.runLatest(task, callbacks);
}

/** 变更后刷新列表；reloadManage 会在同一请求世代内纠正越界页。 */
async function reloadManageAfterMutation() {
  await reloadManage();
}

/* ---------- 编辑器引用（上传进行中禁止提交） ---------- */

const editorRef = ref<InstanceType<typeof RichTextEditor>>();
const editorUploading = computed(() => editorRef.value?.uploading ?? false);

/* ---------- 未保存保护 ---------- */

async function allowSwitch() {
  if (!dirty.value) return true;
  return confirm({
    title: '放弃未保存修改',
    body: '当前动态还有未保存内容。继续会丢失这些修改，已上传但未保存引用的图片由服务端定期回收。',
    confirmText: '放弃修改',
    danger: true,
  });
}

// 路由离开守卫（在 /admin 路由记录上注册，离开管理后台时触发）
onBeforeRouteLeave(() => allowSwitch());

// 浏览器刷新/关闭：仅 dirty 时拦截，卸载时移除监听
function onBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
}
watch(dirty, (isDirty) => {
  if (isDirty) window.addEventListener('beforeunload', onBeforeUnload);
  else window.removeEventListener('beforeunload', onBeforeUnload);
});
onBeforeUnmount(() =>
  window.removeEventListener('beforeunload', onBeforeUnload),
);

// 管理后台 Tab 切换守卫
const tabGuards = inject(adminTabGuardKey, null);
onMounted(() => {
  tabGuards?.register('news', allowSwitch);
  void reloadManage();
});
onBeforeUnmount(() => tabGuards?.unregister('news'));

/* ---------- 列表交互（切换前均需通过未保存保护） ---------- */

async function startNew() {
  if (busy.value || actionBusy.value) return;
  if (!(await allowSwitch())) return;
  cancelDetailLoad();
  archivedRecord.value = null;
  resetForm();
}

async function setFilter(value: StatusFilter) {
  if (value === statusFilter.value) return;
  if (manageLoading.value || busy.value || actionBusy.value) return;
  if (!(await allowSwitch())) return;
  const previousFilter = statusFilter.value;
  statusFilter.value = value;
  const result = await reloadManage(1, true);
  if (statusFilter.value !== value) return;
  if (result.status !== 'committed') {
    statusFilter.value = previousFilter;
    return;
  }
  cancelDetailLoad();
  archivedRecord.value = null;
  resetForm();
}

async function goPage(next: number) {
  if (
    next === page.value
    || manageLoading.value
    || busy.value
    || actionBusy.value
  ) return;
  if (!(await allowSwitch())) return;
  const result = await reloadManage(next, true);
  if (result.status !== 'committed') return;
  cancelDetailLoad();
  archivedRecord.value = null;
  resetForm();
}

async function openRecord(record: NewsSummary) {
  if (busy.value || actionBusy.value || loadingRecordId.value) return;
  if (record.id === editingId.value || record.id === archivedRecord.value?.id)
    return;
  if (!(await allowSwitch())) return;
  loadingRecordId.value = record.id;
  error.value = '';
  archivedError.value = '';
  await detailRequests.runLatest(
    ({ signal }) => api<NewsItem>(`/news/manage/${record.id}`, { signal }),
    {
      commit(detail) {
        if (loadingRecordId.value !== record.id) return;
        if (detail.status === 'ARCHIVED') {
          resetForm();
          archivedRecord.value = detail;
        } else {
          archivedRecord.value = null;
          applyRecord(detail);
        }
      },
      onError(caught) {
        if (loadingRecordId.value === record.id) {
          toast.error(formatError(caught, '动态加载失败'));
        }
      },
      onFinally() {
        if (loadingRecordId.value === record.id) loadingRecordId.value = '';
      },
    },
  );
}

/* ---------- 保存 / 发布 / 撤回为草稿 ---------- */

function mutationError(caught: unknown, fallback: string) {
  if (caught instanceof ApiClientError && caught.status === 409) {
    conflict.value = true;
    error.value = '内容已被其他人修改或删除，本地内容未被覆盖。';
    return;
  }
  error.value = formatError(caught, fallback);
}

async function submit() {
  if (busy.value || actionBusy.value) return;
  if (editorUploading.value) {
    error.value = '图片仍在上传中，请等待完成后再提交';
    return;
  }
  if (!body.value.trim()) {
    error.value = '请填写动态正文';
    return;
  }
  busy.value = true;
  error.value = '';
  conflict.value = false;
  try {
    if (editingId.value) {
      const wasPublished = editingStatus.value === 'PUBLISHED';
      const payload: NewsUpdateRequest = {
        title: title.value,
        summary: summary.value,
        body: body.value,
        visibility: visibility.value,
        status: status.value,
        expectedUpdatedAt: baselineUpdatedAt.value || undefined,
      };
      const result = await api<NewsMutationResult>(
        `/news/${editingId.value}`,
        { method: 'PATCH', body: JSON.stringify(payload) },
      );
      editingStatus.value = result.status;
      baselineUpdatedAt.value = result.updatedAt;
      savedSnapshot.value = formSnapshot();
      invalidateNewsDetail(result.id);
      toast.success(
        status.value === 'DRAFT'
          ? wasPublished
            ? '已撤回为草稿'
            : '草稿已保存'
          : '动态已发布',
      );
    } else {
      const payload: NewsWriteRequest = {
        title: title.value,
        summary: summary.value,
        body: body.value,
        visibility: visibility.value,
        status: status.value,
      };
      const result = await api<NewsMutationResult>('/news', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      // 创建成功后保持在编辑状态，发布后仍可继续管理
      editingId.value = result.id;
      editingStatus.value = result.status;
      baselineUpdatedAt.value = result.updatedAt;
      savedSnapshot.value = formSnapshot();
      invalidateNewsDetail(result.id);
      toast.success(
        status.value === 'DRAFT' ? '草稿已创建' : '动态已发布',
      );
    }
    await reloadManageAfterMutation();
  } catch (caught) {
    mutationError(caught, '动态保存失败，请稍后重试');
  } finally {
    busy.value = false;
  }
}

/** 409 后重新加载服务器版本；本地有未保存内容时先确认 */
async function reloadServerVersion() {
  const id = editingId.value;
  if (!id || busy.value) return;
  if (dirty.value) {
    const ok = await confirm({
      title: '重新加载服务器版本',
      body: '重新加载会放弃当前未保存的本地修改，且无法恢复。确定继续吗？',
      confirmText: '放弃本地修改并加载',
      danger: true,
    });
    if (!ok) return;
  }
  busy.value = true;
  await detailRequests.runLatest(
    ({ signal }) => api<NewsItem>(`/news/manage/${id}`, { signal }),
    {
      commit(detail) {
        if (editingId.value !== id) return;
        archivedRecord.value = null;
        if (detail.status === 'ARCHIVED') {
          resetForm();
          archivedRecord.value = detail;
        } else {
          applyRecord(detail);
        }
        toast.info('已加载服务器最新版本');
      },
      onError(caught) {
        if (editingId.value !== id) return;
        // 重新加载失败不代表冲突已消失：保留冲突入口，仅更新错误说明。
        error.value =
          caught instanceof ApiClientError && caught.status === 404
            ? '该动态已被删除，无法重新加载'
            : formatError(caught, '重新加载失败，请稍后重试');
      },
      onFinally() {
        if (editingId.value === id) busy.value = false;
      },
    },
  );
}

/* ---------- 归档 / 恢复 / 删除 ---------- */

async function archiveRecord() {
  const id = editingId.value;
  if (!id || actionBusy.value || busy.value) return;
  const ok = await confirm({
    title: '归档动态',
    body: dirty.value
      ? '当前还有未保存的修改，归档将丢弃这些修改；归档后动态不再对外显示，只能恢复为草稿或删除。确定归档吗？'
      : '归档后动态不再对外显示，只能恢复为草稿或删除。确定归档吗？',
    confirmText: '归档',
    danger: true,
  });
  if (!ok) return;
  actionBusy.value = 'archive';
  error.value = '';
  conflict.value = false;
  try {
    await api(`/news/${id}/archive`, {
      method: 'PATCH',
      body: JSON.stringify({
        expectedUpdatedAt: baselineUpdatedAt.value || undefined,
      }),
    });
    toast.success('动态已归档');
    invalidateNewsDetail(id);
    resetForm();
    await reloadManageAfterMutation();
  } catch (caught) {
    mutationError(caught, '归档失败，请稍后重试');
  } finally {
    actionBusy.value = '';
  }
}

async function reloadArchivedDetail() {
  const record = archivedRecord.value;
  if (!record || actionBusy.value || loadingRecordId.value) return;
  loadingRecordId.value = record.id;
  await detailRequests.runLatest(
    ({ signal }) => api<NewsItem>(`/news/manage/${record.id}`, { signal }),
    {
      commit(detail) {
        if (archivedRecord.value?.id !== record.id) return;
        archivedRecord.value = detail;
        archivedError.value = '';
      },
      onError(caught) {
        if (archivedRecord.value?.id === record.id) {
          archivedError.value = formatError(caught, '重新加载失败，请稍后重试');
        }
      },
      onFinally() {
        if (loadingRecordId.value === record.id) loadingRecordId.value = '';
      },
    },
  );
}

async function restoreRecord() {
  const record = archivedRecord.value;
  if (!record || actionBusy.value || loadingRecordId.value) return;
  const ok = await confirm({
    title: '恢复为草稿',
    body: '恢复后动态回到草稿状态，可以重新编辑和发布。确定恢复吗？',
    confirmText: '恢复为草稿',
  });
  if (!ok) return;
  actionBusy.value = 'restore';
  archivedError.value = '';
  try {
    await api(`/news/${record.id}/restore`, {
      method: 'PATCH',
      body: JSON.stringify({
        expectedUpdatedAt: record.updatedAt ?? undefined,
      }),
    });
    toast.success('已恢复为草稿');
    invalidateNewsDetail(record.id);
    archivedRecord.value = null;
    await reloadManageAfterMutation();
  } catch (caught) {
    archivedError.value =
      caught instanceof ApiClientError && caught.status === 409
        ? '内容已被其他人修改或删除，请重新加载后再试。'
        : formatError(caught, '恢复失败，请稍后重试');
  } finally {
    actionBusy.value = '';
  }
}

async function deleteRecord() {
  const targetId = archivedRecord.value?.id ?? editingId.value;
  if (!targetId || actionBusy.value || busy.value || loadingRecordId.value) return;
  const ok = await confirm({
    title: '删除动态',
    body: '删除后动态将从所有列表移除，且无法在后台恢复。确定删除吗？',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  actionBusy.value = 'delete';
  error.value = '';
  archivedError.value = '';
  try {
    await api(`/news/${targetId}`, { method: 'DELETE' });
    toast.success('动态已删除');
    invalidateNewsDetail(targetId);
    archivedRecord.value = null;
    resetForm();
    await reloadManageAfterMutation();
  } catch (caught) {
    const message =
      caught instanceof ApiClientError && caught.status === 409
        ? '内容已被其他人修改或删除，请刷新列表后再试。'
        : formatError(caught, '删除失败，请稍后重试');
    if (archivedRecord.value) archivedError.value = message;
    else error.value = message;
  } finally {
    actionBusy.value = '';
  }
}
</script>

<template>
  <section aria-label="动态管理" class="news-section">
    <aside class="manage-panel" aria-label="可管理动态列表">
      <div class="panel-heading">
        <div>
          <h2>动态列表</h2>
          <p>{{ auth.isAdmin ? '显示全部作者的动态。' : '显示你创建的动态。' }}</p>
        </div>
        <button
          type="button"
          class="icon-button small"
          aria-label="刷新动态列表"
          :disabled="manageLoading"
          @click="reloadManage()"
        >
          <RotateCw :size="16" aria-hidden="true" />
        </button>
      </div>

      <div class="status-tabs" role="group" aria-label="按状态筛选">
        <button
          v-for="tab in statusTabs"
          :key="tab.label"
          type="button"
          class="status-tab"
          :class="{ active: statusFilter === tab.value }"
          :aria-pressed="statusFilter === tab.value"
          :disabled="manageLoading || busy || Boolean(actionBusy)"
          @click="setFilter(tab.value)"
        >
          {{ tab.label }}
        </button>
      </div>

      <button
        type="button"
        class="button secondary new-button"
        :disabled="busy || Boolean(loadingRecordId) || Boolean(actionBusy)"
        @click="startNew"
      >
        <FilePlus2 :size="16" aria-hidden="true" />
        新建动态
      </button>

      <SkeletonBlock v-if="manageLoading && !manageData" :lines="4" />
      <ErrorState
        v-else-if="manageError && !manageData"
        :message="manageError"
        retry-label="重试加载列表"
        @retry="reloadManage()"
      />
      <EmptyState
        v-else-if="manageLoaded && !records.length"
        title="暂无动态"
        hint="当前筛选下没有可管理的动态"
      />
      <template v-else>
        <p v-if="manageError" class="alert error" role="alert">
          {{ manageError }}
          <button type="button" class="alert-retry" @click="reloadManage()">
            重试
          </button>
        </p>
        <div class="record-list" :aria-busy="manageLoading || undefined">
          <button
            v-for="record in records"
            :key="record.id"
            type="button"
            class="record-item"
            :class="{
              active:
                editingId === record.id || archivedRecord?.id === record.id,
            }"
            :aria-current="
              editingId === record.id || archivedRecord?.id === record.id
                ? 'true'
                : undefined
            "
            :disabled="Boolean(loadingRecordId)"
            @click="openRecord(record)"
          >
            <span class="record-title-row">
              <strong>{{ record.title }}</strong>
              <StatusBadge
                :text="statusLabels[record.status]"
                :tone="statusTones[record.status]"
              />
            </span>
            <span class="record-summary">{{ record.summary || '无摘要' }}</span>
            <span class="record-meta">
              <span>{{ record.author.displayName }}</span>
              <span v-if="record.visibility === 'MEMBERS'">成员可见</span>
              <time :datetime="record.updatedAt ?? record.createdAt">{{
                formatDateTime(record.updatedAt ?? record.createdAt)
              }}</time>
            </span>
          </button>
        </div>
        <PaginationControl
          :page="page"
          :page-count="pageCount"
          @update:page="goPage"
        />
      </template>
    </aside>

    <!-- 已归档：只读面板，只允许恢复为草稿或删除 -->
    <div v-if="archivedRecord" class="form archived-panel">
      <div class="form-heading">
        <div>
          <h2>已归档动态</h2>
          <p>已归档动态不能直接编辑或发布，可恢复为草稿后再操作。</p>
        </div>
        <StatusBadge text="已归档" tone="muted" />
      </div>
      <p v-if="archivedError" class="alert error" role="alert">
        {{ archivedError }}
      </p>
      <h3 class="archived-title">{{ archivedRecord.title }}</h3>
      <p class="archived-summary">{{ archivedRecord.summary || '无摘要' }}</p>
      <div class="meta archived-meta">
        <span>{{ archivedRecord.author.displayName }}</span>
        <StatusBadge
          v-if="archivedRecord.visibility === 'MEMBERS'"
          text="成员可见"
          tone="accent"
        />
        <time :datetime="archivedRecord.updatedAt ?? undefined">{{
          formatDateTime(archivedRecord.updatedAt)
        }}</time>
      </div>
      <div class="archived-actions">
        <button
          type="button"
          class="button secondary"
          :disabled="Boolean(actionBusy) || Boolean(loadingRecordId)"
          @click="restoreRecord"
        >
          <ArchiveRestore :size="16" aria-hidden="true" />
          {{ actionBusy === 'restore' ? '正在恢复…' : '恢复为草稿' }}
        </button>
        <button
          type="button"
          class="button ghost"
          :disabled="Boolean(actionBusy) || Boolean(loadingRecordId)"
          @click="reloadArchivedDetail"
        >
          重新加载
        </button>
        <button
          type="button"
          class="button danger"
          :disabled="Boolean(actionBusy) || Boolean(loadingRecordId)"
          @click="deleteRecord"
        >
          <Trash2 :size="16" aria-hidden="true" />
          {{ actionBusy === 'delete' ? '正在删除…' : '删除动态' }}
        </button>
      </div>
    </div>

    <form v-else class="form news-form" @submit.prevent="submit">
      <div class="form-heading">
        <div>
          <h2>
            {{
              editingId
                ? editingStatus === 'PUBLISHED'
                  ? '编辑已发布动态'
                  : '编辑草稿'
                : '新建动态'
            }}
          </h2>
          <p v-if="editingStatus === 'PUBLISHED'">
            保存会同步更新已发布内容；选择“存为草稿”提交可撤回发布。
          </p>
          <p v-else-if="editingId">
            保存会更新当前草稿；选择“立即发布”后对外可见。
          </p>
        </div>
        <span v-if="dirty" class="unsaved-indicator" role="status"
          >有未保存修改</span
        >
      </div>

      <div v-if="conflict" class="alert error conflict-box" role="alert">
        <p>{{ error }}</p>
        <button
          type="button"
          class="button secondary"
          :disabled="busy"
          @click="reloadServerVersion"
        >
          重新加载服务器版本
        </button>
      </div>
      <p v-else-if="error" class="alert error" role="alert">{{ error }}</p>

      <div class="field">
        <label for="news-title">标题</label>
        <input
          id="news-title"
          v-model="title"
          required
          minlength="2"
          maxlength="160"
        />
      </div>
      <div class="field">
        <label for="news-summary">摘要</label>
        <input id="news-summary" v-model="summary" maxlength="300" />
        <p class="field-hint">列表页只展示摘要，正文在详情中阅读。</p>
      </div>
      <div class="field">
        <label for="news-body">正文</label>
        <RichTextEditor ref="editorRef" v-model="body" />
        <p v-if="editorUploading" class="field-hint" role="status">
          图片仍在上传中，完成后才能提交。
        </p>
      </div>
      <div class="form-row">
        <div class="field">
          <label for="news-visibility">可见范围</label>
          <select id="news-visibility" v-model="visibility">
            <option value="MEMBERS">成员可见</option>
            <option value="PUBLIC">公开</option>
          </select>
        </div>
        <div class="field">
          <label for="news-status">发布状态</label>
          <select id="news-status" v-model="status">
            <option value="PUBLISHED">立即发布</option>
            <option value="DRAFT">存为草稿</option>
          </select>
          <p
            v-if="editingStatus === 'PUBLISHED' && status === 'DRAFT'"
            class="field-hint"
          >
            提交后该动态将撤回为草稿，不再对外显示。
          </p>
        </div>
      </div>

      <div class="form-actions">
        <button
          class="button submit-button"
          type="submit"
          :disabled="
            busy ||
            Boolean(loadingRecordId) ||
            Boolean(actionBusy) ||
            editorUploading
          "
        >
          {{
            busy
              ? '正在提交…'
              : status === 'DRAFT'
                ? editingStatus === 'PUBLISHED'
                  ? '撤回为草稿'
                  : '保存草稿'
                : editingStatus === 'PUBLISHED'
                  ? '保存修改'
                  : '发布动态'
          }}
        </button>
        <template v-if="editingId">
          <button
            type="button"
            class="button secondary"
            :disabled="busy || Boolean(actionBusy) || Boolean(loadingRecordId)"
            @click="archiveRecord"
          >
            <Archive :size="16" aria-hidden="true" />
            {{ actionBusy === 'archive' ? '正在归档…' : '归档' }}
          </button>
          <button
            type="button"
            class="button danger"
            :disabled="busy || Boolean(actionBusy) || Boolean(loadingRecordId)"
            @click="deleteRecord"
          >
            <Trash2 :size="16" aria-hidden="true" />
            {{ actionBusy === 'delete' ? '正在删除…' : '删除' }}
          </button>
        </template>
      </div>
    </form>
  </section>
</template>

<style scoped>
.news-section {
  display: grid;
  grid-template-columns: minmax(230px, 300px) minmax(0, 1fr);
  gap: var(--space-8);
  align-items: start;
}

.manage-panel,
.news-form,
.archived-panel {
  min-width: 0;
}

.panel-heading,
.form-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.panel-heading h2,
.form-heading h2 {
  margin: 0;
  font-size: 18px;
}

.panel-heading p,
.form-heading p {
  margin: var(--space-1) 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.status-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-4);
}

.status-tab {
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--ink-soft);
  font-size: 12px;
  cursor: pointer;
}

.status-tab:hover {
  border-color: var(--border-strong);
}

.status-tab.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-weight: 600;
}

.new-button {
  width: 100%;
  margin: var(--space-4) 0;
}

.record-list {
  display: grid;
  border-top: 1px solid var(--border);
}

.record-item {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-4) var(--space-3);
  border: 0;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
}

.record-item:hover:not(:disabled) {
  background: var(--surface-tint);
}

.record-item.active {
  border-left-color: var(--accent);
  background: var(--accent-soft);
}

.record-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.record-title-row strong,
.record-summary {
  overflow-wrap: anywhere;
}

.record-title-row strong {
  min-width: 0;
}

.record-summary,
.record-meta {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.record-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}

.unsaved-indicator {
  flex: none;
  color: var(--warning);
  font-size: 12px;
}

.conflict-box {
  display: grid;
  gap: var(--space-3);
  justify-items: start;
}

.conflict-box p {
  margin: 0;
}

.form-actions,
.archived-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.submit-button {
  width: fit-content;
}

.archived-title {
  margin: var(--space-5) 0 var(--space-2);
  font-size: 17px;
  overflow-wrap: anywhere;
}

.archived-summary {
  margin: 0 0 var(--space-3);
  color: var(--muted);
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.archived-meta {
  padding-bottom: var(--space-4);
  margin-bottom: var(--space-5);
  border-bottom: 1px solid var(--border);
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

@media (max-width: 800px) {
  .news-section {
    grid-template-columns: 1fr;
    gap: var(--space-6);
  }
}

@media (max-width: 560px) {
  .form-row {
    grid-template-columns: 1fr;
  }

  .form-heading {
    display: grid;
  }

  .submit-button,
  .form-actions .button {
    width: 100%;
  }
}
</style>
