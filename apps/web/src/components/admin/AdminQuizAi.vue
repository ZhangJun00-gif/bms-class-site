<script setup lang="ts">
import {
  CheckCircle2,
  Clock3,
  Link2,
  RefreshCw,
  Save,
  Sparkles,
  XCircle,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ApiClientError, api, formatError } from '../../lib/api';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { usePaneVisibility } from '../../composables/usePaneVisibility';
import PaginationControl from '../common/PaginationControl.vue';
import type {
  AiQuestionGenerationComplexity,
  AiQuestionGenerationJob,
  AiQuestionGenerationLibrary,
  AiQuestionGenerationNode,
  AiQuestionGenerationPreview,
  AiQuestionGenerationRequest,
  AiQuestionReviewBulkRevalidateResponse,
  AiQuestionReviewDetail,
  AiQuestionReviewSummary,
  GradingRubric,
  Page,
  QuestionType,
  QuizQuestionReviewStatus,
  QuizQuestionSourceReviewStatus,
  Subject,
  SubjectChapter,
} from '../../types';
import KnowledgeNodePicker from './KnowledgeNodePicker.vue';

const { confirm } = useConfirm();
const chapterRequests = useLatestRequest();
const libraryRequests = useLatestRequest();
const nodeRequests = useLatestRequest();
const jobRequests = useLatestRequest();
const jobMutations = useLatestRequest();
const reviewRequests = useLatestRequest();
const detailRequests = useLatestRequest();
const revalidationRequests = useLatestRequest();
const reviewMutations = useLatestRequest();

const props = withDefaults(defineProps<{
  subjects: Subject[];
  initialSubjectId?: string;
  active?: boolean;
}>(), {
  initialSubjectId: '',
  active: true,
});
const paneVisible = usePaneVisibility(() => props.active);

type AiPane = 'generate' | 'review';
type ReviewSidePane = 'evidence' | 'original';

const activePane = ref<AiPane>('generate');
const subjectId = ref('');
const chapters = ref<SubjectChapter[]>([]);
const chapterIds = ref<string[]>([]);
const gradingType = ref<QuestionType>('SINGLE');
const typeLabel = ref('单选题');
const complexity = ref<AiQuestionGenerationComplexity>('SIMPLE');
const requestedCount = ref(5);
const libraries = ref<AiQuestionGenerationLibrary[]>([]);
const libraryId = ref('');
const nodes = ref<AiQuestionGenerationNode[]>([]);
const nodeIds = ref<string[]>([]);
const nodeQuery = ref('');
const nodePage = ref(1);
const nodeTotal = ref(0);
const nodesLoading = ref(false);
const formBusy = ref(false);
const formError = ref('');
const formMessage = ref('');
const preview = ref<AiQuestionGenerationPreview | null>(null);
const jobs = ref<AiQuestionGenerationJob[]>([]);
const jobsLoading = ref(false);

const reviewStatus = ref<QuizQuestionReviewStatus>('DRAFT_REVIEW');
const sourceReviewStatus = ref<QuizQuestionSourceReviewStatus | ''>('');
const reviewSearch = ref('');
const reviewItems = ref<AiQuestionReviewSummary[]>([]);
const reviewTotal = ref(0);
const reviewsLoading = ref(false);
const reviewsError = ref('');
const selectedReviewId = ref('');
const detail = ref<AiQuestionReviewDetail | null>(null);
const detailLoading = ref(false);
const reviewBusy = ref(false);
const reviewError = ref('');
const reviewMessage = ref('');
const reviewSidePane = ref<ReviewSidePane>('evidence');
const rejectDialog = ref<HTMLDialogElement | null>(null);
const rejectReason = ref('');
const reviewChapters = ref<SubjectChapter[]>([]);
const revalidateLibraries = ref<AiQuestionGenerationLibrary[]>([]);
const revalidateLibraryId = ref('');
const revalidateNodes = ref<AiQuestionGenerationNode[]>([]);
const revalidateNodeIds = ref<string[]>([]);
const revalidateQuery = ref('');
const revalidateTotal = ref(0);
const revalidatePage = ref(1);
const reviewPage = ref(1);
const reviewPageSize = ref(50);
const bulkBusy = ref(false);
const bulkMessage = ref('');
const bulkFailures = ref<Array<{ questionId: string; prompt: string; reason: string }>>([]);
const bulkDialog = ref<HTMLDialogElement | null>(null);

const editor = reactive({
  typeLabel: '',
  chapterIds: [] as string[],
  prompt: '',
  options: [] as Array<{ id: string; text: string }>,
  correctAnswer: [] as string[],
  explanation: '',
  gradingRubric: null as GradingRubric | null,
});

const gradingTypes: Array<{ value: QuestionType; label: string }> = [
  { value: 'SINGLE', label: '单选' },
  { value: 'MULTIPLE', label: '多选' },
  { value: 'TRUE_FALSE', label: '判断' },
  { value: 'SHORT_ANSWER', label: '简答' },
];

const complexities: Array<{
  value: AiQuestionGenerationComplexity;
  label: string;
  strategy: string;
}> = [
  { value: 'SIMPLE', label: '事实回忆', strategy: 'Flash · 标准思考' },
  { value: 'ASSOCIATIVE', label: '关联理解', strategy: 'Flash · 高思考' },
  { value: 'COMPLEX', label: '综合推理', strategy: 'Flash · 高思考' },
  { value: 'MAX', label: '极深推理（Max）', strategy: 'Flash · Max' },
];

const canPreview = computed(
  () =>
    subjectId.value &&
    chapterIds.value.length > 0 &&
    nodeIds.value.length > 0 &&
    requestedCount.value >= 1 &&
    requestedCount.value <= 20,
);
const activeJobs = computed(() =>
  jobs.value.some((job) => ['PENDING', 'PROCESSING'].includes(job.status)),
);
const currentSources = computed(
  () => detail.value?.sources.filter((source) => source.current) ?? [],
);
const reviewPageCount = computed(() =>
  Math.max(1, Math.ceil(reviewTotal.value / reviewPageSize.value)),
);
const reviewReadOnly = computed(() => detail.value?.reviewStatus !== 'DRAFT_REVIEW');
const reviewNavigationBusy = computed(() => reviewBusy.value || bulkBusy.value);

const sourceReviewLabels: Record<QuizQuestionSourceReviewStatus, string> = {
  NOT_APPLICABLE: '无需复审',
  VALID: '来源有效',
  REVIEW_REQUIRED: '待复核',
};

let pollTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  [
    () => props.subjects.map((subject) => subject.id),
    () => props.initialSubjectId,
  ],
  ([ids, initialSubjectId]) => {
    if (initialSubjectId && ids.includes(initialSubjectId)) {
      subjectId.value = initialSubjectId;
    } else if (!ids.includes(subjectId.value)) {
      subjectId.value = ids[0] ?? '';
    }
  },
  { immediate: true },
);

watch(subjectId, async () => {
  chapterIds.value = [];
  libraryId.value = '';
  libraries.value = [];
  nodes.value = [];
  nodeIds.value = [];
  preview.value = null;
  await Promise.all([loadChapters(), loadLibraries()]);
});

