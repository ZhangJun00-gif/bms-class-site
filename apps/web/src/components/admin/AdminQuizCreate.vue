<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  ImagePlus,
  ListPlus,
  Plus,
  RotateCw,
  Trash2,
  X,
} from "lucide-vue-next";
import { api, formatError } from "../../lib/api";
import { questionTypeLabels } from "../../lib/labels";
import { useConfirm } from "../../composables/useConfirm";
import { useLatestRequest } from "../../composables/useLatestRequest";
import QuizChapterSelect from "../quiz/QuizChapterSelect.vue";
import type {
  GradingRubric,
  KnowledgeSubject,
  QuestionType,
  QuizImage,
  QuizQuestionWriteRequest,
  SubjectChapter,
} from "../../types";

const { confirm } = useConfirm();
const chapterRequests = useLatestRequest();

const emit = defineEmits<{ created: [] }>();

const props = withDefaults(
  defineProps<{
    subjects?: KnowledgeSubject[];
    subjectsLoading?: boolean;
  }>(),
  {
    subjects: () => [],
    subjectsLoading: false,
  },
);

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const gradingTypes: QuestionType[] = [
  "SINGLE",
  "MULTIPLE",
  "TRUE_FALSE",
  "SHORT_ANSWER",
];

interface OptionRow {
  id: string;
  text: string;
}

interface CriterionRow {
  description: string;
  points: number | null;
}

type ImageStatus = "pending" | "uploading" | "success" | "failed";

interface ImageEntry {
  key: string;
  file: File;
  caption: string;
  status: ImageStatus;
  error: string;
  photo: QuizImage | null;
}

const gradingType = ref<QuestionType>("SINGLE");
const typeLabel = ref(questionTypeLabels.SINGLE);
const typeLabelTouched = ref(false);
const category = ref<NonNullable<QuizQuestionWriteRequest["category"]>>("STANDARD");
const subjectId = ref("");
const chapterIds = ref<string[]>([]);
const chapters = ref<SubjectChapter[]>([]);
const chaptersLoading = ref(false);
const chaptersError = ref("");
const prompt = ref("");
const explanation = ref("");
const options = ref<OptionRow[]>([
  { id: "A", text: "" },
  { id: "B", text: "" },
  { id: "C", text: "" },
  { id: "D", text: "" },
]);
const correctAnswer = ref<string[]>([]);
const referenceAnswers = ref("");
const criteria = ref<CriterionRow[]>([{ description: "", points: null }]);
const rubricNotes = ref("");
const busy = ref(false);
const error = ref("");
const created = ref<{ id: string; typeLabel: string; subject: string } | null>(
  null,
);
const images = ref<ImageEntry[]>([]);
let imageKey = 0;

const isShortAnswer = computed(() => gradingType.value === "SHORT_ANSWER");
const chapterOptions = computed(() =>
  chapters.value.map((chapter) => ({
    id: chapter.id,
    label: chapter.name,
  })),
);
const uploadedCount = computed(
  () => images.value.filter((entry) => entry.status === "success").length,
);

function defaultOptions(): OptionRow[] {
  if (gradingType.value === "TRUE_FALSE")
    return [
      { id: "A", text: "正确" },
      { id: "B", text: "错误" },
    ];
  return [
    { id: "A", text: "" },
    { id: "B", text: "" },
    { id: "C", text: "" },
    { id: "D", text: "" },
  ];
}

watch(gradingType, (next, prev) => {
  if (!typeLabelTouched.value) typeLabel.value = questionTypeLabels[next];
  if (next === "SHORT_ANSWER" || prev === "TRUE_FALSE" || next === "TRUE_FALSE")
    options.value = defaultOptions();
  correctAnswer.value = [];
});

watch(
  () => props.subjects.map((item) => item.id),
  (ids) => {
    if (!ids.includes(subjectId.value)) subjectId.value = ids[0] ?? "";
  },
  { immediate: true },
);

