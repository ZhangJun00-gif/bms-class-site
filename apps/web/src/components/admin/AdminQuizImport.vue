<script setup lang="ts">
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  FileArchive,
  FilePlus2,
  Files,
  RefreshCw,
  Upload,
  X,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ApiClientError,
  api,
  apiUrl,
  formatError,
  isAbortError,
  uploadForm,
  type UploadProgress,
} from "../../lib/api";
import { useLatestRequest } from "../../composables/useLatestRequest";
import { usePaneVisibility } from "../../composables/usePaneVisibility";
import { useToast } from "../../composables/useToast";
import type {
  QuizImportJob,
  QuizImportListResponse,
  QuizImportMode,
  QuizPaperSummary,
  Subject,
} from "../../types";

const props = withDefaults(defineProps<{
  subjects: Subject[];
  papers: QuizPaperSummary[];
  papersError?: string;
  active?: boolean;
}>(), { active: true });
const emit = defineEmits<{ completed: [] }>();
const toast = useToast();
const recentRequests = useLatestRequest();
const jobRequests = useLatestRequest();
const mutations = useLatestRequest();
const paneVisible = usePaneVisibility(() => props.active);

type UiMode = "bank" | "newPaper" | "appendPaper";

const file = ref<File | null>(null);
const fileInput = ref<HTMLInputElement>();
const mode = ref<UiMode>("bank");
const createMissingChapters = ref(false);
const pastPaperTitle = ref("");
const pastPaperSubjectId = ref("");
const pastPaperYear = ref<number | null>(null);
const pastPaperId = ref("");
const uploading = ref(false);
const uploadProgress = ref<UploadProgress | null>(null);
const error = ref("");
const message = ref("");
const activeJob = ref<QuizImportJob | null>(null);
const recentJobs = ref<QuizImportJob[]>([]);
const recentLoading = ref(false);
const completedEmitted = new Set<string>();
let uploadController: AbortController | null = null;
let pollTimer: number | undefined;

const terminalStatuses = new Set([
  "INVALID",
  "COMPLETED",
  "FAILED",
  "COMPENSATION_FAILED",
  "EXPIRED",
  "CANCELLED",
]);
const canSubmit = computed(() => {
  if (!file.value || uploading.value) return false;
  if (mode.value === "newPaper") {
    return Boolean(pastPaperTitle.value.trim() && pastPaperSubjectId.value);
  }
  if (mode.value === "appendPaper") return Boolean(pastPaperId.value);
  return true;
});
const progressPercent = computed(() => {
  const job = activeJob.value;
  if (!job?.progressTotal) return null;
  return Math.min(
    100,
    Math.round((job.progressCurrent / job.progressTotal) * 100),
  );
});
const importMutationBusy = computed(() => {
  const ids = new Set(recentJobs.value.map((job) => job.id));
  if (activeJob.value) ids.add(activeJob.value.id);
  return [...ids].some((id) => mutations.isBusy(`job:${id}`));
});

const statusLabels: Record<string, string> = {
  PREFLIGHT_PENDING: "等待预检",
  PREFLIGHTING: "正在预检",
  AWAITING_CONFIRMATION: "等待确认",
  INVALID: "预检未通过",
  IMPORT_PENDING: "等待导入",
  IMPORTING: "正在导入",
  COMPLETED: "导入完成",
  FAILED: "导入失败",
  COMPENSATION_FAILED: "清理未完成",
  EXPIRED: "已过期",
  CANCELLED: "已取消",
};
const stageLabels: Record<string, string> = {
  QUEUED: "任务已进入队列",
  VALIDATING_PACKAGE: "正在检查题目包",
  VALIDATING_IMAGES: "正在检查图片",
  READY_FOR_CONFIRMATION: "预检完成",
  QUEUED_FOR_IMPORT: "已确认，等待 Worker",
  VALIDATING_AGAIN: "正在复核目录与内容",
  PROCESSING_IMAGES: "正在处理图片",
  WRITING_DATABASE: "正在写入题库",
  RETRY_PENDING: "暂时失败，等待自动重试",
  VALIDATION_CHANGED: "预检后内容条件发生变化",
  INVALID: "题目包存在错误",
  COMPLETED: "全部数据已提交",
  FAILED: "任务处理失败",
  COMPENSATION_FAILED: "部分图片未能清理",
  EXPIRED: "确认期限已过",
};

