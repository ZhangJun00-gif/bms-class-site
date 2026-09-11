<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { LoaderCircle, RotateCcw, Search, ShieldCheck } from 'lucide-vue-next';
import type { AdminCreditHourBatchCreateRequest, AdminCreditHourBatchCreateResponse, AdminCreditHourCreateRequest, CreditHourType, ListResponse, Member } from '@bmc3/contracts';
import BaseDialog from '../common/BaseDialog.vue';
import { ApiClientError, api, formatError } from '../../lib/api';
import { adminTabGuardKey } from '../../lib/adminTabGuard';
import { useAuthStore } from '../../stores/auth';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { validCreditHours } from '../../composables/useCreditHourUi';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; saved: [type: CreditHourType, count: number] }>();
const auth = useAuthStore();
const { confirm } = useConfirm();
const requests = useLatestRequest();
const members = ref<Member[]>([]);
const membersError = ref('');
const error = ref('');
const mode = ref<'single' | 'batch'>('single');
const userId = ref('');
const type = ref<CreditHourType>('QUALITY');
const hours = ref(0.5);
const activityName = ref('');
const description = ref('');
const search = ref('');
const selected = ref<string[]>([]);
const overrides = ref<Record<string, number>>({});
const reviewing = ref(false);
const busy = ref(false);
const uncertain = ref(false);
const baseline = ref('');
const eligible = computed(() => members.value.filter((member) => member.status === 'ACTIVE' && member.id !== auth.user?.id));
const filtered = computed(() => eligible.value.filter((member) => member.displayName.toLowerCase().includes(search.value.trim().toLowerCase())));
const selectedMembers = computed(() => eligible.value.filter((member) => selected.value.includes(member.id)));
const entries = computed(() => selectedMembers.value.map((member) => ({ userId: member.id, hours: overrides.value[member.id] ?? hours.value })));
const totalHours = computed(() => entries.value.reduce((sum, entry) => sum + (Number.isFinite(entry.hours) ? entry.hours : 0), 0));
const locked = computed(() => busy.value || uncertain.value);
const editingLocked = computed(() => locked.value || reviewing.value);
let key = crypto.randomUUID();
let lastBody = '';
let pending: { path: string; body: string; key: string; type: CreditHourType; batch: boolean } | null = null;

function snapshot() {
  return JSON.stringify({ mode: mode.value, userId: userId.value, type: type.value, hours: hours.value, activityName: activityName.value, description: description.value, selected: selected.value, overrides: overrides.value });
}
const dirty = computed(() => props.open && snapshot() !== baseline.value);
watch(() => props.open, (open) => {
  if (!open) { requests.cancelLatest(); return; }
  members.value = [];
  mode.value = 'single'; userId.value = ''; type.value = 'QUALITY'; hours.value = 0.5;
  activityName.value = ''; description.value = ''; search.value = ''; selected.value = []; overrides.value = {};
  reviewing.value = false; uncertain.value = false; error.value = ''; pending = null; lastBody = ''; key = crypto.randomUUID();
  baseline.value = snapshot();
  void loadMembers();
}, { immediate: true });

async function loadMembers() {
  membersError.value = '';
  await requests.runLatest(({ signal }) => api<ListResponse<Member>>('/users', { signal }), {
    commit(result) {
      const pristine = !dirty.value;
      members.value = result.items;
      if (!userId.value) userId.value = eligible.value[0]?.id ?? '';
      if (pristine) baseline.value = snapshot();
    },
    onError(caught) { membersError.value = formatError(caught, '成员列表加载失败'); },
  });
}

function toggleMember(id: string, checked: boolean) {
  if (editingLocked.value) return;
  if (checked) {
    if (selected.value.length >= 100) { error.value = '每批最多选择 100 人'; return; }
    if (!selected.value.includes(id)) selected.value.push(id);
  } else {
    selected.value = selected.value.filter((item) => item !== id);
    delete overrides.value[id];
  }
}
function selectFiltered(checked: boolean) {
  for (const member of filtered.value) toggleMember(member.id, checked);
}
function overrideHours(id: string, event: Event) {
  if (!editingLocked.value) overrides.value[id] = (event.target as HTMLInputElement).valueAsNumber;
}

async function allowLeave() {
  if (!props.open) return true;
  if (locked.value) { error.value = '录入结果尚未确认，请先重试原请求。'; return false; }
  const allowed = !dirty.value || await confirm({ title: '放弃未保存录入', body: '当前成员和学时尚未录入。', confirmText: '放弃录入', danger: true });
  if (allowed) emit('close');
  return allowed;
}
async function close() { await allowLeave(); }
const guards = inject(adminTabGuardKey, null);
onMounted(() => guards?.register('credit-hours', allowLeave));
onBeforeUnmount(() => { guards?.unregister('credit-hours'); window.removeEventListener('beforeunload', beforeUnload); });
onBeforeRouteLeave(allowLeave);
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || locked.value) { event.preventDefault(); event.returnValue = ''; }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));