watch(
  subjectId,
  (next) => {
    chapterIds.value = [];
    chapters.value = [];
    chaptersError.value = "";
    chapterRequests.cancelLatest();
    if (!next) {
      chaptersLoading.value = false;
      return;
    }
    chaptersLoading.value = true;
    void chapterRequests.runLatest(
      ({ signal }) => api<SubjectChapter[]>(`/subjects/${next}/chapters`, { signal }),
      {
        commit(value) {
          if (subjectId.value === next) chapters.value = value;
        },
        onError(caught) {
          if (subjectId.value === next)
            chaptersError.value = formatError(caught, "章节目录加载失败");
        },
        onFinally() {
          if (subjectId.value === next) chaptersLoading.value = false;
        },
      },
    );
  },
  { immediate: true },
);

function onTypeLabelInput() {
  typeLabelTouched.value = true;
}

function nextOptionId(): string {
  const used = new Set(options.value.map((option) => option.id));
  for (let index = 0; index < 26; index += 1) {
    const id = String.fromCharCode(65 + index);
    if (!used.has(id)) return id;
  }
  return `O${options.value.length + 1}`;
}

function addOption() {
  options.value = [...options.value, { id: nextOptionId(), text: "" }];
}

function removeOption(id: string) {
  options.value = options.value.filter((option) => option.id !== id);
  correctAnswer.value = correctAnswer.value.filter((value) => value !== id);
}

function toggleAnswer(id: string, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  if (gradingType.value === "MULTIPLE") {
    correctAnswer.value = checked
      ? [...correctAnswer.value, id]
      : correctAnswer.value.filter((value) => value !== id);
  } else {
    correctAnswer.value = checked ? [id] : [];
  }
}

function addCriterion() {
  criteria.value = [...criteria.value, { description: "", points: null }];
}

function removeCriterion(index: number) {
  criteria.value = criteria.value.filter((_, i) => i !== index);
}

function validate(): string {
  if (!subjectId.value) return "请选择学科";
  if (!chapterIds.value.length) return "请至少选择一个章节";
  if (prompt.value.trim().length < 2) return "题干至少需要 2 个字符";
  if (isShortAnswer.value) {
    if (!referenceAnswers.value.split("\n").some((line) => line.trim()))
      return "简答题至少需要一个参考答案";
    const validCriteria = criteria.value.filter(
      (row) => row.description.trim() && row.points,
    );
    if (!validCriteria.length) return "简答题至少需要一个有效评分点";
    if (
      criteria.value.some(
        (row) =>
          row.description.trim() &&
          (!Number.isInteger(row.points) || (row.points ?? 0) < 1),
      )
    )
      return "评分点分值必须是大于 0 的整数";
    return "";
  }
  if (options.value.length < 2) return "至少需要两个选项";
  if (options.value.some((option) => !option.text.trim()))
    return "选项内容不能为空";
  if (!correctAnswer.value.length) return "请选择正确答案";
  if (gradingType.value !== "MULTIPLE" && correctAnswer.value.length !== 1)
    return "单选题和判断题只能有一个正确答案";
  return "";
}

function buildPayload(): QuizQuestionWriteRequest {
  const payload: QuizQuestionWriteRequest = {
    gradingType: gradingType.value,
    category: category.value,
    subjectId: subjectId.value,
    chapterIds: [...chapterIds.value],
    prompt: prompt.value.trim(),
    options: isShortAnswer.value
      ? []
      : options.value.map((option) => ({
          id: option.id,
          text: option.text.trim(),
        })),
    correctAnswer: isShortAnswer.value
      ? referenceAnswers.value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [...correctAnswer.value],
    explanation: explanation.value.trim(),
  };
  const label = typeLabel.value.trim();
  if (label) payload.typeLabel = label;
  if (isShortAnswer.value) {
    const rubric: GradingRubric = {
      criteria: criteria.value
        .filter((row) => row.description.trim())
        .map((row) => ({
          description: row.description.trim(),
          points: row.points ?? 0,
        })),
    };
    if (rubricNotes.value.trim()) rubric.notes = rubricNotes.value.trim();
    payload.gradingRubric = rubric;
  }
  return payload;
}

