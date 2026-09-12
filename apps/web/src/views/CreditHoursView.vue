<script setup lang="ts">
import type {
  CreditHourLeaderboard,
  CreditHourLeaderboardEntry,
  CreditHourPublicSubmissionPage,
  CreditHourSubmission,
  CreditHourSummary,
  CreditHourType,
} from '@bmc3/contracts';
import {
  Eye,
  FileImage,
  History,
  LoaderCircle,
  Medal,
  RefreshCw,
  Send,
  Trash2,
  Users,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import BaseDialog from '../components/common/BaseDialog.vue';
import EmptyState from '../components/common/EmptyState.vue';
import PageHeader from '../components/layout/PageHeader.vue';
import { ApiClientError, api, formatError, uploadForm } from '../lib/api';
import { useToast } from '../composables/useToast';
import { useLatestRequest } from '../composables/useLatestRequest';
import { creditHourStatusLabel as statusLabel, loadCreditHourPages as loadAllCursorPages, validCreditHours } from '../composables/useCreditHourUi';
import ManualReviewNotice from '../components/credit-hours/ManualReviewNotice.vue';

interface PendingFile {
  id: string;
  file: File;
  previewUrl: string;
}

const toast = useToast();
const submissionType = ref<CreditHourType>('QUALITY');
const summary = ref<CreditHourSummary | null>(null);
const leaderboard = ref<CreditHourLeaderboard | null>(null);
const mine = ref<CreditHourSubmission[]>([]);
const publicRecords = ref<CreditHourPublicSubmissionPage | null>(null);
const selectedUser = ref<CreditHourLeaderboardEntry | null>(null);
const selectedMineId = ref<string | null>(null);
const loading = ref(true);
const error = ref('');
const publicError = ref('');
const pageRequests = useLatestRequest();
const publicRequests = useLatestRequest();
const mutations = useLatestRequest();
const submitting = ref(false);
const uncertain = ref(false);
const formLocked = computed(() => submitting.value || uncertain.value);
let pendingForm: FormData | null = null;
const uploadPercent = ref<number | null>(null);
const activityName = ref('');
const hours = ref(0.5);
const sourceDescription = ref('');
const files = ref<PendingFile[]>([]);
let idempotencyKey = createIdempotencyKey();

const ownHours = computed(() => summary.value?.totalHours ?? 0);
const ownRank = computed(
  () => leaderboard.value?.items.find((item) => item.currentUser)?.rank ?? null,
);
const publicQualityRecords = computed(
  () => publicRecords.value?.items.filter((item) => item.type === 'QUALITY') ?? [],
);
const publicVolunteerRecords = computed(
  () =>
    publicRecords.value?.items.filter((item) => item.type === 'VOLUNTEER') ?? [],
);

onMounted(loadPage);
onBeforeUnmount(clearFiles);

async function loadPage() {
  loading.value = true;
  error.value = '';
  await pageRequests.runLatest(async ({ signal }) => {
    const [nextSummary, nextLeaderboard, submissions] = await Promise.all([
      api<CreditHourSummary>('/credit-hours/me/summary', { signal }),
      loadAllCursorPages<CreditHourLeaderboardEntry>(
        '/credit-hours/leaderboard?type=TOTAL&pageSize=100',
        signal,
      ),
      loadAllCursorPages<CreditHourSubmission>(
        '/credit-hours/submissions?pageSize=100',
        signal,
      ),
    ]);
    return { nextSummary, nextLeaderboard, submissions };
  }, {
    commit({ nextSummary, nextLeaderboard, submissions }) {
      summary.value = nextSummary;
      leaderboard.value = { type: 'TOTAL', ...nextLeaderboard };
      mine.value = submissions.items;
    },
    onError(caught) { error.value = formatError(caught, '学时数据加载失败'); },
    onFinally() { loading.value = false; },
  });
}

async function showPublicRecords(entry: CreditHourLeaderboardEntry) {
  selectedUser.value = entry;
  publicRecords.value = null;
  publicError.value = '';
  await publicRequests.runLatest(({ signal }) => loadAllCursorPages<
      CreditHourPublicSubmissionPage['items'][number]
    >(`/credit-hours/users/${entry.userId}/submissions?pageSize=100`, signal), {
    commit(records) { publicRecords.value = {
      user: { id: entry.userId, displayName: entry.displayName },
      items: records.items,
      nextCursor: null,
    }; },
    onError(caught) { publicError.value = formatError(caught, '公示记录加载失败'); },
  });
}

function closePublicRecords() {
  publicRequests.cancelLatest();
  selectedUser.value = null;
  publicRecords.value = null;
}

function onFilesSelected(event: Event) {
  if (formLocked.value) return;
  const input = event.target as HTMLInputElement;
  const selected = Array.from(input.files ?? []);
  input.value = '';
  const room = 5 - files.value.length;
  if (selected.length > room) toast.info('每次提交最多保留 5 张凭证');
  for (const file of selected.slice(0, room)) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast.error(`${file.name} 不是支持的图片格式`);
      continue;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error(`${file.name} 超过 10 MB`);
      continue;
    }
    files.value.push({
      id: createIdempotencyKey(),
      file,
      previewUrl: URL.createObjectURL(file),
    });
  }
}

