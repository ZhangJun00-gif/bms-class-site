<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Pencil, RefreshCw, Trash2 } from 'lucide-vue-next';
import AdminQuizEdit from './AdminQuizEdit.vue';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import PaginationControl from '../common/PaginationControl.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import QuizChapterSelect from '../quiz/QuizChapterSelect.vue';
import QuizKeywordSearch from '../quiz/QuizKeywordSearch.vue';
import { api, formatError } from '../../lib/api';
import { useAbortableList } from '../../composables/useAbortableList';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import type {
  QuizFiltersResponse,
  QuizLibraryResponse,
  QuizQuestionDeleteResult,
  QuizQuestionEditorData,
  QuizQuestionSummary,
} from '../../types';

interface ManageQuestion extends QuizQuestionSummary {
  deleting: boolean;
  deleteError: string;
}

const emit = defineEmits<{ deleted: [] }>();
const { confirm } = useConfirm();
const toast = useToast();

const filterGroups = ref<QuizFiltersResponse['subjectGroups']>([]);
const filtersError = ref('');
const filtersLoading = ref(false);

const subjectId = ref('');
const chapterIds = ref<string[]>([]);
const chapterMatch = ref<'ANY' | 'ALL'>('ANY');
const includeCrossChapter = ref(false);
const source = ref('');
const typeLabel = ref('');
const pastPaper = ref<'ALL' | 'EXCLUDE' | 'ONLY'>('ALL');
const searchInput = ref('');
const search = ref('');
const page = ref(1);
const pageSize = ref(20);
const editingId = ref('');
const editorData = ref<QuizQuestionEditorData | null>(null);
const editorLoading = ref(false);
const editorError = ref('');

const activeGroup = computed(() =>
  filterGroups.value.find((group) => group.subjectId === subjectId.value),
);
const chapterOptions = computed(() => activeGroup.value?.chapters ?? []);
const chapterSelectOptions = computed(() =>
  chapterOptions.value.map((chapter) => ({
    id: chapter.chapterId,
    label: chapter.chapter,
    count: chapter.total,
  })),
);
const typeOptions = computed(() => activeGroup.value?.types ?? []);
const pageCount = computed(() =>
  Math.max(1, Math.ceil(total.value / pageSize.value)),
);

const {
  rows: items,
  total,
  loading,
  loaded,
  loadError,
  load,
  abort,
} = useAbortableList<QuizQuestionSummary, ManageQuestion>({
  fetcher(signal) {
    const params = new URLSearchParams();
    if (subjectId.value) params.set('subjectId', subjectId.value);
    if (chapterIds.value.length) {
      params.set('chapterIds', chapterIds.value.join(','));
      params.set('chapterMatch', chapterMatch.value);
    }
    if (includeCrossChapter.value) params.set('includeCrossChapter', 'true');
    if (source.value) params.set('source', source.value);
    if (typeLabel.value) params.set('typeLabel', typeLabel.value);
    if (pastPaper.value !== 'ALL') params.set('pastPaper', pastPaper.value);
    if (search.value) params.set('search', search.value);
    params.set('page', String(page.value));
    params.set('pageSize', String(pageSize.value));
    return api<QuizLibraryResponse>(`/quizzes/questions?${params.toString()}`, {
      signal,
    });
  },
  merge(current, next) {
    const existing = new Map(current.map((item) => [item.id, item]));
    return next.map((question) => {
      const row = existing.get(question.id);
      if (!row) return { ...question, deleting: false, deleteError: '' };
      Object.assign(row, question);
      return row;
    });
  },
  errorMessage: '题目列表加载失败',
});

function loadQuestions() {
  return load();
}

async function loadFilters() {
  filtersLoading.value = true;
  filtersError.value = '';
  try {
    const result = await api<QuizFiltersResponse>('/quizzes/filters');
    filterGroups.value = result.subjectGroups;
    if (
      chapterIds.value.length &&
      chapterIds.value.some(
        (id) => !chapterOptions.value.some((option) => option.chapterId === id),
      )
    ) {
      chapterIds.value = [];
    }
    if (
      typeLabel.value &&
      !typeOptions.value.some((option) => option.label === typeLabel.value)
    ) {
      typeLabel.value = '';
    }
  } catch (caught) {
    filtersError.value = formatError(caught, '题库筛选项加载失败');
  } finally {
    filtersLoading.value = false;
  }
}

function applyFilters() {
  if (page.value === 1) void loadQuestions();
  else {
    page.value = 1;
    void loadQuestions();
  }
}

function changeSubject() {
  chapterIds.value = [];
  chapterMatch.value = 'ANY';
  includeCrossChapter.value = false;
  typeLabel.value = '';
  applyFilters();
}

function changeChapter() {
  typeLabel.value = '';
  applyFilters();
}

function applySearch() {
  search.value = searchInput.value.trim();
  applyFilters();
}

function setPage(next: number) {
  page.value = next;
  void loadQuestions();
}

function changePageSize() {
  page.value = 1;
  void loadQuestions();
}

