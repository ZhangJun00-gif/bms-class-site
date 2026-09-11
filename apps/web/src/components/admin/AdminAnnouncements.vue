<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { Copy, Eye, FilePlus2, RefreshCw, Save, Send, Trash2, Undo2 } from 'lucide-vue-next';
import type { Announcement, AnnouncementPage, AnnouncementStatus, AnnouncementSummary } from '@bmc3/contracts';
import BaseDialog from '../common/BaseDialog.vue';
import EmptyState from '../common/EmptyState.vue';
import { ApiClientError, api, formatError } from '../../lib/api';
import { adminTabGuardKey } from '../../lib/adminTabGuard';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useAnnouncementsStore } from '../../stores/announcements';
import { useAuthStore } from '../../stores/auth';

const { confirm } = useConfirm();
const notices = useAnnouncementsStore();
const auth = useAuthStore();
let sessionGeneration = 0;
let identity = `${auth.user?.id ?? ''}:${auth.user?.role ?? ''}`;
const list = useLatestRequest();
const reader = useLatestRequest();
const items = ref<AnnouncementSummary[]>([]);
const cursor = ref<string | null>(null);
const filter = ref<AnnouncementStatus | ''>('');
const keyword = ref('');
const selected = ref<Announcement | null>(null);
const title = ref('');
const body = ref('');
const baseline = ref('');
const error = ref('');
const listError = ref('');
const conflict = ref(false);
const busy = ref(false);
const preview = ref(false);
const canEdit = computed(() => !selected.value || selected.value.status === 'DRAFT');
const snapshot = () => JSON.stringify({ title: title.value, body: body.value });
baseline.value = snapshot();
const dirty = computed(() => canEdit.value && snapshot() !== baseline.value);
const statusLabel = (value: AnnouncementStatus) => ({ DRAFT: '草稿', PUBLISHED: '已发布', WITHDRAWN: '已撤回' }[value]);