function removeFile(id: string) {
  if (formLocked.value) return;
  const index = files.value.findIndex((item) => item.id === id);
  if (index < 0) return;
  URL.revokeObjectURL(files.value[index]!.previewUrl);
  files.value.splice(index, 1);
}

function clearFiles() {
  for (const item of files.value) URL.revokeObjectURL(item.previewUrl);
  files.value = [];
}

async function submit() {
  if (submitting.value) return;
  if (files.value.length < 1) {
    toast.error('请至少上传一张图片凭证');
    return;
  }
  if (!validCreditHours(hours.value)) {
    toast.error('学时须为 0.5 至 1000 小时，以 0.5 小时为步进');
    return;
  }
  const form = pendingForm ?? new FormData();
  if (!pendingForm) {
    form.set('type', submissionType.value);
    form.set('activityName', activityName.value.trim());
    form.set('hours', String(hours.value));
    form.set('sourceDescription', sourceDescription.value.trim());
    for (const item of files.value) form.append('evidence', item.file);
    pendingForm = form;
  }
  submitting.value = true;
  uploadPercent.value = 0;
  try {
    await uploadForm<CreditHourSubmission>('/credit-hours/submissions', form, {
      headers: { 'Idempotency-Key': idempotencyKey },
      onProgress: (progress) => {
        uploadPercent.value = progress.percent;
      },
    });
    activityName.value = '';
    hours.value = 0.5;
    sourceDescription.value = '';
    clearFiles();
    idempotencyKey = createIdempotencyKey();
    pendingForm = null;
    uncertain.value = false;
    toast.success('提交成功，视觉审核已进入队列');
    await loadPage();
  } catch (caught) {
    uncertain.value = !(caught instanceof ApiClientError && caught.status < 500);
    if (!uncertain.value) pendingForm = null;
    toast.error(formatError(caught, '学时提交失败'));
  } finally {
    submitting.value = false;
    uploadPercent.value = null;
  }
}

async function withdraw(item: CreditHourSubmission) {
  if (mutations.isBusy(item.id)) return;
  if (!window.confirm(`确认撤回“${item.activityName}”吗？`)) return;
  await mutations.runBusy(item.id, async () => { try {
    await api(`/credit-hours/submissions/${item.id}/withdraw`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: item.revision }),
    });
    toast.success('记录已撤回');
    await loadPage();
  } catch (caught) {
    toast.error(formatError(caught, '撤回失败'));
  } });
}

function recordTypeLabel(type: CreditHourType) {
  return type === 'QUALITY' ? '素质学时' : '志愿学时';
}

function formatDate(value: string | null) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function createIdempotencyKey() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

</script>