async function deleteQuestion(question: ManageQuestion) {
  const ok = await confirm({
    title: '删除题目',
    body: `停用“${question.prompt.slice(0, 80)}${
      question.prompt.length > 80 ? '…' : ''
    }”后，该题不再参与题库浏览、随机练习或整套试卷；历史答题记录和快照仍会保留。`,
    confirmText: '删除题目',
    danger: true,
  });
  if (!ok) return;

  question.deleting = true;
  question.deleteError = '';
  try {
    await api<QuizQuestionDeleteResult>(`/quizzes/questions/${question.id}`, {
      method: 'DELETE',
    });
    const shouldMoveBack = items.value.length === 1 && page.value > 1;
    if (shouldMoveBack) page.value -= 1;
    toast.success('题目已停用，历史答题记录保持不变');
    emit('deleted');
    await Promise.all([loadFilters(), loadQuestions()]);
  } catch (caught) {
    question.deleteError = formatError(caught, '题目删除失败');
    question.deleting = false;
  }
}

async function editQuestion(question: ManageQuestion) {
  if (editingId.value === question.id) {
    closeEditor();
    return;
  }
  editingId.value = question.id;
  await loadEditor(question.id);
}

async function loadEditor(questionId: string) {
  editorData.value = null;
  editorError.value = '';
  editorLoading.value = true;
  try {
    editorData.value = await api<QuizQuestionEditorData>(
      `/quizzes/questions/${questionId}`,
    );
  } catch (caught) {
    editorError.value = formatError(caught, '题目详情加载失败');
  } finally {
    editorLoading.value = false;
  }
}

function closeEditor() {
  editingId.value = '';
  editorData.value = null;
  editorError.value = '';
}

async function questionSaved() {
  closeEditor();
  toast.success('题目已更新，历史答题快照保持不变');
  await Promise.all([loadFilters(), loadQuestions()]);
}

onMounted(() => {
  void loadFilters();
  void loadQuestions();
});

onBeforeUnmount(() => abort());

async function reload() {
  await Promise.all([loadFilters(), loadQuestions()]);
}

defineExpose({ reload });
</script>