watch(libraryId, () => {
  nodeRequests.cancelLatest();
  nodesLoading.value = false;
  nodes.value = [];
  nodeIds.value = [];
  preview.value = null;
  nodePage.value = 1;
  nodeQuery.value = '';
  if (libraryId.value) void loadNodes(false);
});

watch(gradingType, (value) => {
  typeLabel.value = gradingTypes.find((item) => item.value === value)?.label + '题';
  preview.value = null;
});

watch([chapterIds, nodeIds, complexity, requestedCount, typeLabel], () => {
  preview.value = null;
}, { deep: true });

watch(activePane, (pane) => {
  if (pane === 'review') void loadReviews();
});

watch([reviewStatus, sourceReviewStatus], () => {
  reviewPage.value = 1;
  if (activePane.value === 'review') void loadReviews(1);
});

watch(reviewPageSize, () => {
  reviewPage.value = 1;
  if (activePane.value === 'review') void loadReviews(1);
});

async function loadChapters() {
  chapters.value = [];
  if (!paneVisible.value || !subjectId.value) return;
  const requestedSubjectId = subjectId.value;
  await chapterRequests.runLatest(
    ({ signal }) => api<SubjectChapter[]>(`/subjects/${requestedSubjectId}/chapters`, { signal }),
    {
      commit(value) {
        if (subjectId.value === requestedSubjectId) chapters.value = value;
      },
      onError(caught) {
        if (subjectId.value === requestedSubjectId)
          formError.value = formatError(caught, '题库章节加载失败');
      },
    },
  );
}

async function loadLibraries() {
  libraries.value = [];
  if (!paneVisible.value || !subjectId.value) return;
  const requestedSubjectId = subjectId.value;
  await libraryRequests.runLatest(
    ({ signal }) => api<{ items: AiQuestionGenerationLibrary[]; total: number }>(
      `/ai/question-generation/sources/libraries?subjectId=${encodeURIComponent(requestedSubjectId)}`,
      { signal },
    ),
    {
      commit(result) {
        if (subjectId.value !== requestedSubjectId) return;
        libraries.value = result.items;
        libraryId.value = result.items[0]?.id ?? '';
      },
      onError(caught) {
        if (subjectId.value === requestedSubjectId)
          formError.value = formatError(caught, '共享知识库加载失败');
      },
    },
  );
}

async function loadNodes(append: boolean) {
  if (!paneVisible.value || !libraryId.value || !subjectId.value) return;
  nodesLoading.value = true;
  formError.value = '';
  const page = append ? nodePage.value + 1 : 1;
  const requestedSubjectId = subjectId.value;
  const requestedLibraryId = libraryId.value;
  await nodeRequests.runLatest(async ({ signal }) => {
    const params = new URLSearchParams({
      subjectId: requestedSubjectId,
      page: String(page),
      pageSize: '100',
    });
    if (nodeQuery.value.trim()) params.set('query', nodeQuery.value.trim());
    return api<{
      items: AiQuestionGenerationNode[];
      total: number;
      page: number;
    }>(`/ai/question-generation/sources/libraries/${requestedLibraryId}/nodes?${params}`, { signal });
  }, {
    commit(result) {
      if (subjectId.value !== requestedSubjectId || libraryId.value !== requestedLibraryId) return;
      nodes.value = append ? [...nodes.value, ...result.items] : result.items;
      nodeTotal.value = result.total;
      nodePage.value = result.page;
    },
    onError(caught) {
      if (subjectId.value === requestedSubjectId && libraryId.value === requestedLibraryId)
        formError.value = formatError(caught, '知识节点加载失败');
    },
    onFinally() {
      if (subjectId.value === requestedSubjectId && libraryId.value === requestedLibraryId)
        nodesLoading.value = false;
    },
  });
}

function requestPayload(): AiQuestionGenerationRequest {
  return {
    subjectId: subjectId.value,
    chapterIds: chapterIds.value,
    knowledgeNodeIds: nodeIds.value,
    gradingType: gradingType.value,
    typeLabel: typeLabel.value.trim(),
    complexity: complexity.value,
    requestedCount: requestedCount.value,
  };
}

async function previewGeneration() {
  formBusy.value = true;
  formError.value = '';
  formMessage.value = '';
  try {
    preview.value = await api<AiQuestionGenerationPreview>(
      '/ai/question-generation-jobs/preview',
      { method: 'POST', body: JSON.stringify(requestPayload()) },
    );
    formMessage.value = '预检通过，可以创建生成任务';
  } catch (caught) {
    formError.value = formatError(caught, '预检失败');
  } finally {
    formBusy.value = false;
  }
}

async function createGeneration() {
  if (!preview.value) return;
  formBusy.value = true;
  formError.value = '';
  formMessage.value = '';
  try {
    const job = await api<AiQuestionGenerationJob>('/ai/question-generation-jobs', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(requestPayload()),
    });
    formMessage.value = `任务已创建，将生成 ${job.requestedCount} 道待审核题`;
    await loadJobs();
  } catch (caught) {
    formError.value = formatError(caught, '任务创建失败');
  } finally {
    formBusy.value = false;
  }
}

async function loadJobs() {
  if (!paneVisible.value) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
  jobsLoading.value = true;
  const result = await jobRequests.runLatest(
    ({ signal }) => api<Page<AiQuestionGenerationJob>>(
      '/ai/question-generation-jobs?page=1&pageSize=20',
      { signal },
    ),
    {
      commit(result) { jobs.value = result.items; },
      onError(caught) { formError.value = formatError(caught, '任务列表加载失败'); },
      onFinally() { jobsLoading.value = false; },
    },
  );
  if (result.status !== 'aborted' && result.status !== 'stale') schedulePoll();
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  if (paneVisible.value && activeJobs.value)
    pollTimer = setTimeout(() => void loadJobs(), 3000);
}

async function cancelJob(job: AiQuestionGenerationJob) {
  formError.value = '';
  await jobMutations.runBusy(`cancel:${job.id}`, async () => {
    try {
      await api(`/ai/question-generation-jobs/${job.id}/cancel`, { method: 'POST' });
      await loadJobs();
    } catch (caught) {
      formError.value = formatError(caught, '任务取消失败');
      if (caught instanceof ApiClientError && caught.status === 409) await loadJobs();
    }
  });
}

async function loadReviews(nextPage = reviewPage.value) {
  if (!paneVisible.value) return;
  reviewsLoading.value = true;
  reviewsError.value = '';
  const requestedStatus = reviewStatus.value;
  const requestedSourceStatus = sourceReviewStatus.value;
  const requestedSearch = reviewSearch.value.trim();
  await reviewRequests.runPage(reviewPage, nextPage, async ({ signal }) => {
    const params = new URLSearchParams({
      reviewStatus: requestedStatus,
      page: String(nextPage),
      pageSize: String(reviewPageSize.value),
    });
    if (requestedSourceStatus) params.set('sourceReviewStatus', requestedSourceStatus);
    if (requestedSearch) params.set('search', requestedSearch);
    return api<Page<AiQuestionReviewSummary>>(`/ai/question-reviews?${params}`, { signal });
  }, {
    commit(result) {
      if (
        reviewStatus.value !== requestedStatus ||
        sourceReviewStatus.value !== requestedSourceStatus ||
        reviewSearch.value.trim() !== requestedSearch
      ) return;
      reviewItems.value = result.items;
      reviewTotal.value = result.total;
      reviewPage.value = result.page;
      if (selectedReviewId.value && !result.items.some((item) => item.id === selectedReviewId.value)) {
        detailRequests.cancelLatest();
        detailLoading.value = false;
        selectedReviewId.value = '';
        detail.value = null;
      }
    },
    onError(caught) { reviewsError.value = formatError(caught, '审核队列加载失败'); },
    onFinally() { reviewsLoading.value = false; },
  });
}