<template>
  <main class="page credit-hours-page">
    <PageHeader
      title="学时统计"
      description="全员已通过学时汇总与公示。"
    >
      <template #breadcrumb>
        <RouterLink to="/">首页</RouterLink>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">学时统计</span>
      </template>
    </PageHeader>

    <div class="page-content">
      <div v-if="error" class="load-error" role="alert">
        <span>{{ error }}</span>
        <button type="button" class="button secondary" @click="loadPage">
          <RefreshCw :size="16" aria-hidden="true" />重试
        </button>
      </div>

      <template v-else>
        <section class="summary-band" aria-labelledby="summary-heading">
          <div>
            <h2 id="summary-heading" class="section-kicker">我的总学时</h2>
            <strong>{{ ownHours.toFixed(1) }}h</strong>
            <span>当前排名 {{ ownRank ? `第 ${ownRank} 名` : '计算中' }}</span>
          </div>
          <div class="summary-icon" aria-hidden="true"><Medal :size="28" /></div>
        </section>

        <div class="work-grid">
          <section class="submission-tool" aria-labelledby="submit-heading">
            <div class="section-heading compact">
              <div><p class="section-kicker">新增申报</p><h2 id="submit-heading">提交学时记录</h2></div>
              <Send :size="21" aria-hidden="true" />
            </div>
            <form @submit.prevent="submit">
              <div class="full submission-type-field">
                <span>申报类型</span>
                <div class="submission-type-switch" role="radiogroup" aria-label="申报学时类型">
                  <button
                    v-for="option in ([['QUALITY', '素质学时'], ['VOLUNTEER', '志愿学时']] as const)"
                    :key="option[0]"
                    type="button"
                    role="radio"
                    :aria-checked="submissionType === option[0]"
                    :disabled="formLocked"
                    @click="submissionType = option[0]"
                  >
                    {{ option[1] }}
                  </button>
                </div>
              </div>
              <label>活动名称<input v-model="activityName" maxlength="160" required :disabled="formLocked" /></label>
              <label>学时（小时）<input v-model.number="hours" type="number" min="0.5" max="1000" step="0.5" required :disabled="formLocked" /></label>
              <label class="full">学时来源<textarea v-model="sourceDescription" maxlength="2000" rows="4" required :disabled="formLocked" /></label>
              <div class="full evidence-field">
                <span>图片凭证（1-5 张）</span>
                <label class="file-command">
                  <FileImage :size="18" aria-hidden="true" />选择图片
                  <input type="file" accept="image/jpeg,image/png,image/webp" multiple :disabled="formLocked" @change="onFilesSelected" />
                </label>
                <div v-if="files.length" class="preview-grid">
                  <figure v-for="item in files" :key="item.id">
                    <img :src="item.previewUrl" alt="待上传凭证预览" />
                    <button type="button" aria-label="移除这张凭证" title="移除凭证" :disabled="formLocked" @click="removeFile(item.id)"><Trash2 :size="15" aria-hidden="true" /></button>
                  </figure>
                </div>
              </div>
              <p v-if="uncertain" class="full alert warning" role="alert">提交结果尚未确认，请重试原提交。</p>
              <button class="button full" type="submit" :disabled="submitting">
                <LoaderCircle v-if="submitting" :size="17" class="spin" aria-hidden="true" />
                <Send v-else :size="17" aria-hidden="true" />
                {{ submitting ? `提交中${uploadPercent === null ? '' : ` ${uploadPercent}%`}` : uncertain ? '重试原提交' : '提交审核' }}
              </button>
            </form>
          </section>

          <section class="history-tool" aria-labelledby="history-heading">
            <div class="section-heading compact">
              <div><p class="section-kicker">仅自己可见</p><h2 id="history-heading">我的完整记录</h2></div>
              <History :size="21" aria-hidden="true" />
            </div>
            <EmptyState v-if="!loading && !mine.length" title="暂无申报记录" hint="提交后可在这里查看审核状态。" />
            <div v-else-if="loading" class="loading-row"><LoaderCircle :size="18" class="spin" aria-hidden="true" />加载中</div>
            <ul v-else class="record-list mine-list" tabindex="0" aria-labelledby="history-heading">
              <li v-for="item in mine" :key="item.id">
                <div class="record-main">
                  <div><strong>{{ item.activityName }}</strong><span>{{ recordTypeLabel(item.type) }} · {{ formatDate(item.createdAt) }}</span></div>
                  <b>{{ item.hours.toFixed(1) }}h</b>
                </div>
                <div class="record-meta">
                  <span class="status" :data-status="item.status">{{ statusLabel(item.status) }}</span>
                  <span v-if="item.decisionReason" class="reason">{{ item.decisionReason }}</span>
                  <button type="button" class="icon-button record-detail-button" :aria-label="selectedMineId === item.id ? '收起记录详情' : '查看记录详情'" :title="selectedMineId === item.id ? '收起详情' : '查看详情'" @click="selectedMineId = selectedMineId === item.id ? null : item.id">
                    <Eye :size="16" aria-hidden="true" />
                  </button>
                  <button v-if="['PENDING_REVIEW', 'PENDING_MANUAL_REVIEW'].includes(item.status)" type="button" class="text-command danger-text" :disabled="mutations.isBusy(item.id)" @click="withdraw(item)">撤回</button>
                </div>
                <div v-if="selectedMineId === item.id" class="record-detail">
                  <ManualReviewNotice v-if="item.status === 'PENDING_MANUAL_REVIEW'" :review="item.manualReview" />
                  <p><strong>学时来源</strong>{{ item.sourceDescription }}</p>
                  <div v-if="item.evidence.length" class="evidence-history-grid">
                    <img v-for="evidence in item.evidence" :key="evidence.id" :src="evidence.displayUrl" alt="本人学时凭证展示图" />
                  </div>
                </div>
              </li>
            </ul>
          </section>
        </div>

        <section class="public-section" aria-labelledby="public-heading">
          <div class="section-heading">
            <div>
              <p class="section-kicker">公开统计</p>
              <h2 id="public-heading">全员总学时排行</h2>
            </div>
            <Users :size="22" aria-hidden="true" />
          </div>
          <div v-if="loading" class="loading-row">
            <LoaderCircle :size="18" class="spin" aria-hidden="true" />加载中
          </div>
          <div v-else class="leaderboard-wrap">
            <table>
              <thead>
                <tr><th>排名</th><th>成员</th><th>素质学时</th><th>志愿学时</th><th>总学时</th><th>记录</th></tr>
              </thead>
              <tbody>
                <tr v-for="entry in leaderboard?.items" :key="entry.userId" :class="{ self: entry.currentUser }">
                  <td class="rank">{{ entry.rank }}</td>
                  <td>{{ entry.displayName }}<span v-if="entry.currentUser" class="self-mark">我</span></td>
                  <td class="hours-cell">{{ entry.qualityHours.toFixed(1) }}h</td>
                  <td class="hours-cell">{{ entry.volunteerHours.toFixed(1) }}h</td>
                  <td class="hours-cell"><strong>{{ entry.totalHours.toFixed(1) }}h</strong></td>
                  <td><button type="button" class="text-command" :aria-label="`查看${entry.displayName}的公示记录`" @click="showPublicRecords(entry)">记录</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </div>
  </main>

  <BaseDialog
    :open="Boolean(selectedUser)"
    :title="selectedUser ? `${selectedUser.displayName} · 总学时公示记录` : '公示记录'"
    :width="860"
    @close="closePublicRecords"
  >
    <div class="public-dialog-content" aria-live="polite">
      <div v-if="publicError" class="alert error" role="alert">{{ publicError }}<button type="button" class="button secondary" @click="selectedUser && showPublicRecords(selectedUser)">重试</button></div>
      <div v-else-if="!publicRecords" class="loading-row">
        <LoaderCircle :size="18" class="spin" aria-hidden="true" />加载中
      </div>
      <div v-else class="public-record-groups">
        <section class="public-record-section" aria-labelledby="public-quality-heading">
          <div class="public-record-heading">
            <div><p class="section-kicker">已通过</p><h3 id="public-quality-heading">素质学时</h3></div>
            <strong>{{ (selectedUser?.qualityHours ?? 0).toFixed(1) }}h</strong>
          </div>
          <EmptyState v-if="!publicQualityRecords.length" title="暂无素质学时记录" />
          <ul v-else class="record-list public-list" data-record-type="QUALITY">
            <li v-for="item in publicQualityRecords" :key="item.id">
              <div><strong>{{ item.activityName }}</strong><span>{{ formatDate(item.decidedAt) }}</span></div>
              <b>{{ item.hours.toFixed(1) }}h</b>
            </li>
          </ul>
        </section>
        <section class="public-record-section" aria-labelledby="public-volunteer-heading">
          <div class="public-record-heading">
            <div><p class="section-kicker">已通过</p><h3 id="public-volunteer-heading">志愿学时</h3></div>
            <strong>{{ (selectedUser?.volunteerHours ?? 0).toFixed(1) }}h</strong>
          </div>
          <EmptyState v-if="!publicVolunteerRecords.length" title="暂无志愿学时记录" />
          <ul v-else class="record-list public-list" data-record-type="VOLUNTEER">
            <li v-for="item in publicVolunteerRecords" :key="item.id">
              <div><strong>{{ item.activityName }}</strong><span>{{ formatDate(item.decidedAt) }}</span></div>
              <b>{{ item.hours.toFixed(1) }}h</b>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </BaseDialog>