async function submit() {
  error.value = validate();
  if (error.value || busy.value) return;
  busy.value = true;
  try {
    const question = await api<{
      id: string;
      typeLabel: string;
      subject: string;
    }>("/quizzes/questions", {
      method: "POST",
      body: JSON.stringify(buildPayload()),
    });
    created.value = question;
    emit("created");
    await uploadPending();
  } catch (caught) {
    error.value = formatError(caught, "题目创建失败，请检查后重试");
  } finally {
    busy.value = false;
  }
}

function pickImages(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  for (const file of files) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      images.value = [
        ...images.value,
        {
          key: `img-${++imageKey}`,
          file,
          caption: "",
          status: "failed",
          error: "仅支持 JPG、PNG 或 WebP 图片",
          photo: null,
        },
      ];
      continue;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      images.value = [
        ...images.value,
        {
          key: `img-${++imageKey}`,
          file,
          caption: "",
          status: "failed",
          error: "图片超过 10MB 限制",
          photo: null,
        },
      ];
      continue;
    }
    images.value = [
      ...images.value,
      {
        key: `img-${++imageKey}`,
        file,
        caption: "",
        status: "pending",
        error: "",
        photo: null,
      },
    ];
  }
  void uploadPending();
}

async function uploadPending() {
  if (!created.value) return;
  for (const entry of images.value) {
    if (entry.status === "pending") await uploadImage(entry);
  }
}

async function uploadImage(entry: ImageEntry) {
  if (!created.value || entry.status === "uploading") return;
  entry.status = "uploading";
  entry.error = "";
  try {
    const form = new FormData();
    form.append("file", entry.file);
    if (entry.caption.trim()) form.append("caption", entry.caption.trim());
    form.append("sortOrder", String(images.value.indexOf(entry)));
    const photo = await api<QuizImage>(
      `/quizzes/questions/${created.value.id}/images`,
      { method: "POST", body: form },
    );
    entry.photo = photo;
    entry.status = "success";
  } catch (caught) {
    entry.error = formatError(caught, "配图上传失败");
    entry.status = "failed";
  }
}