function searchReviews() {
  if (reviewNavigationBusy.value) return;
  reviewPage.value = 1;
  void loadReviews(1);
}

function changeReviewPage(page: number) {
  if (!reviewNavigationBusy.value) void loadReviews(page);
}

function clearRevalidationState() {
  revalidationRequests.cancelLatest();
  revalidateLibraries.value = [];
  revalidateLibraryId.value = '';
  revalidateNodes.value = [];
  revalidateNodeIds.value = [];
  revalidateQuery.value = '';
  revalidateTotal.value = 0;
  revalidatePage.value = 1;
}

function bulkReasonLabel(reason: string | null) {
  switch (reason) {
    case 'NOT_FOUND':
      return '题目不存在';
    case 'NOT_PENDING_SOURCE_REVIEW':
      return '非待复核状态';
    case 'SOURCE_PATH_UNKNOWN':
      return '来源缺少路径哈希';
    case 'SOURCE_NODE_NOT_FOUND':
      return '未找到可解析的当前节点';
    case 'SOURCE_NODE_AMBIGUOUS':
      return '存在多个候选文档，需人工选择';
    case 'AI_GENERATION_UNKNOWN_NODE':
      return '目标节点不可用';
    case 'AI_GENERATION_SCOPE_INVALID':
      return '目标节点缺少可用正文';
    default:
      return reason ?? '未知原因';
  }
}

async function bulkRebindSources() {
  if (!reviewItems.value.length || reviewNavigationBusy.value) return;
  const reviewSnapshot = reviewItems.value.map((item) => ({
    id: item.id,
    prompt: item.prompt,
  }));
  const selectedQuestionId = selectedReviewId.value;
  const confirmed = await confirm({
    title: '批量自动重绑来源',
    body: `将对当前列表中的 ${reviewSnapshot.length} 道题尝试自动重绑到当前有效文档节点（同库唯一匹配替换文档），逐题记录审计。无法唯一匹配的题目将保持待复核状态。`,
    confirmText: '开始重绑',
  });
  if (!confirmed || reviewNavigationBusy.value) return;
  bulkBusy.value = true;
  bulkMessage.value = '';
  reviewsError.value = '';
  try {
    const result = await api<AiQuestionReviewBulkRevalidateResponse>(
      '/ai/question-reviews/revalidate-source/bulk',
      {
        method: 'POST',
        body: JSON.stringify({ questionIds: reviewSnapshot.map((item) => item.id) }),
      },
    );
    const revalidated = result.results.filter((item) => item.status === 'REVALIDATED').length;
    const skipped = result.results.filter((item) => item.status === 'SKIPPED').length;
    const failures = result.results.filter((item) => item.status === 'FAILED');
    bulkMessage.value = `重绑完成：成功 ${revalidated} · 跳过 ${skipped} · 失败 ${failures.length}`;
    if (failures.length) {
      bulkFailures.value = failures.map((item) => ({
        questionId: item.questionId,
        prompt:
          reviewSnapshot.find((candidate) => candidate.id === item.questionId)?.prompt ??
          item.questionId,
        reason: bulkReasonLabel(item.reason ?? null),
      }));
      bulkDialog.value?.showModal();
    }
    if (
      detail.value &&
      result.results.some(
        (item) => item.questionId === detail.value!.id && item.status === 'REVALIDATED',
      )
    ) {
      await openReview(detail.value.id);
    }
    await loadReviews();
  } catch (caught) {
    const message = formatError(caught, '批量重绑失败');
    if (caught instanceof ApiClientError && caught.status === 409) {
      await loadReviews();
      if (selectedReviewId.value === selectedQuestionId && selectedQuestionId) {
        await openReview(selectedQuestionId);
      }
      reviewsError.value = message;
    } else {
      reviewsError.value = message;
    }
  } finally {
    bulkBusy.value = false;
  }
}

async function autoRebindDetail() {
  if (!detail.value || reviewNavigationBusy.value) return;
  const questionId = detail.value.id;
  reviewBusy.value = true;
  reviewError.value = '';
  reviewMessage.value = '';
  try {
    const result = await api<AiQuestionReviewBulkRevalidateResponse>(
      '/ai/question-reviews/revalidate-source/bulk',
      { method: 'POST', body: JSON.stringify({ questionIds: [questionId] }) },
    );
    const outcome = result.results[0];
    if (outcome?.status === 'REVALIDATED') {
      await loadReviews();
      if (selectedReviewId.value === questionId) {
        await openReview(questionId);
        if (selectedReviewId.value === questionId)
          reviewMessage.value = '来源已自动重绑并恢复有效';
      }
    } else {
      if (selectedReviewId.value === questionId)
        reviewError.value = `自动重绑失败：${bulkReasonLabel(outcome?.reason ?? null)}，请改用下方人工选择。`;
    }
  } catch (caught) {
    if (selectedReviewId.value === questionId)
      reviewError.value = formatError(caught, '自动重绑失败');
    if (caught instanceof ApiClientError && caught.status === 409)
      await refreshReviewConflict(questionId);
  } finally {
    reviewBusy.value = false;
  }
}

async function openReview(id: string) {
  if (!paneVisible.value) return;
  selectedReviewId.value = id;
  detail.value = null;
  reviewChapters.value = [];
  clearRevalidationState();
  detailLoading.value = true;
  reviewError.value = '';
  reviewMessage.value = '';
  const result = await detailRequests.runLatest(async ({ signal }) => {
    const nextDetail = await api<AiQuestionReviewDetail>(`/ai/question-reviews/${id}`, { signal });
    const nextChapters = await api<SubjectChapter[]>(
      `/subjects/${nextDetail.subjectId}/chapters`,
      { signal },
    );
    return { nextDetail, nextChapters };
  }, {
    commit({ nextDetail, nextChapters }) {
      if (selectedReviewId.value !== id) return;
      detail.value = nextDetail;
      reviewChapters.value = nextChapters;
      editor.typeLabel = nextDetail.typeLabel;
      editor.chapterIds = [...nextDetail.chapterIds];
      editor.prompt = nextDetail.prompt;
      editor.options = nextDetail.options.map((option) => ({ ...option }));
      editor.correctAnswer = [...nextDetail.correctAnswer];
      editor.explanation = nextDetail.explanation;
      editor.gradingRubric = nextDetail.gradingRubric
        ? { ...nextDetail.gradingRubric, criteria: nextDetail.gradingRubric.criteria.map((item) => ({ ...item })) }
        : null;
    },
    onError(caught) {
      if (selectedReviewId.value === id)
        reviewError.value = formatError(caught, '审核详情加载失败');
    },
    onFinally() {
      if (selectedReviewId.value === id) detailLoading.value = false;
    },
  });
  if (
    result.status === 'committed' &&
    selectedReviewId.value === id &&
    result.value.nextDetail.sourceReviewStatus === 'REVIEW_REQUIRED'
  ) await prepareSourceRevalidation();
}