function makeBody() {
  if (!activityName.value.trim() || !description.value.trim()) throw new Error('请填写活动名称和录入理由');
  if (!validCreditHours(hours.value)) throw new Error('统一学时须为 0.5 至 1000 小时，以 0.5 小时为步进');
  const common = { type: type.value, activityName: activityName.value.trim(), description: description.value.trim() };
  if (mode.value === 'single') {
    if (!eligible.value.some((member) => member.id === userId.value)) throw new Error('请选择正常状态的其他成员');
    return { ...common, userId: userId.value, hours: hours.value } satisfies AdminCreditHourCreateRequest;
  }
  if (!entries.value.length || entries.value.length > 100 || entries.value.length !== selected.value.length) throw new Error('请选择 1 至 100 名正常状态的其他成员');
  if (entries.value.some((entry) => !validCreditHours(entry.hours))) throw new Error('每位成员学时须为 0.5 至 1000 小时，以 0.5 小时为步进');
  return { ...common, entries: entries.value } satisfies AdminCreditHourBatchCreateRequest;
}

async function submit() {
  if (busy.value) return;
  error.value = '';
  if (!uncertain.value) {
    try {
      const body = JSON.stringify(makeBody());
      if (mode.value === 'batch' && !reviewing.value) { reviewing.value = true; return; }
      if (body !== lastBody) { key = crypto.randomUUID(); lastBody = body; }
      pending = { path: mode.value === 'batch' ? '/admin/credit-hours/submission-batches' : '/admin/credit-hours/submissions', body, key, type: type.value, batch: mode.value === 'batch' };
    } catch (caught) { error.value = formatError(caught, '请检查录入内容'); return; }
  }
  if (!pending) return;
  const request = pending;
  busy.value = true;
  try {
    const result = await api<AdminCreditHourBatchCreateResponse>(request.path, { method: 'POST', headers: { 'Idempotency-Key': request.key }, body: request.body });
    uncertain.value = false;
    pending = null;
    baseline.value = snapshot();
    emit('saved', request.type, request.batch ? result.count : 1);
    emit('close');
  } catch (caught) {
    uncertain.value = !(caught instanceof ApiClientError && caught.status < 500);
    if (!uncertain.value) { pending = null; reviewing.value = false; }
    error.value = uncertain.value ? '录入结果尚未确认，请重试原请求；成员与数值已保留。' : formatError(caught, '录入失败');
  } finally { busy.value = false; }
}
</script>