function mapMode(value: UiMode): QuizImportMode {
  if (value === "newPaper") return "NEW_PAPER";
  if (value === "appendPaper") return "APPEND_PAPER";
  return "BANK";
}

function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const picked = input.files?.[0] ?? null;
  error.value = "";
  message.value = "";
  if (!picked) {
    file.value = null;
    return;
  }
  const extension = picked.name.toLowerCase().split(".").at(-1);
  if (!["csv", "zip"].includes(extension ?? "")) {
    file.value = null;
    input.value = "";
    error.value = "仅支持 CSV 或 ZIP 题目包";
    return;
  }
  const maximum = extension === "csv" ? 2 * 1024 * 1024 : 200 * 1024 * 1024;
  if (picked.size > maximum) {
    file.value = null;
    input.value = "";
    error.value =
      extension === "csv" ? "CSV 文件超过 2MB 限制" : "ZIP 文件超过 200MB 限制";
    return;
  }
  file.value = picked;
}

function switchMode(next: UiMode) {
  mode.value = next;
  error.value = "";
  message.value = "";
}

async function submit() {
  if (!canSubmit.value || !file.value) return;
  uploading.value = true;
  uploadProgress.value = null;
  error.value = "";
  message.value = "";
  uploadController = new AbortController();
  try {
    const form = new FormData();
    form.append("file", file.value);
    form.append("mode", mapMode(mode.value));
    if (createMissingChapters.value)
      form.append("createMissingChapters", "true");
    if (mode.value === "newPaper") {
      form.append("pastPaperTitle", pastPaperTitle.value.trim());
      form.append("subjectId", pastPaperSubjectId.value);
      if (pastPaperYear.value !== null)
        form.append("pastPaperYear", String(pastPaperYear.value));
    } else if (mode.value === "appendPaper") {
      form.append("pastPaperId", pastPaperId.value);
    }
    const job = await uploadForm<QuizImportJob>("/quizzes/imports", form, {
      signal: uploadController.signal,
      onProgress(progress) {
        uploadProgress.value = progress;
      },
    });
    activeJob.value = job;
    file.value = null;
    if (fileInput.value) fileInput.value.value = "";
    message.value = "上传完成，题目包已进入预检队列";
    startPolling();
    await loadRecent();
  } catch (caught) {
    if (isAbortError(caught))
      message.value = "已取消上传，可以重新提交当前文件";
    else error.value = formatError(caught, "题目包上传失败");
  } finally {
    uploading.value = false;
    uploadController = null;
  }
}

function cancelUpload() {
  uploadController?.abort();
}

async function loadRecent() {
  if (!paneVisible.value) return;
  recentLoading.value = true;
  const result = await recentRequests.runLatest(
    ({ signal }) => api<QuizImportListResponse>(
      "/quizzes/imports?page=1&pageSize=10",
      { signal },
    ),
    {
      commit(response) {
        recentJobs.value = response.items;
        if (activeJob.value) {
          const refreshed = response.items.find((job) => job.id === activeJob.value?.id);
          if (refreshed) activeJob.value = refreshed;
        } else {
          const resumable = response.items.find(
            (job) => !terminalStatuses.has(job.status),
          );
          activeJob.value = resumable ?? response.items[0] ?? null;
        }
      },
      onError(caught) {
        error.value = formatError(caught, "导入任务加载失败");
      },
      onFinally() {
        recentLoading.value = false;
      },
    },
  );
  if (result.status === "committed") syncPollingForCurrent();
}

async function loadJob(_background = false, continuePolling = false) {
  if (!paneVisible.value) return;
  const id = activeJob.value?.id;
  if (!id) return;
  const result = await jobRequests.runLatest(
    ({ signal }) => api<QuizImportJob>(`/quizzes/imports/${id}`, { signal }),
    {
      commit(job) {
        if (activeJob.value?.id !== id) return;
        error.value = "";
        activeJob.value = job;
        const index = recentJobs.value.findIndex((item) => item.id === id);
        if (index >= 0) recentJobs.value[index] = job;
        if (job.status === "COMPLETED" && !completedEmitted.has(job.id)) {
          completedEmitted.add(job.id);
          emit("completed");
        }
      },
      onError(caught) {
        if (activeJob.value?.id === id)
          error.value = formatError(caught, "任务状态加载失败");
      },
    },
  );
  if (
    continuePolling &&
    result.status !== "aborted" &&
    result.status !== "stale" &&
    activeJob.value?.id === id &&
    paneVisible.value &&
    !terminalStatuses.has(activeJob.value.status) &&
    activeJob.value.status !== "AWAITING_CONFIRMATION"
  ) {
    pollTimer = window.setTimeout(() => void loadJob(true, true), 1_500);
  }
}