function reviewPayload() {
  if (!detail.value) throw new Error('未选择审核题目');
  return {
    expectedRevision: detail.value.reviewRevision,
    typeLabel: editor.typeLabel,
    chapterIds: editor.chapterIds,
    prompt: editor.prompt,
    options: editor.options,
    correctAnswer: editor.correctAnswer,
    gradingRubric: editor.gradingRubric,
    explanation: editor.explanation,
  };
}

async function refreshReviewConflict(questionId: string) {
  await loadReviews();
  if (selectedReviewId.value === questionId) await openReview(questionId);
}

async function mutateReview(mode: 'save' | 'approve') {
  if (!detail.value || reviewReadOnly.value || reviewNavigationBusy.value) return;
  const questionId = detail.value.id;
  const payload = reviewPayload();
  reviewBusy.value = true;
  reviewError.value = '';
  reviewMessage.value = '';
  try {
    const path = mode === 'approve'
      ? `/ai/question-reviews/${questionId}/approve`
      : `/ai/question-reviews/${questionId}`;
    await api(path, {
      method: mode === 'approve' ? 'POST' : 'PATCH',
      body: JSON.stringify(payload),
    });
    if (mode === 'approve') {
      reviewMessage.value = '题目已发布';
      await advanceReview(questionId);
    } else {
      reviewMessage.value = '草稿已保存';
      if (selectedReviewId.value === questionId) await openReview(questionId);
    }
  } catch (caught) {
    reviewError.value = formatError(caught, mode === 'approve' ? '发布失败' : '保存失败');
    if (caught instanceof ApiClientError && caught.status === 409)
      await refreshReviewConflict(questionId);
  } finally {
    reviewBusy.value = false;
  }
}

