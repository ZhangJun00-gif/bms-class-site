<script setup lang="ts">
import type {
  CreditHourLeaderboard,
  CreditHourSubmission,
  CreditHourType,
} from '@bmc3/contracts';
import {
  AlertTriangle,
  Download,
  ExternalLink,
  Eye,
  ListFilter,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ShieldX,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import BaseDialog from '../common/BaseDialog.vue';
import EmptyState from '../common/EmptyState.vue';
import { ApiClientError, api, apiUrl, formatError } from '../../lib/api';
import { useToast } from '../../composables/useToast';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { creditHourStatusLabel, loadCreditHourPages } from '../../composables/useCreditHourUi';
import ManualReviewNotice from '../credit-hours/ManualReviewNotice.vue';
import AdminCreditHourCreateDialog from './AdminCreditHourCreateDialog.vue';

type Pane = 'queue' | 'records' | 'overview' | 'runtime' | 'danger';
interface AdminCreditHourDetail extends CreditHourSubmission {
  reviewJobs: unknown[];
  decisionEvents: unknown[];
}

const toast = useToast();
const pane = ref<Pane>('queue');
const type = ref<CreditHourType>('QUALITY');
const status = ref('');
const keyword = ref('');
const queueMode = ref<'manual' | 'ai' | 'error'>('manual');
const listRequests = useLatestRequest();
const detailRequests = useLatestRequest();
const preflightRequests = useLatestRequest();
const records = ref<CreditHourSubmission[]>([]);
const detail = ref<AdminCreditHourDetail | null>(null);
const detailLoadingId = ref<string | null>(null);
const overview = ref<CreditHourLeaderboard | null>(null);
const runtime = ref<Record<string, unknown> | null>(null);
const preflight = ref<Record<string, unknown> | null>(null);
const loading = listRequests.loading;
const error = ref('');
const createOpen = ref(false);
const visibleRecords = computed(() => pane.value !== 'queue' || queueMode.value === 'manual' ? records.value : records.value.filter((item) => isAiError(item) === (queueMode.value === 'error')));
const actionItem = ref<CreditHourSubmission | null>(null);
const actionKind = ref<'retry' | 'reopen' | 'approve' | 'reject' | 'delete'>('approve');
const actionReason = ref('');
const actionBusy = ref(false);
const actionError = ref('');
const actionConflict = ref(false);
const actionLabels = { retry: '重试 AI', reopen: '重新审核', approve: '通过', reject: '拒绝', delete: '删除记录' };
function isAiError(item: CreditHourSubmission) { return ['FAILED', 'RETRY_PENDING'].includes(item.reviewJob?.status ?? ''); }
function canReopen(item: CreditHourSubmission) { return item.evidence.length > 0 && ['APPROVED', 'REJECTED', 'WITHDRAWN'].includes(item.status); }

const panes: Array<{ id: Pane; label: string }> = [
  { id: 'queue', label: '审核队列' },
  { id: 'records', label: '全部记录' },
  { id: 'overview', label: '学时总览' },
  { id: 'runtime', label: '运行状态' },
  { id: 'danger', label: '危险操作' },
];

onMounted(load);
watch([pane, type, queueMode], load);

async function load() {
  error.value = '';
  detailRequests.cancelLatest();
  detailLoadingId.value = null;
  detail.value = null;
  const requestedPane = pane.value;
  const parameters = new URLSearchParams({ type: type.value, pageSize: '100' });
  if (requestedPane === 'queue') parameters.set('status', queueMode.value === 'manual' ? 'PENDING_MANUAL_REVIEW' : 'PENDING_REVIEW');
  if (requestedPane === 'records') {
    if (status.value) parameters.set('status', status.value);
    if (keyword.value.trim()) parameters.set('keyword', keyword.value.trim());
  }
  await listRequests.runLatest(async ({ signal }) => {
    if (requestedPane === 'overview') return { kind: 'overview' as const, value: await loadCreditHourPages<CreditHourLeaderboard['items'][number]>('/admin/credit-hours/overview?pageSize=100', signal) };
    if (requestedPane === 'runtime') return { kind: 'runtime' as const, value: await api<Record<string, unknown>>('/admin/credit-hours/runtime', { signal }) };
    if (requestedPane === 'danger') return { kind: 'danger' as const };
    return { kind: 'records' as const, value: await loadCreditHourPages<CreditHourSubmission>(`/admin/credit-hours/submissions?${parameters}`, signal) };
  }, {
    commit(result) {
      if (result.kind === 'overview') overview.value = { type: 'TOTAL', ...result.value };
      else if (result.kind === 'runtime') runtime.value = result.value;
      else if (result.kind === 'danger') preflight.value = null;
      else records.value = result.value.items;
    },
    onError(caught) { error.value = formatError(caught, '学时管理数据加载失败'); },
  });
}

async function toggleDetail(item: CreditHourSubmission) {
  detailRequests.cancelLatest();
  if (detail.value?.id === item.id) {
    detail.value = null;
    return;
  }
  detail.value = null;
  detailLoadingId.value = item.id;
  await detailRequests.runLatest(({ signal }) => api<AdminCreditHourDetail>(`/admin/credit-hours/submissions/${item.id}`, { signal }), {
    commit(result) { detail.value = result; },
    onError(caught) { toast.error(formatError(caught, '管理详情加载失败')); },
    onFinally() { detailLoadingId.value = null; },
  });
}

async function action(
  item: CreditHourSubmission,
  kind: 'retry' | 'reopen' | 'approve' | 'reject' | 'delete',
) {
  if (actionBusy.value) return;
  actionItem.value = item;
  actionKind.value = kind;
  actionReason.value = '';
  actionError.value = '';
  actionConflict.value = false;
}

async function submitAction() {
  const item = actionItem.value;
  const kind = actionKind.value;
  if (!item || actionBusy.value || actionConflict.value) return;
  if (kind === 'reopen' && !canReopen(item)) { actionError.value = '记录已不是可重新审核的终态，请关闭后重新核对。'; return; }
  if (kind === 'retry' && (item.status !== 'PENDING_REVIEW' || !isAiError(item))) { actionError.value = '当前记录不属于可重试的 AI 异常，请关闭后重新核对。'; return; }
  if (!actionReason.value.trim()) { actionError.value = '请输入操作理由'; return; }
  const decision =
    kind === 'approve' ? 'APPROVED' : kind === 'reject' ? 'REJECTED' : null;
  const path = decision
    ? `/admin/credit-hours/submissions/${item.id}/decisions`
    : kind === 'retry'
      ? `/admin/credit-hours/submissions/${item.id}/ai-retry`
      : kind === 'reopen'
        ? `/admin/credit-hours/submissions/${item.id}/reopen`
        : `/admin/credit-hours/submissions/${item.id}/deletion`;
  actionBusy.value = true;
  actionError.value = '';
  try {
    await api(path, {
      method: 'POST',
      body: JSON.stringify({
        expectedRevision: item.revision,
        reason: actionReason.value.trim(),
        ...(decision ? { decision } : {}),
      }),
    });
    toast.success('操作已完成');
    actionItem.value = null;
    await load();
  } catch (caught) {
    actionConflict.value = caught instanceof ApiClientError && caught.status === 409;
    actionError.value = actionConflict.value ? '记录已更新，请刷新记录后核对并重新提交。操作理由已保留。' : formatError(caught, '操作失败');
  } finally { actionBusy.value = false; }
}

async function refreshAction() {
  if (!actionItem.value || actionBusy.value) return;
  actionBusy.value = true;
  try {
    actionItem.value = await api<CreditHourSubmission>(`/admin/credit-hours/submissions/${actionItem.value.id}`);
    actionConflict.value = false;
    actionError.value = '';
  } catch (caught) { actionError.value = formatError(caught, '刷新记录失败'); }
  finally { actionBusy.value = false; }
}

async function runPreflight() {
  await preflightRequests.runLatest(({ signal }) => api<Record<string, unknown>>('/admin/credit-hours/initializations/preflight', {
      method: 'POST',
      signal,
    }), { commit(result) { preflight.value = result; }, onError(caught) { toast.error(formatError(caught, '预检失败')); } });
}

async function openCreateDialog() {
  createOpen.value = true;
}
function onCreated(nextType: CreditHourType, count: number) {
  createOpen.value = false;
  const changed = pane.value !== 'records' || type.value !== nextType;
  pane.value = 'records'; type.value = nextType; status.value = ''; keyword.value = '';
  overview.value = null;
  toast.success(`已录入 ${count} 人并通过`);
  if (!changed) void load();
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

</script>

<template>
  <section class="credit-admin" aria-labelledby="credit-admin-heading">
    <div class="admin-heading">
      <div>
        <p>学时审核</p>
        <h2 id="credit-admin-heading">学时管理</h2>
      </div>
      <button type="button" class="button secondary create-button" @click="openCreateDialog">
        <UserPlus :size="17" aria-hidden="true" />为成员录入
      </button>
    </div>

    <div class="subtabs" role="tablist" aria-label="学时管理视图">
      <button v-for="item in panes" :key="item.id" type="button" role="tab" :aria-selected="pane === item.id" @click="pane = item.id">
        {{ item.label }}
      </button>
    </div>

    <div v-if="pane !== 'overview' && pane !== 'runtime' && pane !== 'danger'" class="filters">
      <label>类型<select v-model="type"><option value="QUALITY">素质学时</option><option value="VOLUNTEER">志愿学时</option></select></label>
      <label v-if="pane === 'queue'">审核阶段<select v-model="queueMode" aria-label="审核阶段"><option value="manual">待人工审核</option><option value="ai">AI 审核中</option><option value="error">AI 异常</option></select></label>
      <template v-if="pane === 'records'">
        <label>状态<select v-model="status" aria-label="记录状态"><option value="">全部</option><option value="PENDING_REVIEW">AI 审核中</option><option value="PENDING_MANUAL_REVIEW">待人工审核</option><option value="APPROVED">已通过</option><option value="REJECTED">未通过</option><option value="WITHDRAWN">已撤回</option></select></label>
        <label class="keyword">关键词<input v-model="keyword" maxlength="160" @keyup.enter="load" /></label>
        <button type="button" class="button secondary" @click="load"><ListFilter :size="16" aria-hidden="true" />筛选</button>
      </template>
    </div>

    <div v-if="error" class="admin-error" role="alert">{{ error }}<button type="button" class="button secondary" @click="load"><RefreshCw :size="16" aria-hidden="true" />重试</button></div>
    <div v-else-if="loading" class="admin-loading"><LoaderCircle :size="18" class="spin" aria-hidden="true" />加载中</div>

    <template v-else-if="pane === 'queue' || pane === 'records'">
      <p class="record-count">共 {{ visibleRecords.length }} 条记录</p>
      <EmptyState v-if="!visibleRecords.length" title="当前没有匹配记录" />
      <div v-else class="admin-table-wrap">
        <table>
          <thead><tr><th>成员 / 活动</th><th>类型</th><th>学时</th><th>状态 / 任务</th><th>操作</th></tr></thead>
          <tbody>
            <template v-for="item in visibleRecords" :key="item.id">
              <tr>
                <td><strong>{{ item.user.displayName }}</strong><span>{{ item.activityName }}</span><time>{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</time></td>
                <td>{{ item.type === 'QUALITY' ? '素质' : '志愿' }}</td>
                <td>{{ item.hours.toFixed(1) }}h</td>
                <td>
                  <strong :class="{ 'manual-status': item.status === 'PENDING_MANUAL_REVIEW' }">{{ creditHourStatusLabel(item.status) }}</strong>
                  <span v-if="item.manualReview?.reason" class="risk-reason">{{ item.manualReview.reason }}</span>
                  <span v-if="!item.evidence.length">管理员录入 · 无 AI 任务</span>
                  <span v-else>{{ item.reviewJob?.status ?? '-' }} · {{ item.reviewJob?.attempts ?? 0 }} 次</span>
                </td>
                <td class="commands">
                  <button type="button" :title="detail?.id === item.id ? '收起详情' : '查看详情'" :aria-label="detail?.id === item.id ? '收起详情' : '查看详情'" @click="toggleDetail(item)"><LoaderCircle v-if="detailLoadingId === item.id" :size="16" class="spin" /><Eye v-else :size="16" /></button>
                  <button v-if="item.evidence.length && item.status === 'PENDING_REVIEW' && isAiError(item)" type="button" title="重试 AI" aria-label="重试 AI" :disabled="actionBusy" @click="action(item, 'retry')"><RefreshCw :size="16" /></button>
                  <button v-if="canReopen(item)" type="button" title="重新审核" aria-label="重新打开" :disabled="actionBusy" @click="action(item, 'reopen')"><RotateCcw :size="16" /></button>
                  <button type="button" title="通过" aria-label="通过" :disabled="actionBusy" @click="action(item, 'approve')"><ShieldCheck :size="16" /></button>
                  <button type="button" title="拒绝" aria-label="拒绝" :disabled="actionBusy" @click="action(item, 'reject')"><ShieldX :size="16" /></button>
                  <button type="button" class="danger-command" title="删除记录" aria-label="删除记录" :disabled="actionBusy" @click="action(item, 'delete')"><Trash2 :size="16" /></button>
                </td>
              </tr>
              <tr v-if="detail?.id === item.id" class="detail-row">
                <td colspan="5">
                  <div class="detail-fields">
                    <p><strong>来源说明</strong>{{ detail.sourceDescription }}</p>
                    <p><strong>最终理由</strong>{{ detail.decisionReason ?? '尚无最终决定' }}</p>
                  </div>
                  <ManualReviewNotice v-if="detail.status === 'PENDING_MANUAL_REVIEW'" :review="detail.manualReview" />
                  <div v-if="detail.evidence.length" class="admin-evidence-grid">
                    <figure v-for="evidence in detail.evidence" :key="evidence.id">
                      <img :src="evidence.displayUrl" alt="学时凭证展示图" />
                      <a :href="apiUrl(`/admin/credit-hours/evidence/${evidence.id}/original`)" target="_blank" rel="noopener" title="受审计打开原图"><ExternalLink :size="15" aria-hidden="true" />原图</a>
                    </figure>
                  </div>
                  <p v-else class="no-evidence"><ShieldCheck :size="17" aria-hidden="true" />管理员直接录入，无需凭证及 AI 审核</p>
                  <details><summary>审核轮次与决定事件</summary><pre>{{ formatJson({ reviewJobs: detail.reviewJobs, decisionEvents: detail.decisionEvents }) }}</pre></details>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="pane === 'overview'">
      <div class="overview-heading">
        <div><Users :size="19" aria-hidden="true" /><span>总学时低到高</span></div>
        <a class="button secondary export-button" :href="apiUrl('/admin/credit-hours/exports/approved.zip')" download>
          <Download :size="16" aria-hidden="true" />导出总榜与已通过记录
        </a>
      </div>
      <div class="admin-table-wrap">
        <table class="overview-table">
          <thead><tr><th>成员</th><th>总学时</th></tr></thead>
          <tbody><tr v-for="item in overview?.items" :key="item.userId"><td>{{ item.displayName }}</td><td><strong>{{ item.totalHours.toFixed(1) }}h</strong></td></tr></tbody>
        </table>
      </div>
    </template>

    <template v-else-if="pane === 'runtime'">
      <div class="runtime-band"><RefreshCw :size="20" aria-hidden="true" /><div><strong>审核任务与临时文件清理</strong><p>仅显示计数，不返回提供商文件 ID 或对象 key。</p></div></div>
      <pre>{{ formatJson(runtime) }}</pre>
    </template>

    <template v-else>
      <div class="danger-band"><AlertTriangle :size="22" aria-hidden="true" /><div><strong>全部初始化受运维门禁保护</strong><p>本页面只允许执行只读预检；API 不会运行 root 备份或直接清空数据。</p></div></div>
      <button type="button" class="button secondary" :disabled="preflightRequests.loading.value" @click="runPreflight">执行只读预检</button>
      <pre v-if="preflight">{{ formatJson(preflight) }}</pre>
    </template>
  </section>

  <AdminCreditHourCreateDialog :open="createOpen" @close="createOpen = false" @saved="onCreated" />
  <BaseDialog :open="Boolean(actionItem)" :title="actionLabels[actionKind]" :dismissable="!actionBusy" @close="actionItem = null">
    <p>{{ actionItem?.user.displayName }} · {{ actionItem?.activityName }} · {{ actionItem?.hours }} 小时</p>
    <p v-if="actionKind === 'reopen'">将开始新的审核轮次。</p>
    <p v-if="actionKind === 'delete'">删除后记录退出学时统计。</p>
    <p v-if="actionError" class="alert error" role="alert">{{ actionError }}</p>
    <form id="credit-hour-decision" @submit.prevent="submitAction"><label for="credit-action-reason">操作理由</label><textarea id="credit-action-reason" v-model="actionReason" rows="4" maxlength="2000" required :disabled="actionBusy" /></form>
    <template #footer><button v-if="actionConflict" type="button" class="button secondary" :disabled="actionBusy" @click="refreshAction">刷新记录</button><button type="submit" form="credit-hour-decision" class="button" :disabled="actionBusy || actionConflict">{{ actionBusy ? '正在提交' : actionLabels[actionKind] }}</button></template>
  </BaseDialog>
</template>

<style scoped>
.credit-admin { min-width: 0; }
.manual-status { color: #86600f; }.risk-reason { max-width: 300px; white-space: pre-wrap; overflow-wrap: anywhere; } time, .record-count { color: var(--muted); font-size: 12px; }
#credit-action-reason { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; }
.admin-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 18px; }
.admin-heading p { margin: 0 0 3px; color: var(--accent-dark); font-size: 12px; font-weight: 700; }
.admin-heading h2 { margin: 0; font-size: 22px; letter-spacing: 0; }
.create-button { flex: none; }
.subtabs { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 1px; border-bottom: 1px solid var(--border); }
.subtabs button { flex: none; min-height: 40px; padding: 0 14px; border: 0; border-bottom: 3px solid transparent; background: transparent; color: var(--muted); cursor: pointer; }
.subtabs button[aria-selected='true'] { border-bottom-color: var(--accent); color: var(--primary-dark); font-weight: 650; }
.filters { display: flex; align-items: end; gap: 12px; padding: 18px 0; flex-wrap: wrap; }
.filters label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
.filters select, .filters input { min-width: 150px; height: 40px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-s); background: var(--surface); color: var(--ink); }
.filters .keyword { flex: 1; }.filters .keyword input { width: 100%; box-sizing: border-box; }
.admin-table-wrap { overflow-x: auto; margin-top: 16px; border: 1px solid var(--border); border-radius: var(--radius-s); }
table { width: 100%; min-width: 720px; border-collapse: collapse; }
.overview-table { min-width: 360px; }
th, td { padding: 12px; border-bottom: 1px solid var(--border); text-align: left; }
tr:last-child td { border-bottom: 0; }
td strong, td span { display: block; } td span { margin-top: 3px; color: var(--muted); font-size: 12px; }
.commands { white-space: nowrap; }.commands button { width: 34px; height: 34px; display: inline-grid; place-items: center; margin-right: 5px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface); color: var(--primary); cursor: pointer; }.commands .danger-command { color: var(--danger); }
.detail-row td { padding: 16px; background: var(--surface-muted); }
.detail-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.detail-fields p { margin: 0; color: var(--ink-soft); white-space: pre-wrap; }.detail-fields strong { display: block; margin-bottom: 5px; color: var(--ink); }
.admin-evidence-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 14px; }
.admin-evidence-grid figure { margin: 0; }.admin-evidence-grid img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border: 1px solid var(--border); border-radius: var(--radius-s); }.admin-evidence-grid a { display: inline-flex; align-items: center; gap: 5px; margin-top: 5px; color: var(--primary); font-size: 12px; }
.detail-row details { margin-top: 14px; }.detail-row summary { cursor: pointer; color: var(--primary); font-weight: 650; }
.no-evidence { display: flex; align-items: center; gap: 8px; margin: 14px 0 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface); color: var(--ink-soft); }
.overview-heading, .runtime-band, .danger-band { display: flex; align-items: center; gap: 12px; margin-top: 18px; padding: 16px 0; border-bottom: 1px solid var(--border); }
.overview-heading { justify-content: space-between; flex-wrap: wrap; }
.overview-heading > div { display: flex; align-items: center; gap: 10px; }
.export-button { text-decoration: none; }
.runtime-band p, .danger-band p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.danger-band { color: var(--danger); }.danger-band p { color: var(--ink-soft); }
pre { max-height: 420px; overflow: auto; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-muted); color: var(--ink-soft); font-size: 12px; white-space: pre-wrap; }
.admin-loading, .admin-error { min-height: 120px; display: flex; align-items: center; justify-content: center; gap: 9px; }.admin-error { justify-content: space-between; color: var(--danger); }
.spin { animation: spin 0.8s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) { .admin-heading { align-items: flex-end; }.create-button { padding-inline: 10px; }.filters { display: grid; grid-template-columns: 1fr 1fr; }.filters label, .filters select, .filters input, .filters .keyword { min-width: 0; width: 100%; }.filters .keyword, .filters .button { grid-column: 1 / -1; }.detail-fields { grid-template-columns: 1fr; } }
@media (max-width: 768px) { .admin-table-wrap:not(:has(.overview-table)) table { min-width: 0; } .admin-table-wrap:not(:has(.overview-table)) thead { display: none; } .admin-table-wrap:not(:has(.overview-table)) tr { display: grid; grid-template-columns: 1fr; border-bottom: 1px solid var(--border); } .admin-table-wrap:not(:has(.overview-table)) td { border: 0; min-width: 0; padding: 7px 12px; overflow-wrap: anywhere; } .commands { white-space: normal; } .detail-fields { grid-template-columns: 1fr; } .risk-reason { max-width: none; } }
</style>