function startPolling() {
  stopPolling();
  if (!paneVisible.value) return;
  void loadJob(true, true);
}

function stopPolling() {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
  jobRequests.cancelLatest();
}

function syncPollingForCurrent() {
  stopPolling();
  const current = activeJob.value;
  if (
    current &&
    !terminalStatuses.has(current.status) &&
    current.status !== "AWAITING_CONFIRMATION"
  ) startPolling();
}

function replaceRecentJob(updated: QuizImportJob) {
  const index = recentJobs.value.findIndex((item) => item.id === updated.id);
  if (index >= 0) {
    recentJobs.value = recentJobs.value.map((item) =>
      item.id === updated.id ? updated : item,
    );
  } else {
    recentJobs.value = [updated, ...recentJobs.value];
  }
  if (activeJob.value?.id === updated.id) activeJob.value = updated;
}

function selectJob(job: QuizImportJob) {
  if (importMutationBusy.value) return;
  activeJob.value = job;
  error.value = "";
  message.value = "";
  startPolling();
}

async function confirmImport() {
  const job = activeJob.value;
  const busyKey = `job:${job?.id ?? ""}`;
  if (!job || job.status !== "AWAITING_CONFIRMATION" || mutations.isBusy(busyKey))
    return;
  error.value = "";
  await mutations.runBusy(busyKey, async () => {
    try {
      const updated = await api<QuizImportJob>(`/quizzes/imports/${job.id}/confirm`, {
        method: "POST",
      });
      replaceRecentJob(updated);
      message.value = "已确认导入，任务进入处理队列";
      toast.success(message.value);
      syncPollingForCurrent();
    } catch (caught) {
      error.value = formatError(caught, "确认导入失败");
      toast.error(error.value);
      if (caught instanceof ApiClientError && caught.status === 409) {
        await loadRecent();
      }
    }
  });
}

async function cancelImport() {
  const job = activeJob.value;
  const busyKey = `job:${job?.id ?? ""}`;
  if (!job || mutations.isBusy(busyKey)) return;
  error.value = "";
  await mutations.runBusy(busyKey, async () => {
    try {
      const updated = await api<QuizImportJob>(`/quizzes/imports/${job.id}/cancel`, {
        method: "POST",
      });
      replaceRecentJob(updated);
      syncPollingForCurrent();
      toast.success("导入任务已取消");
    } catch (caught) {
      error.value = formatError(caught, "取消导入失败");
      toast.error(error.value);
      if (caught instanceof ApiClientError && caught.status === 409) {
        await loadRecent();
      }
    }
  });
}

watch(paneVisible, (visible) => {
  if (!visible) {
    stopPolling();
    recentRequests.cancelLatest();
    recentLoading.value = false;
    return;
  }
  void loadRecent();
});

onMounted(() => {
  if (paneVisible.value) void loadRecent();
});
onBeforeUnmount(() => {
  uploadController?.abort();
  stopPolling();
});
</script>