</template>

<style scoped>
.credit-hours-page { color: var(--ink); }
.status[data-status='PENDING_MANUAL_REVIEW'] { background: #fff1b8; color: #684a0d; }
.summary-band { display: flex; align-items: center; justify-content: space-between; padding: var(--space-6) 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.summary-band strong { display: block; margin: 4px 0; color: var(--primary-dark); font-size: 38px; letter-spacing: 0; }
.summary-band span { color: var(--muted); font-size: 14px; }
.summary-icon { width: 54px; height: 54px; display: grid; place-items: center; border-radius: var(--radius-m); background: var(--accent-soft); color: var(--accent-dark); }
.section-kicker { margin: 0 0 3px; color: var(--accent-dark); font-size: 12px; font-weight: 700; letter-spacing: 0; }
.public-section { margin-top: var(--space-8); padding: var(--space-8) 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-5); }
.section-heading.compact { margin-bottom: var(--space-4); }
.section-heading h2 { margin: 0; font-size: 21px; letter-spacing: 0; }
.section-heading > svg { color: var(--accent); }
.leaderboard-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-s); }
table { width: 100%; min-width: 700px; border-collapse: collapse; }
th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid var(--border); }
tr:last-child td { border-bottom: 0; }
tr.self { background: var(--accent-soft); }
.rank { width: 70px; color: var(--primary); font-weight: 700; }
.hours-cell { white-space: nowrap; }
.self-mark { display: inline-block; margin-left: 7px; padding: 1px 6px; border-radius: var(--radius-pill); background: var(--primary); color: white; font-size: 11px; }
.text-command { border: 0; padding: 4px; background: none; color: var(--accent-dark); cursor: pointer; font-weight: 600; }
.danger-text { color: var(--danger); }
.work-grid { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); gap: var(--space-8); padding-top: var(--space-8); }
.submission-tool, .history-tool { min-width: 0; }
.history-tool { display: flex; flex-direction: column; min-height: 0; }
.history-tool > .section-heading { flex: none; }
.mine-list { min-height: 0; overflow-y: auto; scrollbar-gutter: stable; align-content: start; }
/* Let the submission form determine the shared row height. */
@media (min-width: 901px) {
  .history-tool { contain: size; }
  .mine-list { flex: 1; }
}
form { display: grid; grid-template-columns: minmax(0, 1fr) 150px; gap: var(--space-4); }
.submission-type-field { display: grid; gap: 7px; color: var(--ink-soft); font-size: 13px; font-weight: 600; }
.submission-type-switch { display: inline-flex; width: fit-content; gap: 4px; padding: 4px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-muted); }
.submission-type-switch button { min-width: 110px; height: 34px; border: 0; border-radius: var(--radius-s); background: transparent; color: var(--muted); cursor: pointer; }
.submission-type-switch button[aria-checked='true'] { background: var(--surface); color: var(--primary-dark); font-weight: 650; box-shadow: var(--shadow-s); }
label { display: grid; gap: 7px; color: var(--ink-soft); font-size: 13px; font-weight: 600; }
input, textarea { width: 100%; min-height: 42px; padding: 9px 11px; border: 1px solid var(--border-strong); border-radius: var(--radius-s); background: var(--surface); color: var(--ink); font: inherit; box-sizing: border-box; }
textarea { resize: vertical; }
.full { grid-column: 1 / -1; }
.evidence-field { display: grid; gap: var(--space-3); }
.file-command { width: fit-content; min-height: 40px; display: inline-flex; align-items: center; gap: 8px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: var(--radius-s); background: var(--surface); color: var(--primary); cursor: pointer; }
.file-command input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.preview-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.preview-grid figure { position: relative; aspect-ratio: 4 / 3; margin: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-muted); }
.preview-grid img { width: 100%; height: 100%; object-fit: cover; }
.preview-grid button { position: absolute; top: 5px; right: 5px; width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 50%; background: rgba(21, 34, 56, 0.84); color: white; cursor: pointer; }
.record-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--border); }
.record-list li { padding: 14px 0; border-bottom: 1px solid var(--border); }
.record-main, .public-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
.record-list strong { display: block; color: var(--ink); font-size: 14px; }
.record-list span { color: var(--muted); font-size: 12px; }
.record-list b { flex: none; color: var(--primary); }
.public-dialog-content { min-height: 110px; }
.public-record-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-8); }
.public-record-section { min-width: 0; }
.public-record-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding-bottom: var(--space-3); border-bottom: 1px solid var(--border); }
.public-record-heading h3 { margin: 0; font-size: 17px; letter-spacing: 0; }
.public-record-heading > strong { flex: none; color: var(--primary-dark); font-size: 20px; }
.public-record-section .record-list { border-top: 0; }
.record-meta { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.record-meta .reason { flex: 1; }
.record-detail-button { flex: none; }
.record-detail { margin-top: 12px; padding: 12px; border-left: 3px solid var(--accent); background: var(--surface-muted); }
.record-detail p { margin: 0 0 10px; color: var(--ink-soft); white-space: pre-wrap; }
.record-detail p strong { margin-bottom: 4px; }
.evidence-history-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.evidence-history-grid img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border: 1px solid var(--border); border-radius: var(--radius-s); }
.status { padding: 3px 8px; border-radius: var(--radius-pill); background: var(--surface-muted); }
.status[data-status='APPROVED'] { background: var(--success-bg); color: var(--success); }
.status[data-status='REJECTED'] { background: var(--danger-bg); color: var(--danger); }
.status[data-status='PENDING_REVIEW'] { background: var(--warning-bg); color: var(--warning); }
.loading-row, .load-error { min-height: 90px; display: flex; align-items: center; justify-content: center; gap: 9px; color: var(--muted); }
.load-error { justify-content: space-between; padding: var(--space-4); border: 1px solid var(--danger-border); border-radius: var(--radius-s); color: var(--danger); background: var(--danger-bg); }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 900px) {
  .work-grid { grid-template-columns: 1fr; }
  .mine-list { max-height: 36rem; }
}
@media (max-width: 560px) {
  .public-record-groups { grid-template-columns: 1fr; }
  .submission-type-switch { display: flex; width: 100%; box-sizing: border-box; }
  .submission-type-switch button { min-width: 0; flex: 1; }
  .summary-band strong { font-size: 32px; }
  .preview-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  form { grid-template-columns: 1fr; }
  .full { grid-column: auto; }
  .record-meta { align-items: flex-start; flex-wrap: wrap; }
}
</style>