async function detachImage(entry: ImageEntry) {
  if (!created.value || !entry.photo) return;
  const ok = await confirm({
    title: "解绑配图",
    body: "确定将该图片与题目解绑？图片本身仍保留在媒体库。",
    confirmText: "确定解绑",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(
      `/quizzes/questions/${created.value.id}/images/${entry.photo.id}`,
      { method: "DELETE" },
    );
    images.value = images.value.filter((item) => item.key !== entry.key);
  } catch (caught) {
    entry.error = formatError(caught, "解绑失败，请重试");
  }
}

function removePending(entry: ImageEntry) {
  images.value = images.value.filter((item) => item.key !== entry.key);
}

function reset() {
  created.value = null;
  images.value = [];
  prompt.value = "";
  explanation.value = "";
  referenceAnswers.value = "";
  criteria.value = [{ description: "", points: null }];
  rubricNotes.value = "";
  options.value = defaultOptions();
  correctAnswer.value = [];
  error.value = "";
}
</script>

<template>
  <section aria-label="创建题目" class="create-section">
    <header class="section-header">
      <div class="section-heading">
        <span class="section-icon" aria-hidden="true">
          <ListPlus :size="18" />
        </span>
        <h3 class="section-title">创建题目</h3>
      </div>
      <span class="section-meta">单题录入</span>
    </header>

    <div v-if="created" class="created-panel">
      <p class="alert success" role="status">
        题目已创建（{{ created.subject }} · {{ created.typeLabel }}）。 配图
        {{ uploadedCount }} / {{ images.length }} 上传成功。
      </p>

      <div class="field">
        <label for="question-images">题目配图（可选，每张不超过 10MB）</label>
        <input
          id="question-images"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          :disabled="busy"
          @change="pickImages"
        />
      </div>

      <ul v-if="images.length" class="image-list">
        <li
          v-for="entry in images"
          :key="entry.key"
          class="image-entry"
          :class="entry.status"
        >
          <img
            v-if="entry.status === 'success' && entry.photo"
            class="image-thumb"
            :src="entry.photo.url"
            :alt="entry.photo.caption || entry.file.name"
          />
          <div class="image-info">
            <p class="image-name">{{ entry.file.name }}</p>
            <input
              v-if="entry.status === 'pending' || entry.status === 'failed'"
              v-model="entry.caption"
              type="text"
              maxlength="300"
              placeholder="图片说明（可选）"
              :aria-label="`图片 ${entry.file.name} 的说明`"
            />
            <p v-else-if="entry.caption" class="image-caption">
              {{ entry.caption }}
            </p>
            <p
              v-if="entry.status === 'failed'"
              class="image-error"
              role="alert"
            >
              {{ entry.error }}
            </p>
          </div>
          <div class="image-actions">
            <span v-if="entry.status === 'pending'" class="image-status"
              >等待上传…</span
            >
            <span v-if="entry.status === 'uploading'" class="image-status"
              >上传中…</span
            >
            <button
              v-if="entry.status === 'failed'"
              type="button"
              class="button ghost small-button"
              @click="uploadImage(entry)"
            >
              <RotateCw :size="14" aria-hidden="true" />
              重试
            </button>
            <button
              v-if="entry.status === 'failed' || entry.status === 'pending'"
              type="button"
              class="button ghost small-button"
              :aria-label="`移除 ${entry.file.name}`"
              @click="removePending(entry)"
            >
              <X :size="14" aria-hidden="true" />
            </button>
            <button
              v-if="entry.status === 'success'"
              type="button"
              class="button ghost small-button"
              @click="detachImage(entry)"
            >
              <Trash2 :size="14" aria-hidden="true" />
              解绑
            </button>
          </div>
        </li>
      </ul>

      <button type="button" class="button secondary" :disabled="busy" @click="reset">
        <ImagePlus :size="15" aria-hidden="true" />
        再建一题
      </button>
    </div>

    <form v-else class="form create-form" @submit.prevent="submit">
      <p v-if="error" class="alert error" role="alert">{{ error }}</p>

      <div class="field-row type-row">
        <div class="field">
          <label for="create-grading-type">判分类型</label>
          <select
            id="create-grading-type"
            v-model="gradingType"
            :disabled="busy"
          >
            <option v-for="type in gradingTypes" :key="type" :value="type">
              {{ questionTypeLabels[type] }}
            </option>
          </select>
          <p class="field-hint">决定判分方式与表单结构，固定四种。</p>
        </div>
        <div class="field">
          <label for="create-type-label">显示题型标签</label>
          <input
            id="create-type-label"
            v-model="typeLabel"
            type="text"
            maxlength="100"
            required
            :disabled="busy"
            @input="onTypeLabelInput"
          />
          <p class="field-hint">
            面向学生的分类名称，可自定义（如“病例分析题”“识图题”）。
          </p>
        </div>
        <div class="field">
          <label for="create-category">题目分类</label>
          <select id="create-category" v-model="category" :disabled="busy">
            <option value="STANDARD">标准题</option>
            <option value="KNOWLEDGE_RECALL">知识背诵题</option>
          </select>
        </div>
      </div>

      <div class="field-row question-meta-row">
        <div class="field">
          <label for="create-subject">学科</label>
          <select
            id="create-subject"
            v-model="subjectId"
            required
            :disabled="busy || subjectsLoading || !subjects.length"
          >
            <option disabled value="">
              {{ subjectsLoading ? "正在加载学科…" : subjects.length ? "请选择学科" : "暂无可用学科" }}
            </option>
            <option v-for="item in subjects" :key="item.id" :value="item.id">
              {{ item.name }}
            </option>
          </select>
        </div>
        <div class="field chapter-field">
          <label for="create-chapters">章节（可多选）</label>
          <QuizChapterSelect
            id="create-chapters"
            v-model="chapterIds"
            :options="chapterOptions"
            :disabled="
              busy || chaptersLoading || !subjectId || !chapters.length
            "
            :placeholder="
              chaptersLoading
                ? '正在加载章节…'
                : subjectId
                  ? chapters.length
                    ? '请选择章节'
                    : '该学科暂无启用章节'
                  : '请先选择学科'
            "
            :show-match="false"
          />
          <p v-if="chaptersError" class="field-error" role="alert">
            {{ chaptersError }}
          </p>
        </div>
      </div>

      <div class="field">
        <label for="create-prompt">题干</label>
        <textarea
          id="create-prompt"
          v-model="prompt"
          rows="4"
          maxlength="10000"
          required
          :disabled="busy"
        ></textarea>
      </div>

      <fieldset v-if="!isShortAnswer" class="options-fieldset">
        <legend>选项与正确答案</legend>
        <div v-for="option in options" :key="option.id" class="option-row">
          <input
            :type="gradingType === 'MULTIPLE' ? 'checkbox' : 'radio'"
            name="create-correct-answer"
            class="answer-input"
            :checked="correctAnswer.includes(option.id)"
            :aria-label="`选项 ${option.id} 为正确答案`"
            :disabled="busy"
            @change="toggleAnswer(option.id, $event)"
          />
          <span class="option-id">{{ option.id }}</span>
          <input
            v-model="option.text"
            type="text"
            class="option-text"
            maxlength="2000"
            :placeholder="`选项 ${option.id} 内容`"
            :aria-label="`选项 ${option.id} 内容`"
            :disabled="busy"
          />
          <button
            type="button"
            class="button ghost small-button"
            :aria-label="`删除选项 ${option.id}`"
            :disabled="busy || options.length <= 2"
            @click="removeOption(option.id)"
          >
            <X :size="14" aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          class="button ghost small-button"
          :disabled="busy"
          @click="addOption"
        >
          <Plus :size="14" aria-hidden="true" />
          添加选项
        </button>
        <p class="field-hint">
          勾选正确答案；单选题与判断题只能选一个，多选题可多选。
        </p>
      </fieldset>

      <template v-else>
        <div class="field">
          <label for="create-reference">参考答案（每行一个）</label>
          <textarea
            id="create-reference"
            v-model="referenceAnswers"
            rows="3"
            :disabled="busy"
          ></textarea>
        </div>
        <fieldset class="options-fieldset">
          <legend>评分标准</legend>
          <div
            v-for="(criterion, index) in criteria"
            :key="index"
            class="option-row"
          >
            <input
              v-model="criterion.description"
              type="text"
              class="option-text"
              maxlength="1000"
              placeholder="评分点描述，如：答出关键机制"
              :aria-label="`评分点 ${index + 1} 描述`"
              :disabled="busy"
            />
            <input
              v-model.number="criterion.points"
              type="number"
              class="points-input"
              min="1"
              max="100"
              placeholder="分值"
              :aria-label="`评分点 ${index + 1} 分值`"
              :disabled="busy"
            />
            <button
              type="button"
              class="button ghost small-button"
              :aria-label="`删除评分点 ${index + 1}`"
              :disabled="busy || criteria.length <= 1"
              @click="removeCriterion(index)"
            >
              <X :size="14" aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            class="button ghost small-button"
            :disabled="busy"
            @click="addCriterion"
          >
            <Plus :size="14" aria-hidden="true" />
            添加评分点
          </button>
          <div class="field">
            <label for="create-rubric-notes">评分备注（可选）</label>
            <input
              id="create-rubric-notes"
              v-model="rubricNotes"
              type="text"
              maxlength="2000"
              :disabled="busy"
            />
          </div>
        </fieldset>
      </template>

      <div class="field">
        <label for="create-explanation">解析（可选）</label>
        <textarea
          id="create-explanation"
          v-model="explanation"
          rows="3"
          maxlength="10000"
          :disabled="busy"
        ></textarea>
      </div>

      <div class="field create-images-field">
        <label for="create-question-images">
          <ImagePlus :size="15" aria-hidden="true" />
          题目配图（可选）
        </label>
        <input
          id="create-question-images"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          :disabled="busy"
          @change="pickImages"
        />
        <p class="field-hint">
          可在创建前选择 JPG、PNG 或 WebP；每张不超过 10MB，题目创建成功后自动上传关联。
        </p>
        <ul v-if="images.length" class="image-list queued-image-list">
          <li
            v-for="entry in images"
            :key="entry.key"
            class="image-entry"
            :class="entry.status"
          >
            <div class="image-info">
              <p class="image-name">{{ entry.file.name }}</p>
              <input
                v-if="entry.status !== 'uploading'"
                v-model="entry.caption"
                type="text"
                maxlength="300"
                placeholder="图片说明（可选）"
                :aria-label="`图片 ${entry.file.name} 的说明`"
                :disabled="busy"
              />
              <p v-if="entry.status === 'failed'" class="image-error" role="alert">
                {{ entry.error }}
              </p>
            </div>
            <button
              type="button"
              class="button ghost small-button"
              :aria-label="`移除 ${entry.file.name}`"
              :disabled="busy"
              @click="removePending(entry)"
            >
              <X :size="14" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p v-if="images.length" class="queued-image-count" role="status">
          已选择 {{ images.length }} 张配图
        </p>
      </div>

      <div class="form-actions">
        <button class="button" type="submit" :disabled="busy">
          <Plus :size="16" aria-hidden="true" />
          {{ busy ? "正在创建…" : "创建题目" }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.create-section {
  display: grid;
  gap: var(--space-5);
  padding: var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-s);
}

.section-header,
.section-heading {
  display: flex;
  align-items: center;
}

.section-header {
  min-height: 36px;
  justify-content: space-between;
  gap: var(--space-3);
}

.section-heading {
  min-width: 0;
  gap: var(--space-3);
}

.section-icon {
  width: 36px;
  height: 36px;
  flex: none;
  display: inline-grid;
  place-items: center;
  border: 1px solid #c9d2ec;
  border-radius: var(--radius-s);
  color: var(--primary);
  background: var(--primary-soft);
}

.section-title {
  margin: 0;
  font-size: 17px;
}

.section-meta {
  flex: none;
  color: var(--muted);
  font-size: 12px;
}

.create-form,
.created-panel {
  display: grid;
  gap: var(--space-4);
}

.field-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: var(--space-4);
}