<template>
  <BaseDialog :open="open" title="为成员录入学时" :width="760" :dismissable="!locked" @close="close">
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <p v-if="membersError" class="alert error" role="alert">{{ membersError }}<button type="button" @click="loadMembers">重试</button></p>
    <form id="admin-credit-hour-create" class="create-form" @submit.prevent="submit">
      <fieldset class="segments full" :disabled="editingLocked"><legend>录入模式</legend>
        <label><input v-model="mode" type="radio" value="single" />单人</label><label><input v-model="mode" type="radio" value="batch" />批量</label>
      </fieldset>
      <label v-if="mode === 'single'" class="full" for="credit-member">成员
        <select id="credit-member" v-model="userId" required :disabled="editingLocked || requests.loading.value"><option value="" disabled>请选择成员</option><option v-for="member in eligible" :key="member.id" :value="member.id">{{ member.displayName }} · {{ member.role === 'MEMBER' ? '成员' : member.role === 'EDITOR' ? '编辑' : '管理员' }}</option></select>
      </label>
      <fieldset class="segments full" :disabled="editingLocked"><legend>学时类型</legend>
        <label><input v-model="type" type="radio" value="QUALITY" />素质学时</label><label><input v-model="type" type="radio" value="VOLUNTEER" />志愿学时</label>
      </fieldset>
      <label for="credit-hours">{{ mode === 'batch' ? '统一学时（小时）' : '学时（小时）' }}<input id="credit-hours" v-model.number="hours" type="number" min="0.5" max="1000" step="0.5" required :disabled="editingLocked" /></label>
      <label for="credit-activity">活动名称<input id="credit-activity" v-model="activityName" maxlength="160" required :disabled="editingLocked" /></label>
      <label class="full" for="credit-description">录入理由<textarea id="credit-description" v-model="description" maxlength="2000" rows="3" required :disabled="editingLocked" /></label>
      <template v-if="mode === 'batch'">
        <div v-if="!reviewing" class="full member-picker">
          <label for="credit-member-search"><Search :size="16" aria-hidden="true" />搜索成员<input id="credit-member-search" v-model="search" type="search" :disabled="editingLocked" /></label>
          <div class="selection-actions"><span>已选 {{ selected.length }} / 100 人</span><button type="button" :disabled="editingLocked" @click="selectFiltered(true)">全选搜索结果</button><button type="button" :disabled="editingLocked" @click="selectFiltered(false)">取消搜索结果</button></div>
          <div class="member-options"><label v-for="member in filtered" :key="member.id"><input type="checkbox" :checked="selected.includes(member.id)" :disabled="editingLocked" :aria-label="`选择 ${member.displayName}`" @change="toggleMember(member.id, ($event.target as HTMLInputElement).checked)" />{{ member.displayName }}</label></div>
          <p v-if="!filtered.length && !requests.loading.value">没有匹配成员</p>
        </div>
        <div class="full batch-entries">
          <div v-for="member in selectedMembers" :key="member.id" class="batch-entry">
            <div><strong>{{ member.displayName }}</strong><span v-if="Object.hasOwn(overrides, member.id)">已单独调整</span></div>
            <input type="number" min="0.5" max="1000" step="0.5" :value="overrides[member.id] ?? hours" :aria-label="`${member.displayName} 学时`" :disabled="editingLocked" required @input="overrideHours(member.id, $event)" />
            <button type="button" class="icon-button" :aria-label="`重置 ${member.displayName} 为统一学时`" title="恢复统一学时" :disabled="editingLocked || !Object.hasOwn(overrides, member.id)" @click="delete overrides[member.id]"><RotateCcw :size="17" aria-hidden="true" /></button>
          </div>
          <p>共 {{ entries.length }} 人，合计 {{ totalHours.toFixed(1) }} 小时</p>
        </div>
        <p v-if="reviewing" class="full confirmation" role="status">{{ type === 'QUALITY' ? '素质学时' : '志愿学时' }} · {{ activityName }} · {{ entries.length }} 人 · {{ totalHours.toFixed(1) }} 小时</p>
      </template>
      <p v-if="requests.loading.value" class="full" role="status">正在加载成员…</p>
      <p v-else-if="!eligible.length" class="full">当前没有可录入的其他正常状态用户。</p>
    </form>
    <template #footer>
      <button type="button" class="button secondary" :disabled="locked" @click="reviewing ? reviewing = false : close()">{{ reviewing ? '返回修改' : '取消' }}</button>
      <button type="submit" form="admin-credit-hour-create" class="button" :disabled="busy || requests.loading.value || !eligible.length"><LoaderCircle v-if="busy" :size="17" class="spin" /><ShieldCheck v-else :size="17" />{{ busy ? '正在录入' : uncertain ? '重试原请求' : mode === 'batch' ? reviewing ? `确认录入 ${entries.length} 人` : '核对录入明细' : '录入并通过' }}</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.create-form { display: grid; grid-template-columns: minmax(0, 0.7fr) minmax(0, 1.3fr); gap: 16px; }
label { display: grid; gap: 6px; min-width: 0; color: var(--ink-soft); font-size: 13px; }
input:not([type='checkbox']):not([type='radio']), select, textarea { width: 100%; min-width: 0; box-sizing: border-box; padding: 9px 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); color: var(--ink); font: inherit; }
input:not([type='checkbox']):not([type='radio']), select { height: 42px; }
.full { grid-column: 1 / -1; }
.segments { display: flex; gap: 20px; border: 0; padding: 0; margin: 0; }
.segments label, .member-options label { display: flex; align-items: center; gap: 8px; min-height: 36px; }
.segments legend { margin-bottom: 6px; font-size: 13px; }
.member-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); max-height: 190px; overflow-y: auto; border-bottom: 1px solid var(--border); }
.selection-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 0; font-size: 13px; }
.selection-actions button { border: 0; padding: 5px; background: none; color: var(--primary); }
.batch-entry { display: grid; grid-template-columns: minmax(0, 1fr) 100px 40px; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--border); }
.batch-entry strong { overflow-wrap: anywhere; font-size: 14px; }
.batch-entry span { display: block; font-size: 12px; color: var(--muted); }
.confirmation, .batch-entries p { white-space: pre-wrap; overflow-wrap: anywhere; font-weight: 600; }
.spin { animation: spin .8s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 800px) { .create-form { grid-template-columns: 1fr; } .member-options { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .member-options { grid-template-columns: 1fr; } .batch-entry { grid-template-columns: minmax(0, 1fr) 90px 40px; } }
</style>