async function load(append = false) {
  listError.value = '';
  const params = new URLSearchParams({ pageSize: '20' });
  if (filter.value) params.set('status', filter.value);
  if (keyword.value.trim()) params.set('keyword', keyword.value.trim());
  if (append && cursor.value) params.set('cursor', cursor.value);
  await list.runLatest(({ signal }) => api<AnnouncementPage>(`/admin/announcements?${params}`, { signal }), {
    commit(result) { items.value = append ? [...items.value, ...result.items] : result.items; cursor.value = result.nextCursor; },
    onError(caught) { listError.value = formatError(caught, '公告列表加载失败'); },
  });
}
function apply(item: Announcement) { selected.value = item; title.value = item.title; body.value = item.body; baseline.value = snapshot(); conflict.value = false; error.value = ''; }
async function allowLeave() {
  if (busy.value) return false;
  const generation = sessionGeneration;
  const accepted = !dirty.value || await confirm({ title: '放弃未保存公告', body: '当前正文尚未保存。', confirmText: '放弃修改', danger: true });
  return generation === sessionGeneration && accepted;
}
async function open(id: string, force = false) {
  if (busy.value || (!force && !(await allowLeave()))) return;
  error.value = '';
  await reader.runLatest(({ signal }) => api<Announcement>(`/admin/announcements/${encodeURIComponent(id)}`, { signal }), {
    commit: apply,
    onError(caught) { error.value = formatError(caught, '公告加载失败'); },
  });
}
async function startNew() {
  if (!(await allowLeave())) return;
  reader.cancelLatest(); selected.value = null; title.value = ''; body.value = ''; baseline.value = snapshot(); error.value = ''; conflict.value = false;
}
function copyDraft() {
  if (busy.value || !selected.value) return;
  selected.value = null; baseline.value = JSON.stringify({ title: '', body: '' }); error.value = ''; conflict.value = false;
}
async function save() {
  if (busy.value || !canEdit.value || conflict.value || reader.loading.value) return;
  if (!title.value.trim() || !body.value.trim()) { error.value = '请填写公告标题和正文'; return; }
  busy.value = true; error.value = '';
  const generation = sessionGeneration;
  const record = selected.value;
  try {
    const result = await api<Announcement>(record ? `/admin/announcements/${record.id}` : '/admin/announcements', {
      method: record ? 'PATCH' : 'POST',
      body: JSON.stringify({ title: title.value.trim(), body: body.value.trim(), ...(record ? { expectedRevision: record.revision } : {}) }),
    });
    if (generation !== sessionGeneration) return;
    apply(result); await load();
  } catch (caught) {
    if (generation !== sessionGeneration) return;
    conflict.value = caught instanceof ApiClientError && caught.status === 409;
    error.value = conflict.value ? '公告已由其他管理员更新。当前正文已保留，请重新载入后核对。' : formatError(caught, '保存失败');
  } finally { if (generation === sessionGeneration) busy.value = false; }
}
async function publish() {
  const record = selected.value;
  if (!record || record.status !== 'DRAFT' || busy.value || dirty.value || conflict.value) return;
  busy.value = true; error.value = '';
  const generation = sessionGeneration;
  try {
    const result = await api<Announcement>(`/admin/announcements/${record.id}/publish`, { method: 'POST', body: JSON.stringify({ expectedRevision: record.revision }) });
    if (generation !== sessionGeneration) return;
    apply(result); preview.value = false; await load();
    if (generation === sessionGeneration) await notices.refresh();
  } catch (caught) { if (generation === sessionGeneration) { conflict.value = caught instanceof ApiClientError && caught.status === 409; error.value = formatError(caught, '发布失败'); } }
  finally { if (generation === sessionGeneration) busy.value = false; }
}
async function action(kind: 'withdraw' | 'delete') {
  const record = selected.value;
  if (!record || busy.value) return;
  const generation = sessionGeneration;
  if (!(await confirm({ title: kind === 'withdraw' ? '撤回公告' : '删除草稿', body: kind === 'withdraw' ? '成员将不再看到这条公告，已读回执和审计仍保留。' : '草稿删除后不可恢复。', confirmText: kind === 'withdraw' ? '撤回' : '删除', danger: true }))) return;
  if (generation !== sessionGeneration || selected.value?.id !== record.id || busy.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await api<Announcement | undefined>(`/admin/announcements/${record.id}${kind === 'withdraw' ? '/withdraw' : ''}`, { method: kind === 'withdraw' ? 'POST' : 'DELETE', body: JSON.stringify({ expectedRevision: record.revision }) });
    if (generation !== sessionGeneration) return;
    if (kind === 'withdraw' && result) apply(result);
    else { selected.value = null; title.value = ''; body.value = ''; baseline.value = snapshot(); }
    await load();
    if (generation === sessionGeneration) await notices.refresh();
  } catch (caught) { if (generation === sessionGeneration) { conflict.value = caught instanceof ApiClientError && caught.status === 409; error.value = formatError(caught, '操作失败'); } }
  finally { if (generation === sessionGeneration) busy.value = false; }
}
async function reloadConflict() {
  const id = selected.value?.id;
  if (!id || !(await allowLeave())) return;
  await open(id, true);
}
watch(() => auth.sessionEpoch, () => {
  const nextIdentity = `${auth.user?.id ?? ''}:${auth.user?.role ?? ''}`;
  // A focus-triggered identity refresh must not discard the current account's draft.
  if (identity === nextIdentity && auth.sessionChange === 'bootstrap') return;
  identity = nextIdentity; sessionGeneration += 1;
  list.cancelLatest(); reader.cancelLatest();
  items.value = []; cursor.value = null; selected.value = null; title.value = ''; body.value = '';
  baseline.value = snapshot(); error.value = ''; listError.value = ''; conflict.value = false; busy.value = false; preview.value = false;
  if (auth.isAdmin) void load();
});
const guards = inject(adminTabGuardKey, null);
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } }
onMounted(() => { guards?.register('announcements', allowLeave); window.addEventListener('beforeunload', beforeUnload); void load(); });
onBeforeUnmount(() => { sessionGeneration += 1; guards?.unregister('announcements'); window.removeEventListener('beforeunload', beforeUnload); });
onBeforeRouteLeave(allowLeave);
</script>