.field-row .field {
  min-width: 0;
}

.type-row {
  grid-template-columns: minmax(0, 0.75fr) minmax(0, 1.25fr) minmax(0, 0.75fr);
}

.question-meta-row {
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
}

.field-error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}

.options-fieldset {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-3) var(--space-4) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
}

.options-fieldset legend {
  padding: 0 var(--space-2);
  color: var(--ink-soft);
  font-size: 14px;
  font-weight: 600;
}

.option-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.option-id {
  flex: none;
  width: 20px;
  color: var(--muted);
  font-weight: 600;
}

.option-text {
  flex: 1;
  min-width: 0;
}

.points-input {
  width: 90px;
  flex: none;
}

.answer-input {
  flex: none;
  accent-color: var(--accent);
}

.small-button {
  min-height: 32px;
  padding: 4px 10px;
  font-size: 13px;
}

.image-list {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.create-images-field > label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.queued-image-list {
  margin-top: var(--space-2);
}

.queued-image-count {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.image-entry {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
}

.image-entry.failed {
  border-color: var(--danger-border);
  background: var(--danger-bg);
}

.image-thumb {
  width: 64px;
  height: 48px;
  object-fit: contain;
  flex: none;
  border-radius: var(--radius-s);
}

.image-info {
  display: grid;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
}

.image-name {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.image-caption {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.image-error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}

.image-status {
  color: var(--muted);
  font-size: 13px;
}

.image-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
}

.form-actions .button {
  min-width: 132px;
}

.created-panel > .button {
  justify-self: start;
}

@media (max-width: 680px) {
  .create-section {
    padding: var(--space-4);
  }

  .field-row,
  .type-row,
  .question-meta-row {
    grid-template-columns: 1fr;
  }

  .form-actions .button {
    width: 100%;
  }

  .option-row {
    gap: var(--space-2);
  }

  .points-input {
    width: 72px;
  }
}
</style>