async function reopenReview() {
  const current = detail.value;
  if (!current || current.reviewStatus !== 'APPROVED' || reviewNavigationBusy.value) return;
  const accepted = await confirm({
    title: '撤回并重新审核',
    body: '撤回后该题会立即退出新练习与每日计划候选，重新审批后才会恢复。历史答题快照不会改变。',
    confirmText: '撤回并重新审核',
    danger: true,
  });
  if (!accepted) return;
  const questionId = current.id;
  reviewBusy.value = true;
  reviewError.value = '';
  reviewMessage.value = '';
  try {
    await reviewMutations.runBusy(`reopen:${questionId}`, async () => {
      await api(`/ai/question-reviews/${questionId}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: current.reviewRevision }),
      });
      reviewStatus.value = 'DRAFT_REVIEW';
      await loadReviews(1);
      await openReview(questionId);
      reviewMessage.value = '题目已撤回，可以重新编辑审核';
    });
  } catch (caught) {
    if (selectedReviewId.value === questionId)
      reviewError.value = formatError(caught, '撤回失败');
    if (caught instanceof ApiClientError && caught.status === 409)
      await refreshReviewConflict(questionId);
  } finally {
    reviewBusy.value = false;
  }
}

function openRejectDialog() {
  rejectReason.value = '';
  rejectDialog.value?.showModal();
}

async function rejectReview() {
  if (!detail.value || !rejectReason.value.trim() || reviewNavigationBusy.value) return;
  const questionId = detail.value.id;
  const expectedRevision = detail.value.reviewRevision;
  const reason = rejectReason.value.trim();
  reviewBusy.value = true;
  reviewError.value = '';
  try {
    await api(`/ai/question-reviews/${questionId}/reject`, {
      method: 'POST',
      body: JSON.stringify({
        expectedRevision,
        reason,
      }),
    });
    rejectDialog.value?.close();
    reviewMessage.value = '题目已拒绝';
    await advanceReview(questionId);
  } catch (caught) {
    if (selectedReviewId.value === questionId)
      reviewError.value = formatError(caught, '拒绝失败');
    if (caught instanceof ApiClientError && caught.status === 409)
      await refreshReviewConflict(questionId);
  } finally {
    reviewBusy.value = false;
  }
}

async function advanceReview(previousId: string = selectedReviewId.value) {
  await loadReviews();
  const next = reviewItems.value.find((item) => item.id !== previousId);
  if (next) await openReview(next.id);
  else {
    selectedReviewId.value = '';
    detail.value = null;
  }
}

async function prepareSourceRevalidation() {
  if (!detail.value) return;
  const questionId = detail.value.id;
  const requestedSubjectId = detail.value.subjectId;
  clearRevalidationState();
  const result = await revalidationRequests.runLatest(
    ({ signal }) => api<{ items: AiQuestionGenerationLibrary[] }>(
      `/ai/question-generation/sources/libraries?subjectId=${encodeURIComponent(requestedSubjectId)}`,
      { signal },
    ),
    {
      commit(result) {
        if (detail.value?.id !== questionId) return;
        revalidateLibraries.value = result.items;
        const currentLibrary = currentSources.value[0]?.libraryId;
        revalidateLibraryId.value = result.items.some((item) => item.id === currentLibrary)
          ? currentLibrary!
          : result.items[0]?.id ?? '';
        revalidateNodeIds.value = currentSources.value.flatMap((source) =>
          source.knowledgeNodeId ? [source.knowledgeNodeId] : [],
        );
      },
      onError(caught) {
        if (detail.value?.id === questionId)
          reviewError.value = formatError(caught, '来源候选加载失败');
      },
    },
  );
  if (
    result.status === 'committed' &&
    detail.value?.id === questionId &&
    revalidateLibraryId.value
  )
    await loadRevalidateNodes(false);
}

async function loadRevalidateNodes(append: boolean) {
  if (!detail.value || !revalidateLibraryId.value) return;
  const questionId = detail.value.id;
  const requestedLibraryId = revalidateLibraryId.value;
  const page = append ? revalidatePage.value + 1 : 1;
  const params = new URLSearchParams({
    subjectId: detail.value.subjectId,
    page: String(page),
    pageSize: '100',
  });
  if (revalidateQuery.value.trim()) params.set('query', revalidateQuery.value.trim());
  await revalidationRequests.runLatest(
    ({ signal }) => api<{ items: AiQuestionGenerationNode[]; total: number; page: number }>(
      `/ai/question-generation/sources/libraries/${requestedLibraryId}/nodes?${params}`,
      { signal },
    ),
    {
      commit(result) {
        if (detail.value?.id !== questionId || revalidateLibraryId.value !== requestedLibraryId)
          return;
        revalidateNodes.value = append ? [...revalidateNodes.value, ...result.items] : result.items;
        revalidateTotal.value = result.total;
        revalidatePage.value = result.page;
      },
      onError(caught) {
        if (detail.value?.id === questionId)
          reviewError.value = formatError(caught, '来源节点加载失败');
      },
    },
  );
}

async function revalidateSource() {
  if (!detail.value || !revalidateNodeIds.value.length || reviewNavigationBusy.value) return;
  const questionId = detail.value.id;
  const expectedRevision = detail.value.reviewRevision;
  const knowledgeNodeIds = [...revalidateNodeIds.value];
  reviewBusy.value = true;
  reviewError.value = '';
  try {
    await api(`/ai/question-reviews/${questionId}/revalidate-source`, {
      method: 'POST',
      body: JSON.stringify({
        expectedRevision,
        knowledgeNodeIds,
      }),
    });
    await loadReviews();
    if (selectedReviewId.value === questionId) {
      await openReview(questionId);
      if (selectedReviewId.value === questionId)
        reviewMessage.value = '知识来源已重新绑定并复核';
    }
  } catch (caught) {
    if (selectedReviewId.value === questionId)
      reviewError.value = formatError(caught, '来源复核失败');
    if (caught instanceof ApiClientError && caught.status === 409)
      await refreshReviewConflict(questionId);
  } finally {
    reviewBusy.value = false;
  }
}

function toggleCorrectAnswer(id: string) {
  if (detail.value?.gradingType === 'SINGLE' || detail.value?.gradingType === 'TRUE_FALSE') {
    editor.correctAnswer = [id];
    return;
  }
  const next = new Set(editor.correctAnswer);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  editor.correctAnswer = [...next];
}

function addOption() {
  const id = String.fromCharCode(65 + editor.options.length);
  editor.options.push({ id, text: '' });
}

function removeOption(index: number) {
  const [removed] = editor.options.splice(index, 1);
  if (removed) editor.correctAnswer = editor.correctAnswer.filter((id) => id !== removed.id);
}

function addCriterion() {
  if (!editor.gradingRubric) editor.gradingRubric = { criteria: [] };
  editor.gradingRubric.criteria.push({ description: '', points: 1 });
}

watch(paneVisible, (visible) => {
  if (!visible) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    chapterRequests.cancelLatest();
    libraryRequests.cancelLatest();
    nodeRequests.cancelLatest();
    jobRequests.cancelLatest();
    reviewRequests.cancelLatest();
    detailRequests.cancelLatest();
    revalidationRequests.cancelLatest();
    nodesLoading.value = false;
    jobsLoading.value = false;
    reviewsLoading.value = false;
    detailLoading.value = false;
    return;
  }
  void loadJobs();
  if (subjectId.value) void Promise.all([loadChapters(), loadLibraries()]);
  if (activePane.value === 'review') {
    void loadReviews(reviewPage.value);
    if (selectedReviewId.value && !detail.value)
      void openReview(selectedReviewId.value);
  }
});

onMounted(() => {
  if (paneVisible.value) {
    void loadJobs();
    if (subjectId.value) void Promise.all([loadChapters(), loadLibraries()]);
  }
});

onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer);
});
</script>

<template>
  <section class="ai-workspace" aria-label="AI 出题与审核">
    <div class="ai-subtabs" role="tablist" aria-label="AI 出题工作区">
      <button type="button" role="tab" :aria-selected="activePane === 'generate'" :class="{ active: activePane === 'generate' }" :disabled="reviewNavigationBusy" @click="activePane = 'generate'">
        <Sparkles :size="16" />生成任务
      </button>
      <button type="button" role="tab" :aria-selected="activePane === 'review'" :class="{ active: activePane === 'review' }" :disabled="reviewNavigationBusy" @click="activePane = 'review'">
        <CheckCircle2 :size="16" />审核队列
      </button>
    </div>

    <div v-if="activePane === 'generate'" class="generation-layout">
      <form class="generation-form" @submit.prevent="previewGeneration">
        <div class="field">
          <label for="ai-subject">学科</label>
          <select id="ai-subject" v-model="subjectId">
            <option disabled value="">请选择学科</option>
            <option v-for="subject in subjects" :key="subject.id" :value="subject.id">{{ subject.name }}</option>
          </select>
        </div>

        <fieldset class="choice-list">
          <legend>题库目标章节（{{ chapterIds.length }} / 20）</legend>
          <label v-for="chapter in chapters" :key="chapter.id">
            <input v-model="chapterIds" type="checkbox" :value="chapter.id" :disabled="!chapterIds.includes(chapter.id) && chapterIds.length >= 20" />
            <span>{{ chapter.name }}</span>
          </label>
        </fieldset>

        <fieldset class="segmented four">
          <legend>判分类型</legend>
          <label v-for="item in gradingTypes" :key="item.value" :class="{ active: gradingType === item.value }">
            <input v-model="gradingType" type="radio" :value="item.value" />{{ item.label }}
          </label>
        </fieldset>

        <div class="field">
          <label for="ai-type-label">题型标签</label>
          <input id="ai-type-label" v-model="typeLabel" maxlength="100" />
        </div>

        <fieldset class="segmented complexity-grid">
          <legend>复杂度</legend>
          <label v-for="item in complexities" :key="item.value" :class="{ active: complexity === item.value }">
            <input v-model="complexity" type="radio" :value="item.value" />
            <span>{{ item.label }}<small>{{ item.strategy }}</small></span>
          </label>
        </fieldset>

        <div class="field count-field">
          <label for="ai-count">生成数量</label>
          <input id="ai-count" v-model.number="requestedCount" type="number" min="1" max="20" />
        </div>

        <button type="submit" class="button secondary" :disabled="formBusy || !canPreview">
          <RefreshCw :size="16" />{{ formBusy ? '正在预检…' : '预检范围' }}
        </button>
      </form>

      <div class="generation-main">
        <section class="source-section">
          <header class="compact-header">
            <div><h3>知识证据</h3><p>仅列出同学科共享、活动、已发布且索引就绪的 Markdown</p></div>
          </header>
          <div class="field">
            <label for="ai-library">共享知识库</label>
            <select id="ai-library" v-model="libraryId">
              <option disabled value="">没有可用知识库</option>
              <option v-for="library in libraries" :key="library.id" :value="library.id">{{ library.name }}（{{ library.nodeCount }} 个标题）</option>
            </select>
          </div>
          <KnowledgeNodePicker v-model="nodeIds" v-model:query="nodeQuery" :nodes="nodes" :total="nodeTotal" :loading="nodesLoading" @search="loadNodes(false)" @load-more="loadNodes(true)" />
        </section>

        <section class="preview-section" aria-live="polite">
          <header class="compact-header"><div><h3>任务预检</h3><p>创建任务前不会调用模型</p></div></header>
          <div v-if="preview" class="preview-metrics">
            <span><strong>{{ preview.nodeCount }}</strong> 条末级证据</span>
            <span><strong>{{ preview.chunkCount }}</strong> 分片</span>
            <span><strong>{{ preview.evidenceTokens }}</strong> token</span>
            <span><strong>{{ preview.dedupCandidates }}</strong> 去重候选</span>
            <span><strong>{{ complexities.find((item) => item.value === complexity)?.label }}</strong> · {{ complexities.find((item) => item.value === complexity)?.strategy }}</span>
          </div>
          <p v-else class="empty-copy">选择目标章节和知识证据后执行预检。</p>
          <button type="button" class="button" :disabled="formBusy || !preview" @click="createGeneration">
            <Sparkles :size="16" />{{ formBusy ? '正在创建…' : '创建生成任务' }}
          </button>
          <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
          <p v-else-if="formMessage" class="alert success" role="status">{{ formMessage }}</p>
        </section>

        <section class="jobs-section">
          <header class="compact-header">
            <div><h3>最近任务</h3><p>生成完成后进入逐题审核，不会自动发布</p></div>
            <button type="button" class="icon-button" title="刷新任务" aria-label="刷新任务" :disabled="jobsLoading" @click="loadJobs"><RefreshCw :size="16" /></button>
          </header>
          <p v-if="jobsLoading && !jobs.length" class="empty-copy">正在加载任务…</p>
          <p v-else-if="!jobs.length" class="empty-copy">暂无 AI 出题任务</p>
          <ul v-else class="job-list">
            <li v-for="job in jobs" :key="job.id">
              <div class="job-main">
                <span class="status-badge" :data-status="job.status">{{ job.status }}</span>
                <strong>{{ job.subject.name }} · {{ job.typeLabel }} · {{ job.requestedCount }} 题</strong>
                <small>{{ job.stage }} · {{ new Date(job.createdAt).toLocaleString() }}</small>
                <small v-if="job.errorMessage" class="job-error">{{ job.errorCategory }}：{{ job.errorMessage }}</small>
              </div>
              <div class="job-actions">
                <button v-if="['PENDING', 'PROCESSING'].includes(job.status)" type="button" class="button ghost" :disabled="jobMutations.isBusy(`cancel:${job.id}`)" @click="cancelJob(job)">取消</button>
                <button v-if="job.status === 'COMPLETED'" type="button" class="button ghost" @click="activePane = 'review'">进入审核</button>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <div v-else class="review-layout" :class="{ 'detail-open': detail }">
      <aside class="review-queue">
        <header class="compact-header"><div><h3>审核队列</h3><p>共 {{ reviewTotal }} 道题</p></div></header>
        <form class="review-filters" @submit.prevent="searchReviews">
          <select v-model="reviewStatus" aria-label="审核状态" :disabled="reviewNavigationBusy">
            <option value="DRAFT_REVIEW">待审核</option><option value="APPROVED">已发布</option><option value="REJECTED">已拒绝</option>
          </select>
          <select v-model="sourceReviewStatus" aria-label="来源状态" :disabled="reviewNavigationBusy">
            <option value="">全部来源</option><option value="VALID">来源有效</option><option value="REVIEW_REQUIRED">待复核</option>
          </select>
          <input v-model="reviewSearch" aria-label="搜索题干" placeholder="搜索题干" maxlength="200" :disabled="reviewNavigationBusy" />
          <button type="submit" class="button ghost" :disabled="reviewNavigationBusy">搜索</button>
        </form>
        <div v-if="sourceReviewStatus === 'REVIEW_REQUIRED' && reviewStatus !== 'APPROVED'" class="queue-tools">
          <button
            type="button"
            class="button secondary"
            :disabled="reviewNavigationBusy || reviewsLoading || !reviewItems.length"
            @click="bulkRebindSources"
          >
            <Link2 :size="16" />{{ bulkBusy ? '正在重绑…' : '批量自动重绑来源' }}
          </button>
          <p v-if="bulkMessage" class="alert success" role="status">{{ bulkMessage }}</p>
        </div>
        <p v-if="reviewsError" class="alert error" role="alert">{{ reviewsError }}</p>
        <p v-else-if="reviewsLoading && !reviewItems.length" class="empty-copy">正在加载审核队列…</p>
        <p v-else-if="!reviewItems.length" class="empty-copy">当前筛选下没有题目</p>
        <ul v-else class="review-list">
          <li v-for="item in reviewItems" :key="item.id">
            <button type="button" :class="{ active: selectedReviewId === item.id }" :disabled="reviewNavigationBusy || detailLoading" @click="openReview(item.id)">
              <span class="review-row-meta"><span>{{ item.typeLabel }}</span><span :class="['source-state', item.sourceReviewStatus.toLowerCase()]">{{ sourceReviewLabels[item.sourceReviewStatus] }}</span></span>
              <strong>{{ item.prompt }}</strong>
              <small>{{ item.subject.name }} · {{ item.chapters.map((chapter) => chapter.name).join('、') }} · r{{ item.reviewRevision }}</small>
            </button>
          </li>
        </ul>
        <div v-if="reviewTotal" class="queue-pagination">
          <select v-model.number="reviewPageSize" aria-label="每页数量" :disabled="reviewNavigationBusy">
            <option :value="20">20 / 页</option>
            <option :value="50">50 / 页</option>
          </select>
          <PaginationControl
            :page="reviewPage"
            :page-count="reviewPageCount"
            @update:page="changeReviewPage"
          />
        </div>
      </aside>

      <main class="review-editor">
        <button v-if="detail" type="button" class="button ghost review-back" :disabled="reviewNavigationBusy || detailLoading" @click="detail = null; selectedReviewId = ''">返回队列</button>
        <p v-if="detailLoading" class="empty-copy" role="status">正在加载题目…</p>
        <p v-else-if="reviewError && !detail" class="alert error" role="alert">{{ reviewError }}</p>
        <div v-else-if="detail" class="editor-content">
          <header class="editor-header">
            <div><h3>{{ detail.subject.name }} · {{ detail.typeLabel }}</h3><p>审核版本 r{{ detail.reviewRevision }} · 来源版本 {{ detail.sourceRevision }}</p></div>
            <span :class="['source-state', detail.sourceReviewStatus.toLowerCase()]">{{ sourceReviewLabels[detail.sourceReviewStatus] }}</span>
          </header>

          <div class="field"><label for="review-type-label">题型标签</label><input id="review-type-label" v-model="editor.typeLabel" maxlength="100" :disabled="reviewReadOnly || reviewNavigationBusy" /></div>
          <fieldset class="choice-list compact" :disabled="reviewReadOnly || reviewNavigationBusy"><legend>题库章节</legend><label v-for="chapter in reviewChapters" :key="chapter.id"><input v-model="editor.chapterIds" type="checkbox" :value="chapter.id" /><span>{{ chapter.name }}</span></label></fieldset>
          <div class="field"><label for="review-prompt">题干</label><textarea id="review-prompt" v-model="editor.prompt" rows="6" maxlength="10000" :disabled="reviewReadOnly || reviewNavigationBusy" /></div>

          <fieldset v-if="detail.gradingType !== 'SHORT_ANSWER'" class="option-editor">
            <legend>选项与答案</legend>
            <div v-for="(option, index) in editor.options" :key="`${option.id}-${index}`" class="option-row">
              <input :type="detail.gradingType === 'MULTIPLE' ? 'checkbox' : 'radio'" name="correct-answer" :checked="editor.correctAnswer.includes(option.id)" :disabled="reviewReadOnly || reviewNavigationBusy" :aria-label="`将 ${option.id} 设为正确答案`" @change="toggleCorrectAnswer(option.id)" />
              <input v-model="option.id" class="option-id" maxlength="80" aria-label="选项 ID" :disabled="reviewReadOnly || reviewNavigationBusy" />
              <input v-model="option.text" maxlength="2000" :aria-label="`选项 ${option.id} 文本`" :disabled="reviewReadOnly || reviewNavigationBusy" />
              <button type="button" class="icon-button small" title="删除选项" aria-label="删除选项" :disabled="reviewReadOnly || reviewNavigationBusy" @click="removeOption(index)"><XCircle :size="15" /></button>
            </div>
            <button v-if="detail.gradingType !== 'TRUE_FALSE'" type="button" class="button ghost" :disabled="reviewReadOnly || reviewNavigationBusy" @click="addOption">添加选项</button>
          </fieldset>

          <template v-else>
            <div class="field"><label for="review-answer">参考答案</label><textarea id="review-answer" :value="editor.correctAnswer[0] ?? ''" rows="4" :disabled="reviewReadOnly || reviewNavigationBusy" @input="editor.correctAnswer = [($event.target as HTMLTextAreaElement).value]" /></div>
            <fieldset class="rubric-editor" :disabled="reviewReadOnly || reviewNavigationBusy"><legend>评分点</legend><div v-for="(criterion, index) in editor.gradingRubric?.criteria ?? []" :key="index" class="criterion-row"><input v-model="criterion.description" maxlength="1000" placeholder="评分点" /><input v-model.number="criterion.points" type="number" min="1" max="100" aria-label="分值" /></div><button type="button" class="button ghost" @click="addCriterion">添加评分点</button></fieldset>
          </template>

          <div class="field"><label for="review-explanation">解析</label><textarea id="review-explanation" v-model="editor.explanation" rows="5" maxlength="10000" :disabled="reviewReadOnly || reviewNavigationBusy" /></div>

          <div class="side-tabs" role="tablist" aria-label="证据与原始稿">
            <button type="button" role="tab" :aria-selected="reviewSidePane === 'evidence'" :class="{ active: reviewSidePane === 'evidence' }" :disabled="reviewNavigationBusy" @click="reviewSidePane = 'evidence'">精确证据</button>
            <button type="button" role="tab" :aria-selected="reviewSidePane === 'original'" :class="{ active: reviewSidePane === 'original' }" :disabled="reviewNavigationBusy" @click="reviewSidePane = 'original'">原始生成稿</button>
          </div>
          <section v-if="reviewSidePane === 'evidence'" class="evidence-panel">
            <article v-for="source in currentSources" :key="source.id"><h4>{{ source.title }}</h4><p>{{ source.breadcrumb }}</p><pre>{{ source.evidenceContent }}</pre></article>
          </section>
          <pre v-else class="original-json">{{ JSON.stringify(detail.originalGenerated, null, 2) }}</pre>

          <fieldset v-if="detail.sourceReviewStatus === 'REVIEW_REQUIRED' && !reviewReadOnly" class="revalidate-panel" :disabled="reviewNavigationBusy" aria-label="重新绑定当前知识来源">
            <div class="revalidate-auto">
              <button type="button" class="button" :disabled="reviewNavigationBusy" @click="autoRebindDetail">
                <Link2 :size="16" />自动匹配并重绑
              </button>
              <p>自动匹配当前有效文档节点；无法唯一匹配时请使用下方人工选择。</p>
            </div>
            <h4>重新绑定当前知识来源</h4>
            <select v-model="revalidateLibraryId" @change="loadRevalidateNodes(false)"><option v-for="library in revalidateLibraries" :key="library.id" :value="library.id">{{ library.name }}</option></select>
            <KnowledgeNodePicker v-model="revalidateNodeIds" v-model:query="revalidateQuery" :nodes="revalidateNodes" :total="revalidateTotal" @search="loadRevalidateNodes(false)" @load-more="loadRevalidateNodes(true)" />
            <button type="button" class="button secondary" :disabled="reviewNavigationBusy || !revalidateNodeIds.length" @click="revalidateSource"><RefreshCw :size="16" />复核来源</button>
          </fieldset>

          <p v-if="reviewError" class="alert error" role="alert">{{ reviewError }}</p>
          <p v-else-if="reviewMessage" class="alert success" role="status">{{ reviewMessage }}</p>
          <div v-if="detail.reviewStatus === 'DRAFT_REVIEW'" class="review-actions">
            <button type="button" class="button secondary" :disabled="reviewNavigationBusy" @click="mutateReview('save')"><Save :size="16" />保存草稿</button>
            <button type="button" class="button danger" :disabled="reviewNavigationBusy" @click="openRejectDialog"><XCircle :size="16" />拒绝</button>
            <button type="button" class="button" :disabled="reviewNavigationBusy || detail.sourceReviewStatus !== 'VALID'" @click="mutateReview('approve')"><CheckCircle2 :size="16" />保存并发布</button>
          </div>
          <div v-else-if="detail.reviewStatus === 'APPROVED'" class="review-actions">
            <button type="button" class="button danger" :disabled="reviewNavigationBusy" @click="reopenReview"><RefreshCw :size="16" />撤回并重新审核</button>
          </div>
        </div>
        <div v-else class="review-empty"><CheckCircle2 :size="28" /><p>从左侧选择一道题开始审核</p></div>
      </main>
    </div>

    <dialog ref="rejectDialog" class="reject-dialog">
      <form method="dialog" @submit.prevent="rejectReview">
        <h3>拒绝这道题</h3>
        <div class="field"><label for="reject-reason">拒绝原因</label><textarea id="reject-reason" v-model="rejectReason" required rows="5" maxlength="1000" /></div>
        <div class="dialog-actions"><button type="button" class="button ghost" @click="rejectDialog?.close()">取消</button><button type="submit" class="button danger" :disabled="reviewBusy || !rejectReason.trim()">确认拒绝</button></div>
      </form>
    </dialog>

    <dialog ref="bulkDialog" class="reject-dialog">
      <form method="dialog">
        <h3>以下题目未能自动重绑</h3>
        <ul class="bulk-failures">
          <li v-for="failure in bulkFailures" :key="failure.questionId">
            <strong>{{ failure.prompt }}</strong>
            <small>{{ failure.reason }}</small>
          </li>
        </ul>
        <div class="dialog-actions"><button type="submit" class="button">知道了</button></div>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.ai-workspace { min-width: 0; display: grid; gap: var(--space-4); }
.ai-subtabs, .side-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-muted); }
.ai-subtabs button, .side-tabs button { min-height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); border: 0; border-radius: 4px; color: var(--ink-soft); background: transparent; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
.ai-subtabs button.active, .side-tabs button.active { color: var(--primary); background: var(--surface); box-shadow: var(--shadow-s); }
.generation-layout { min-width: 0; display: grid; grid-template-columns: minmax(320px, 380px) minmax(0, 1fr); gap: var(--space-5); align-items: start; }
.generation-form, .source-section, .preview-section, .jobs-section, .review-queue, .review-editor { min-width: 0; display: grid; gap: var(--space-4); padding: var(--space-5); border: 1px solid var(--border); border-radius: var(--radius-m); background: var(--surface); box-shadow: var(--shadow-s); }
.generation-form { position: sticky; top: calc(var(--header-height) + var(--space-4)); }
.generation-main { min-width: 0; display: grid; gap: var(--space-5); }
.compact-header { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.compact-header h3, .editor-header h3, .revalidate-panel h4 { margin: 0; font-size: 16px; }
.compact-header p, .editor-header p { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
.choice-list, .segmented, .option-editor, .rubric-editor { min-width: 0; display: grid; gap: var(--space-2); margin: 0; padding: 0; border: 0; }
.choice-list legend, .segmented legend, .option-editor legend, .rubric-editor legend { margin-bottom: var(--space-2); color: var(--ink-soft); font-size: 13px; font-weight: 700; }
.choice-list { max-height: 230px; overflow: auto; }
.choice-list label { min-width: 0; display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: var(--space-2); align-items: start; padding: 7px 8px; border: 1px solid var(--border); border-radius: var(--radius-s); cursor: pointer; }
.choice-list input { width: 18px; height: 18px; accent-color: var(--accent); }
.segmented { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.segmented.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.segmented legend { grid-column: 1 / -1; }
.segmented label { min-width: 0; min-height: 44px; display: grid; place-items: center; padding: 7px; border: 1px solid var(--border); border-radius: var(--radius-s); color: var(--ink-soft); background: var(--surface-tint); font-size: 12px; font-weight: 700; text-align: center; cursor: pointer; }
.segmented label.active { border-color: var(--accent); color: var(--accent-dark); background: var(--accent-soft); }
.segmented input { position: absolute; opacity: 0; pointer-events: none; }
.segmented span { min-width: 0; display: grid; gap: 2px; }
.segmented small { color: var(--muted); font-size: 10px; font-weight: 500; }
.count-field input { width: 104px; }
.preview-metrics { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.preview-metrics span { padding: 6px 9px; border: 1px solid var(--border); border-radius: var(--radius-s); color: var(--ink-soft); background: var(--surface-tint); font-size: 12px; }
.empty-copy { margin: 0; color: var(--muted); font-size: 13px; }
.job-list, .review-list { display: grid; margin: 0; padding: 0; list-style: none; }
.job-list li { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) 0; border-top: 1px solid var(--border); }
.job-main { min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 3px var(--space-2); }
.job-main small { grid-column: 2; color: var(--muted); overflow-wrap: anywhere; }
.job-main .job-error { color: var(--danger); }
.job-actions { flex: none; display: flex; gap: var(--space-2); }
.status-badge, .source-state { width: fit-content; padding: 3px 7px; border-radius: 999px; color: var(--ink-soft); background: var(--surface-muted); font-size: 10px; font-weight: 800; }
.status-badge[data-status='COMPLETED'], .source-state.valid { color: #17623b; background: #e1f4e9; }
.status-badge[data-status='FAILED'], .status-badge[data-status='INVALID'], .source-state.review_required { color: #8b322a; background: #fae7e4; }
.review-layout { min-width: 0; display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: var(--space-5); align-items: start; }
.review-queue { position: sticky; top: calc(var(--header-height) + var(--space-4)); max-height: calc(100vh - var(--header-height) - 40px); overflow: auto; align-content: start; }
.review-filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
.review-filters input { grid-column: 1 / -1; }
.review-filters .button { grid-column: 1 / -1; }
.review-list button { width: 100%; min-width: 0; display: grid; gap: 5px; padding: var(--space-3); border: 0; border-top: 1px solid var(--border); color: inherit; background: transparent; text-align: left; cursor: pointer; }
.review-list button.active { background: var(--primary-soft); }
.review-list strong, .review-list small { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-box-orient: vertical; }
.review-list strong { -webkit-line-clamp: 2; font-size: 13px; line-height: 1.45; }
.review-list small { -webkit-line-clamp: 1; color: var(--muted); font-size: 11px; }
.review-row-meta, .editor-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.review-row-meta { color: var(--muted); font-size: 11px; }
.review-editor { min-height: 460px; }
.editor-content { min-width: 0; display: grid; gap: var(--space-4); }
.review-back { display: none; justify-self: start; }
.option-row { min-width: 0; display: grid; grid-template-columns: 18px 64px minmax(0, 1fr) 32px; align-items: center; gap: var(--space-2); }
.option-row > input:first-child { width: 18px; height: 18px; accent-color: var(--accent); }
.criterion-row { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) 86px; gap: var(--space-2); }
.evidence-panel { display: grid; gap: var(--space-3); }
.evidence-panel article { min-width: 0; padding-block: var(--space-3); border-bottom: 1px solid var(--border); }
.evidence-panel h4 { margin: 0; font-size: 14px; }
.evidence-panel p { margin: 3px 0 var(--space-2); color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.evidence-panel pre, .original-json { max-height: 420px; margin: 0; padding: var(--space-3); overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface-tint); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.65 ui-monospace, monospace; }
.revalidate-panel { display: grid; gap: var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--border); }
.revalidate-auto { display: grid; gap: var(--space-2); justify-items: start; padding-bottom: var(--space-3); border-bottom: 1px dashed var(--border); }
.revalidate-auto p { margin: 0; color: var(--muted); font-size: 12px; }
.queue-tools { display: grid; gap: var(--space-2); }
.queue-tools .button { justify-self: start; }
.queue-pagination { display: grid; gap: var(--space-2); justify-items: center; padding-top: var(--space-2); border-top: 1px solid var(--border); }
.queue-pagination select { width: fit-content; }
.bulk-failures { display: grid; gap: var(--space-2); max-height: 320px; margin: 0; padding: 0; overflow: auto; list-style: none; }
.bulk-failures li { display: grid; gap: 2px; padding-bottom: var(--space-2); border-bottom: 1px solid var(--border); }
.bulk-failures strong { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; font-size: 13px; line-height: 1.45; }
.bulk-failures small { color: var(--danger); font-size: 12px; }
.review-actions { position: sticky; bottom: 0; z-index: 2; display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) 0 max(var(--space-3), env(safe-area-inset-bottom)); border-top: 1px solid var(--border); background: var(--surface); }
.review-empty { min-height: 360px; display: grid; place-content: center; justify-items: center; color: var(--muted); }
.reject-dialog { width: min(520px, calc(100vw - 32px)); padding: var(--space-5); border: 1px solid var(--border); border-radius: var(--radius-m); color: var(--ink); background: var(--surface); }
.reject-dialog::backdrop { background: rgba(17, 24, 39, 0.45); }
.reject-dialog form { display: grid; gap: var(--space-4); }
.reject-dialog h3 { margin: 0; }
.dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }

@media (max-width: 980px) {
  .generation-layout, .review-layout { grid-template-columns: 1fr; }
  .generation-form, .review-queue { position: static; max-height: none; }
  .review-layout.detail-open .review-queue { display: none; }
  .review-layout:not(.detail-open) .review-editor { display: none; }
  .review-back { display: inline-flex; }
}

@media (max-width: 560px) {
  .generation-form, .source-section, .preview-section, .jobs-section, .review-queue, .review-editor { padding: var(--space-4); }
  .segmented.four, .complexity-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .job-list li { align-items: flex-start; flex-direction: column; }
  .job-actions { width: 100%; }
  .job-actions .button { flex: 1; }
  .option-row { grid-template-columns: 18px 54px minmax(0, 1fr); }
  .option-row .icon-button { grid-column: 3; justify-self: end; }
  .review-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .review-actions .button:last-child { grid-column: 1 / -1; }
}
</style>