<template>
  <section class="admin-announcements">
    <div class="heading"><h2>公告</h2><button type="button" class="button secondary" :disabled="busy" @click="startNew"><FilePlus2 :size="17" />新建草稿</button></div>
    <div class="announcement-workspace">
      <aside class="announcement-directory">
        <form class="filters" @submit.prevent="load()"><label>状态<select v-model="filter" @change="load()"><option value="">全部</option><option value="DRAFT">草稿</option><option value="PUBLISHED">已发布</option><option value="WITHDRAWN">已撤回</option></select></label><label>标题<input v-model="keyword" maxlength="160" type="search" /></label><button type="submit" class="icon-button" title="搜索公告" aria-label="搜索公告"><RefreshCw :size="17" /></button></form>
        <p v-if="listError" class="alert error" role="alert">{{ listError }}<button type="button" @click="load()">重试</button></p>
        <p v-if="list.loading.value" role="status">正在加载…</p>
        <EmptyState v-else-if="!items.length && !listError" title="暂无公告" />
        <ul><li v-for="item in items" :key="item.id"><button type="button" :disabled="busy" :class="{ selected: selected?.id === item.id }" @click="open(item.id)"><strong>{{ item.title }}</strong><span>{{ statusLabel(item.status) }} · {{ new Date(item.updatedAt).toLocaleString('zh-CN') }}</span></button></li></ul>
        <button v-if="cursor" type="button" class="button secondary" :disabled="list.loading.value" @click="load(true)">更多公告</button>
      </aside>
      <section class="announcement-editor">
        <p v-if="reader.loading.value" role="status">正在加载正文…</p>
        <p v-if="error" class="alert error" role="alert">{{ error }}<button v-if="conflict" type="button" class="button secondary" @click="reloadConflict">重新载入</button></p>
        <p v-if="selected" class="status">{{ statusLabel(selected.status) }} · 版本 {{ selected.revision }}</p>
        <form v-if="canEdit" @submit.prevent="save"><label for="announcement-title">标题<input id="announcement-title" v-model="title" maxlength="160" required :disabled="busy || reader.loading.value" /></label><label for="announcement-body">正文<textarea id="announcement-body" v-model="body" rows="14" maxlength="20000" required :disabled="busy || reader.loading.value" /></label><div class="commands"><button type="submit" class="button" :disabled="busy || conflict || reader.loading.value"><Save :size="17" />{{ busy ? '正在保存' : '保存草稿' }}</button><button type="button" class="button secondary" :disabled="!title.trim() || !body.trim() || busy" @click="preview = true"><Eye :size="17" />预览</button><button v-if="selected" type="button" class="icon-button" title="删除草稿" aria-label="删除草稿" :disabled="busy" @click="action('delete')"><Trash2 :size="17" /></button></div></form>
        <article v-else><h3>{{ title }}</h3><div class="body">{{ body }}</div><div class="commands"><button type="button" class="button secondary" :disabled="busy" @click="copyDraft"><Copy :size="17" />复制为草稿</button><button v-if="selected?.status === 'PUBLISHED'" type="button" class="button secondary" :disabled="busy" @click="action('withdraw')"><Undo2 :size="17" />撤回公告</button></div></article>
      </section>
    </div>
  </section>
  <BaseDialog :open="preview" :title="title" :width="680" :dismissable="!busy" @close="preview = false"><div class="body">{{ body }}</div><p v-if="error" class="alert error" role="alert">{{ error }}</p><p v-if="dirty || !selected">尚未保存当前预览</p><template #footer><button type="button" class="button secondary" :disabled="busy" @click="preview = false">返回编辑</button><button type="button" class="button" :disabled="busy || dirty || !selected || conflict" @click="publish"><Send :size="17" />确认发布</button></template></BaseDialog>
</template>

<style scoped>
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }.heading h2 { font-size: 22px; }
.announcement-workspace { display: grid; grid-template-columns: minmax(240px, .7fr) minmax(0, 1.3fr); gap: 28px; }.announcement-directory, .announcement-editor { min-width: 0; }
.filters { display: flex; gap: 8px; align-items: end; margin-bottom: 14px; }.filters label { min-width: 0; margin-bottom: 0; }.filters label:last-of-type { flex: 1; }
.filters .icon-button { flex: 0 0 40px; width: 40px; height: 40px; }
label { display: grid; gap: 6px; color: var(--ink-soft); font-size: 13px; margin-bottom: 14px; }input, select, textarea { width: 100%; min-width: 0; box-sizing: border-box; padding: 9px 10px; border: 1px solid var(--border-strong); border-radius: 6px; color: var(--ink); background: var(--surface); font: inherit; }input, select { height: 40px; }
ul { list-style: none; margin: 0; padding: 0; }li { border-bottom: 1px solid var(--border); }li button { display: grid; gap: 8px; width: 100%; padding: 14px 8px; border: 0; background: transparent; text-align: left; color: var(--ink); cursor: pointer; }li button.selected { background: var(--accent-soft); }li strong, h3 { overflow-wrap: anywhere; }li span, .status { font-size: 12px; color: var(--muted); }
.commands { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }.body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; margin-bottom: 20px; }
@media (max-width: 900px) { .announcement-workspace { grid-template-columns: 1fr; }.announcement-directory ul { max-height: 280px; overflow-y: auto; } }
</style>