<template>
  <section aria-label="题库批量导入" class="quiz-import-workspace">
    <header class="section-header">
      <div class="section-heading">
        <span class="section-icon" aria-hidden="true"
          ><FileArchive :size="18"
        /></span>
        <h3 class="section-title">批量导入</h3>
      </div>
      <button
        type="button"
        class="icon-button"
        title="刷新任务"
        :disabled="recentLoading"
        @click="loadRecent"
      >
        <RefreshCw
          :size="17"
          :class="{ spinning: recentLoading }"
          aria-hidden="true"
        />
        <span class="sr-only">刷新任务</span>
      </button>
    </header>

    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <p v-if="message" class="alert success" role="status">{{ message }}</p>

    <div class="import-layout">
      <form class="form quiz-form import-form" @submit.prevent="submit">
        <fieldset class="mode-fieldset">
          <legend class="sr-only">导入模式</legend>
          <label class="mode-option" :class="{ active: mode === 'bank' }">
            <input
              class="sr-only"
              type="radio"
              name="import-mode"
              value="bank"
              :checked="mode === 'bank'"
              :disabled="uploading"
              @change="switchMode('bank')"
            />
            <Database :size="16" aria-hidden="true" /><span>普通题库</span>
          </label>
          <label class="mode-option" :class="{ active: mode === 'newPaper' }">
            <input
              class="sr-only"
              type="radio"
              name="import-mode"
              value="newPaper"
              :checked="mode === 'newPaper'"
              :disabled="uploading"
              @change="switchMode('newPaper')"
            />
            <FilePlus2 :size="16" aria-hidden="true" /><span>新建真题</span>
          </label>
          <label
            class="mode-option"
            :class="{ active: mode === 'appendPaper' }"
          >
            <input
              class="sr-only"
              type="radio"
              name="import-mode"
              value="appendPaper"
              :checked="mode === 'appendPaper'"
              :disabled="uploading"
              @change="switchMode('appendPaper')"
            />
            <Files :size="16" aria-hidden="true" /><span>追加真题</span>
          </label>
        </fieldset>

        <template v-if="mode === 'newPaper'">
          <div class="field">
            <label for="import-paper-title">试卷标题</label>
            <input
              id="import-paper-title"
              v-model="pastPaperTitle"
              maxlength="160"
              required
              :disabled="uploading"
            />
          </div>
          <div class="field-row">
            <div class="field">
              <label for="import-paper-subject">试卷学科</label>
              <select
                id="import-paper-subject"
                v-model="pastPaperSubjectId"
                required
                :disabled="uploading || !subjects.length"
              >
                <option disabled value="">请选择学科</option>
                <option
                  v-for="subject in subjects"
                  :key="subject.id"
                  :value="subject.id"
                >
                  {{ subject.name }}
                </option>
              </select>
            </div>
            <div class="field">
              <label for="import-paper-year">年份（可选）</label>
              <input
                id="import-paper-year"
                v-model.number="pastPaperYear"
                type="number"
                min="1900"
                max="2200"
                :disabled="uploading"
              />
            </div>
          </div>
        </template>

        <div v-if="mode === 'appendPaper'" class="field">
          <label for="import-paper-select">目标试卷</label>
          <select
            id="import-paper-select"
            v-model="pastPaperId"
            required
            :disabled="uploading || Boolean(papersError)"
          >
            <option disabled value="">请选择试卷</option>
            <option v-for="paper in papers" :key="paper.id" :value="paper.id">
              {{ paper.title }}{{ paper.year ? `（${paper.year}）` : "" }} ·
              {{ paper.subject }} · {{ paper.questionCount }} 题
            </option>
          </select>
          <p v-if="papersError" class="field-hint error-text">
            {{ papersError }}
          </p>
        </div>

        <div class="field file-field">
          <span class="field-label">题目文件</span>
          <input
            id="quiz-import-file"
            ref="fileInput"
            class="sr-only"
            type="file"
            accept=".csv,.zip,text/csv,application/zip"
            required
            :disabled="uploading"
            @change="pickFile"
          />
          <label
            for="quiz-import-file"
            class="file-picker"
            :class="{ selected: file, disabled: uploading }"
          >
            <Upload :size="20" aria-hidden="true" />
            <span class="file-picker-copy">
              <strong>{{ file ? file.name : "选择 CSV 或 ZIP" }}</strong>
              <small>{{
                file
                  ? `${(file.size / 1024 / 1024).toFixed(2)} MB`
                  : "CSV 最大 2MB，ZIP 最大 200MB"
              }}</small>
            </span>
          </label>
        </div>

        <label class="auto-create-option" for="import-create-chapters">
          <input
            id="import-create-chapters"
            v-model="createMissingChapters"
            type="checkbox"
            :disabled="uploading"
          />
          <span>自动创建缺失章节</span>
        </label>

        <div
          v-if="uploading && uploadProgress"
          class="upload-progress"
          role="status"
        >
          <progress
            :value="uploadProgress.loaded"
            :max="uploadProgress.total ?? undefined"
          />
          <span>{{
            uploadProgress.percent === null
              ? "正在上传"
              : `上传 ${uploadProgress.percent}%`
          }}</span>
          <button
            type="button"
            class="icon-button"
            title="取消上传"
            @click="cancelUpload"
          >
            <X :size="16" /><span class="sr-only">取消上传</span>
          </button>
        </div>

        <button class="button" type="submit" :disabled="!canSubmit">
          <Upload :size="16" aria-hidden="true" />{{
            uploading ? "正在上传…" : "上传并预检"
          }}
        </button>
      </form>

      <div class="job-panel">
        <div v-if="activeJob" class="job-detail">
          <div class="job-title-row">
            <div>
              <strong>{{ activeJob.sourceName }}</strong>
              <small>{{
                statusLabels[activeJob.status] ?? activeJob.status
              }}</small>
            </div>
            <CheckCircle2
              v-if="activeJob.status === 'COMPLETED'"
              :size="22"
              class="status-success"
              aria-hidden="true"
            />
            <AlertTriangle
              v-else-if="
                [
                  'INVALID',
                  'FAILED',
                  'COMPENSATION_FAILED',
                  'EXPIRED',
                ].includes(activeJob.status)
              "
              :size="22"
              class="status-error"
              aria-hidden="true"
            />
            <Clock3
              v-else
              :size="22"
              class="status-pending"
              aria-hidden="true"
            />
          </div>
          <p class="job-stage">
            {{ stageLabels[activeJob.stage] ?? activeJob.stage }}
          </p>
          <div v-if="activeJob.progressTotal" class="job-progress">
            <progress
              :value="activeJob.progressCurrent"
              :max="activeJob.progressTotal"
            />
            <span
              >{{ activeJob.progressCurrent }} / {{ activeJob.progressTotal
              }}<template v-if="progressPercent !== null">
                · {{ progressPercent }}%</template
              ></span
            >
          </div>
          <dl class="job-metrics">
            <div>
              <dt>题目</dt>
              <dd>{{ activeJob.questionCount || activeJob.importedCount }}</dd>
            </div>
            <div>
              <dt>图片</dt>
              <dd>{{ activeJob.imageCount }}</dd>
            </div>
            <div>
              <dt>错误</dt>
              <dd>{{ activeJob.errorCount }}</dd>
            </div>
            <div>
              <dt>警告</dt>
              <dd>{{ activeJob.warningCount }}</dd>
            </div>
          </dl>
          <template v-if="activeJob.summary">
            <div class="summary-line">
              <strong>学科</strong
              ><span>{{
                activeJob.summary.subjects
                  .map((item) => `${item.name} ${item.count}`)
                  .join("、") || "无"
              }}</span>
            </div>
            <div class="summary-line">
              <strong>题型</strong
              ><span>{{
                activeJob.summary.typeLabels
                  .map((item) => `${item.name} ${item.count}`)
                  .join("、") || "无"
              }}</span>
            </div>
          </template>
          <p v-if="activeJob.errorMessage" class="job-error" role="alert">
            {{ activeJob.errorMessage }}
          </p>
          <ul v-if="activeJob.issues?.length" class="issue-list">
            <li v-for="item in activeJob.issues" :key="item.id">
              <span>{{
                item.rowNumber
                  ? `第 ${item.rowNumber} 行`
                  : item.filePath || "题目包"
              }}</span
              >{{ item.message }}
            </li>
          </ul>
          <div class="job-actions">
            <button
              v-if="activeJob.status === 'AWAITING_CONFIRMATION'"
              type="button"
              class="button"
              :disabled="mutations.isBusy(`job:${activeJob.id}`)"
              @click="confirmImport"
            >
              <CheckCircle2 :size="16" />{{
                mutations.isBusy(`job:${activeJob.id}`) ? "处理中…" : "确认导入"
              }}
            </button>
            <button
              v-if="['PREFLIGHT_PENDING', 'PREFLIGHTING', 'AWAITING_CONFIRMATION', 'IMPORT_PENDING', 'IMPORTING'].includes(activeJob.status)"
              type="button"
              class="button ghost"
              :disabled="mutations.isBusy(`job:${activeJob.id}`)"
              @click="cancelImport"
            >
              {{ mutations.isBusy(`job:${activeJob.id}`) ? "处理中…" : "取消任务" }}
            </button>
            <a
              v-if="activeJob.errorCount || activeJob.warningCount"
              class="button secondary"
              :href="apiUrl(`/quizzes/imports/${activeJob.id}/issues.csv`)"
            >
              <Download :size="16" />下载问题清单
            </a>
          </div>
        </div>
        <p v-else class="empty-copy">暂无导入任务</p>

        <div v-if="recentJobs.length" class="recent-jobs">
          <h4>近期任务</h4>
          <button
            v-for="job in recentJobs"
            :key="job.id"
            type="button"
            :class="{ active: activeJob?.id === job.id }"
            :disabled="importMutationBusy"
            @click="selectJob(job)"
          >
            <span>{{ job.sourceName }}</span
            ><small>{{ statusLabels[job.status] ?? job.status }}</small>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.quiz-import-workspace {
  display: grid;
  gap: var(--space-4);
}
.import-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 0.85fr);
  gap: var(--space-5);
  align-items: start;
}
.import-form,
.job-panel,
.job-detail {
  min-width: 0;
}
.mode-fieldset {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
  padding: 0;
  border: 0;
}
.mode-option {
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  color: var(--ink-soft);
  cursor: pointer;
}
.mode-option.active {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-soft);
}
.file-picker {
  min-height: 72px;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-s);
  cursor: pointer;
}
input.sr-only {
  width: 1px;
  min-height: 1px;
  height: 1px;
  padding: 0;
  border: 0;
}
.file-picker.selected {
  border-color: var(--primary);
  background: var(--primary-soft);
}
.file-picker.disabled {
  cursor: not-allowed;
  opacity: 0.65;
}
.file-picker-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.file-picker-copy strong,
.file-picker-copy small {
  overflow-wrap: anywhere;
}
.file-picker-copy small {
  color: var(--ink-soft);
}
.auto-create-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.upload-progress,
.job-progress {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-2);
}
progress {
  width: 100%;
  height: 8px;
}
.job-panel {
  display: grid;
  gap: var(--space-4);
  border-left: 1px solid var(--border);
  padding-left: var(--space-5);
}
.job-detail {
  display: grid;
  gap: var(--space-3);
}
.job-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}
.job-title-row > div {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.job-title-row strong {
  overflow-wrap: anywhere;
}
.job-title-row small,
.job-stage {
  color: var(--ink-soft);
}
.job-stage {
  margin: 0;
}
.status-success {
  color: var(--success);
}
.status-error,
.job-error {
  color: var(--danger);
}
.status-pending {
  color: var(--primary);
}
.job-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0;
  border-block: 1px solid var(--border);
}
.job-metrics div {
  padding: var(--space-3) var(--space-2);
  text-align: center;
}
.job-metrics dt {
  color: var(--ink-soft);
  font-size: 12px;
}
.job-metrics dd {
  margin: 2px 0 0;
  font-weight: 700;
}
.summary-line {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: var(--space-2);
  font-size: 13px;
}
.summary-line span {
  overflow-wrap: anywhere;
}
.issue-list {
  max-height: 220px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
  border-block: 1px solid var(--border);
}
.issue-list li {
  padding: 8px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.issue-list span {
  margin-right: 8px;
  color: var(--danger);
  font-weight: 600;
}
.job-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.recent-jobs {
  display: grid;
  gap: var(--space-1);
}
.recent-jobs h4 {
  margin: 0 0 var(--space-1);
  font-size: 14px;
}
.recent-jobs button {
  min-width: 0;
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
}
.recent-jobs button.active,
.recent-jobs button:hover {
  background: var(--surface-muted);
  color: var(--ink);
}
.recent-jobs span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-jobs small {
  flex: none;
}
.empty-copy {
  color: var(--ink-soft);
}
.spinning {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 900px) {
  .import-layout {
    grid-template-columns: 1fr;
  }
  .job-panel {
    border-left: 0;
    border-top: 1px solid var(--border);
    padding: var(--space-4) 0 0;
  }
}
@media (max-width: 520px) {
  .mode-fieldset {
    grid-template-columns: 1fr;
  }
  .mode-option {
    justify-content: flex-start;
  }
  .job-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .job-actions .button {
    width: 100%;
    justify-content: center;
  }
}
</style>