<template>
  <section class="manage-section" aria-label="题目管理">
    <header class="manage-heading">
      <div>
        <h3>题目管理</h3>
        <p>停用题目不会删除历史答题快照或配图。</p>
      </div>
      <button
        type="button"
        class="icon-button"
        title="刷新题目列表"
        aria-label="刷新题目列表"
        :disabled="loading"
        @click="loadQuestions"
      >
        <RefreshCw :size="16" aria-hidden="true" />
      </button>
    </header>

    <form
      class="manage-filters"
      aria-label="题目管理筛选"
      @submit.prevent="applySearch"
    >
      <div class="field">
        <label for="manage-quiz-subject">学科</label>
        <select
          id="manage-quiz-subject"
          v-model="subjectId"
          :disabled="filtersLoading || loading"
          @change="changeSubject"
        >
          <option value="">全部学科</option>
          <option
            v-for="group in filterGroups"
            :key="group.subjectId"
            :value="group.subjectId"
          >
            {{ group.subject }}
          </option>
        </select>
      </div>
      <div class="field">
        <label for="manage-quiz-chapters">章节</label>
        <QuizChapterSelect
          id="manage-quiz-chapters"
          v-model="chapterIds"
          v-model:match="chapterMatch"
          :options="chapterSelectOptions"
          :disabled="loading || !subjectId"
          :placeholder="subjectId ? '全部章节' : '请先选择学科'"
          @change="changeChapter"
        />
      </div>
      <div class="field">
        <label for="manage-quiz-comprehensive">综合题</label>
        <select
          id="manage-quiz-comprehensive"
          v-model="includeCrossChapter"
          :disabled="loading"
          @change="applyFilters"
        >
          <option :value="false">不加入综合题</option>
          <option :value="true">加入综合题</option>
        </select>
      </div>
      <div class="field">
        <label for="manage-quiz-type">题型</label>
        <select
          id="manage-quiz-type"
          v-model="typeLabel"
          :disabled="loading || !subjectId"
          @change="applyFilters"
        >
          <option value="">
            {{ subjectId ? '全部题型' : '请先选择学科' }}
          </option>
          <option
            v-for="option in typeOptions"
            :key="option.label"
            :value="option.label"
          >
            {{ option.label }}（{{ option.total }}）
          </option>
        </select>
      </div>
      <div class="field">
        <label for="manage-quiz-source">来源</label>
        <select
          id="manage-quiz-source"
          v-model="source"
          :disabled="loading"
          @change="applyFilters"
        >
          <option value="">全部来源</option>
          <option value="AI">AI 生成</option>
          <option value="NON_AI">非 AI</option>
        </select>
      </div>
      <div class="field">
        <label for="manage-quiz-paper">真题范围</label>
        <select
          id="manage-quiz-paper"
          v-model="pastPaper"
          :disabled="loading"
          @change="applyFilters"
        >
          <option value="ALL">全部题目</option>
          <option value="EXCLUDE">排除往年真题</option>
          <option value="ONLY">仅往年真题</option>
        </select>
      </div>
      <QuizKeywordSearch
        id="manage-quiz-search"
        v-model="searchInput"
        :disabled="loading"
      />
    </form>

    <p v-if="filtersError" class="alert error filter-error" role="alert">
      {{ filtersError }}
      <button type="button" class="retry-link" @click="loadFilters">
        重试
      </button>
    </p>

    <SkeletonBlock v-if="loading && !loaded" :lines="6" />
    <ErrorState
      v-else-if="loadError"
      :message="loadError"
      @retry="loadQuestions"
    />
    <EmptyState
      v-else-if="loaded && !items.length"
      title="没有符合条件的题目"
      hint="调整筛选条件后重试"
    />
    <template v-else>
      <p class="result-total" role="status">共 {{ total }} 道启用题目</p>
      <ul class="question-list">
        <li v-for="question in items" :key="question.id" class="question-row">
          <article class="question-summary">
            <div class="question-tags">
              <StatusBadge :text="question.subject" tone="muted" />
              <StatusBadge
                v-for="chapter in question.chapters"
                :key="chapter.id"
                :text="chapter.name"
                tone=""
              />
              <StatusBadge :text="question.typeLabel" tone="accent" />
              <StatusBadge
                :text="question.origin === 'AI_GENERATED' ? 'AI 生成' : '非 AI'"
                tone="muted"
              />
              <StatusBadge
                v-if="question.category === 'KNOWLEDGE_RECALL'"
                text="知识背诵题"
                tone="warning"
              />
              <StatusBadge
                v-if="question.isPastPaper"
                :text="
                  question.pastPaper
                    ? `${question.pastPaper.title}${
                        question.pastPaper.year
                          ? `（${question.pastPaper.year}）`
                          : ''
                      }`
                    : '往年真题'
                "
                tone="warning"
              />
            </div>
            <p>{{ question.prompt }}</p>
            <p v-if="question.deleteError" class="delete-error" role="alert">
              {{ question.deleteError }}
            </p>
          </article>
          <div class="question-actions">
            <button
              type="button"
              class="button ghost edit-button"
              :disabled="question.deleting || editorLoading"
              @click="editQuestion(question)"
            >
              <Pencil :size="15" aria-hidden="true" />
              {{ editingId === question.id ? '关闭编辑' : '编辑题目' }}
            </button>
            <button
              type="button"
              class="button ghost delete-button"
              :disabled="question.deleting"
              @click="deleteQuestion(question)"
            >
              <Trash2 :size="15" aria-hidden="true" />
              {{ question.deleting ? '正在删除…' : '删除题目' }}
            </button>
          </div>
          <div v-if="editingId === question.id" class="question-editor">
            <SkeletonBlock v-if="editorLoading" :lines="4" />
            <p v-else-if="editorError" class="alert error" role="alert">
              {{ editorError }}
              <button
                type="button"
                class="retry-link"
                @click="loadEditor(question.id)"
              >
                重试
              </button>
            </p>
            <AdminQuizEdit
              v-else-if="editorData"
              :question="editorData"
              @saved="questionSaved"
              @cancel="closeEditor"
            />
          </div>
        </li>
      </ul>
      <div class="pagination-row">
        <PaginationControl
          :page="page"
          :page-count="pageCount"
          @update:page="setPage"
        />
        <div class="field page-size">
          <label for="manage-quiz-page-size">每页</label>
          <select
            id="manage-quiz-page-size"
            v-model.number="pageSize"
            :disabled="loading"
            @change="changePageSize"
          >
            <option :value="10">10</option>
            <option :value="20">20</option>
            <option :value="50">50</option>
          </select>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.manage-section {
  min-width: 0;
  display: grid;
  gap: var(--space-4);
  padding-top: var(--space-6);
  border-top: 1px solid var(--border);
}

.manage-heading,
.pagination-row {
  display: flex;
  align-items: center;
}

.manage-heading {
  justify-content: space-between;
  gap: var(--space-4);
}

.manage-heading h3,
.manage-heading p {
  margin: 0;
}

.manage-heading h3 {
  font-size: 17px;
}

.manage-heading p,
.result-total {
  color: var(--muted);
  font-size: 13px;
}

.manage-heading p {
  margin-top: 3px;
}

.manage-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--space-3);
}

.manage-filters .field {
  flex: 1 1 140px;
  min-width: 0;
}

.filter-error,
.result-total {
  margin: 0;
}

.retry-link {
  border: 0;
  background: none;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.question-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border);
}

.question-row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border);
}

.question-summary {
  min-width: 0;
  display: grid;
  gap: var(--space-2);
}

.question-summary p {
  margin: 0;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.question-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.question-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.question-editor {
  min-width: 0;
  grid-column: 1 / -1;
}

.delete-button {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  color: var(--danger);
}

.delete-error {
  color: var(--danger);
  font-size: 13px;
}

.pagination-row {
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.page-size {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

@media (max-width: 560px) {
  .question-row {
    grid-template-columns: 1fr;
  }

  .delete-button {
    justify-self: start;
  }

  .question-actions {
    justify-self: start;
    flex-wrap: wrap;
  }
}
</style>
