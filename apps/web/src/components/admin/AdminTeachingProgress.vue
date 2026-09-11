<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ChevronDown, ChevronRight, RefreshCw, Save, Search } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import { useConfirm } from '../../composables/useConfirm';
import { useKnowledgeSubjects } from '../../composables/useKnowledgeSubjects';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useToast } from '../../composables/useToast';
import { api, formatError } from '../../lib/api';
import {
  getTeachingProgress,
  getTeachingProgressDetail,
  publishTeachingProgress,
  shanghaiPracticeDate,
} from '../../lib/dailyPractice';
import { teachingProgressChangeTypeLabels } from '../../lib/labels';
import type {
  AiQuestionGenerationLibrary,
  AiQuestionGenerationNode,
  TeachingProgressDetail,
  TeachingProgressSummary,
} from '../../types';

const { confirm } = useConfirm();
const toast = useToast();
const progressRequests = useLatestRequest();
const libraryRequests = useLatestRequest();
const nodeRequests = useLatestRequest();
const versionRequests = useLatestRequest();
const subjectId = ref('');
const {
  subjects,
  subjectsLoading,
  subjectsError,
  loadSubjects,
} = useKnowledgeSubjects({
  onLoaded(items) {
    if (!subjectId.value) subjectId.value = items[0]?.id ?? '';
  },
});

const latest = ref<TeachingProgressDetail | null>(null);
const versions = ref<TeachingProgressSummary[]>([]);
const selectedVersionId = ref('');
const viewing = ref<TeachingProgressDetail | null>(null);
const versionLoading = ref(false);
const progressLoading = ref(false);
const progressError = ref('');
const libraries = ref<AiQuestionGenerationLibrary[]>([]);
const libraryId = ref('');
const nodes = ref<AiQuestionGenerationNode[]>([]);
const nodeTotal = ref(0);
const nodePage = ref(1);
const nodeQuery = ref('');
const nodesLoading = ref(false);
const sourceError = ref('');
const collapsed = ref(new Set<string>());
const selectedDates = ref<Record<string, string>>({});
const baselineDates = ref<Record<string, string>>({});
const baselineLabels = ref<Record<string, string>>({});
const effectivePracticeDate = ref(shanghaiPracticeDate());
const batchTaughtDate = ref(shanghaiPracticeDate());
const note = ref('');
const correctionReason = ref('');
const publishing = ref(false);

const nodeById = computed(() => new Map(nodes.value.map((node) => [node.id, node])));
const selectedIds = computed(() => Object.keys(selectedDates.value));
/** 发布基准固定为最新版本；查看历史版本不影响该集合 */
const latestUnresolvedNodes = computed(
  () => latest.value?.nodes.filter((node) => !node.currentKnowledgeNodeId) ?? [],
);
/** 展示区使用当前选中的版本（默认最新） */
const shownDetail = computed(() => viewing.value ?? latest.value);
const viewingIsLatest = computed(
  () => !shownDetail.value || shownDetail.value.id === latest.value?.id,
);
const viewedUnresolvedNodes = computed(
  () => shownDetail.value?.nodes.filter((node) => !node.currentKnowledgeNodeId) ?? [],
);
const viewedRemappedNodes = computed(
  () => shownDetail.value?.nodes.filter((node) => node.remapped) ?? [],
);
const minimumEffectivePracticeDate = computed(() => {
  const today = shanghaiPracticeDate();
  const previous = latest.value?.effectivePracticeDate ?? '';
  return previous > today ? previous : today;
});
const visibleNodes = computed(() => {
  const byId = nodeById.value;
  return nodes.value.filter((node) => {
    let parentId = node.parentId;
    while (parentId) {
      if (collapsed.value.has(parentId)) return false;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return true;
  });
});
const removedCount = computed(
  () =>
    Object.keys(baselineDates.value).filter((id) => !selectedDates.value[id]).length +
    latestUnresolvedNodes.value.length,
);
const changedDateCount = computed(
  () =>
    Object.entries(baselineDates.value).filter(
      ([id, date]) => selectedDates.value[id] && selectedDates.value[id] !== date,
    ).length,
);
const addedCount = computed(
  () => Object.keys(selectedDates.value).filter((id) => !baselineDates.value[id]).length,
);
const correction = computed(() => removedCount.value > 0 || changedDateCount.value > 0);
const changeType = computed(() =>
  latest.value ? (correction.value ? 'CORRECTION' : 'ADD') : 'INITIAL',
);
const hasChanges = computed(
  () =>
    !latest.value ||
    addedCount.value > 0 ||
    removedCount.value > 0 ||
    changedDateCount.value > 0,
);

function leafIds(node: AiQuestionGenerationNode) {
  if (node.leafNodeIds.length) return node.leafNodeIds;
  return node.hasChildren ? [] : [node.id];
}

function nodeChecked(node: AiQuestionGenerationNode) {
  const ids = leafIds(node);
  return ids.length > 0 && ids.every((id) => Boolean(selectedDates.value[id]));
}

function toggleNode(node: AiQuestionGenerationNode) {
  const ids = leafIds(node);
  if (!ids.length) return;
  const next = { ...selectedDates.value };
  if (nodeChecked(node)) ids.forEach((id) => delete next[id]);
  else ids.forEach((id) => (next[id] = batchTaughtDate.value));
  selectedDates.value = next;
}

function toggleCollapsed(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}

function shortDocumentId(value: string | null | undefined) {
  if (!value) return '—';
  return value.length > 8 ? value.slice(0, 8) : value;
}

async function loadProgress() {
  progressRequests.cancelLatest();
  progressLoading.value = false;
  versionRequests.cancelLatest();
  versionLoading.value = false;
  latest.value = null;
  viewing.value = null;
  versions.value = [];
  selectedVersionId.value = '';
  effectivePracticeDate.value = shanghaiPracticeDate();
  selectedDates.value = {};
  baselineDates.value = {};
  baselineLabels.value = {};
  if (!subjectId.value) return;
  progressLoading.value = true;
  progressError.value = '';
  const requestedSubjectId = subjectId.value;
  await progressRequests.runLatest(
    async ({ signal }) => {
      const page = await getTeachingProgress(
        { subjectId: requestedSubjectId, pageSize: 20 },
        { signal },
      );
      const sorted = [...page.items].sort((a, b) => b.version - a.version);
      const summary = sorted[0];
      const detail = summary
        ? await getTeachingProgressDetail(summary.id, { signal })
        : null;
      return { sorted, detail };
    },
    {
      commit({ sorted, detail }) {
        if (subjectId.value !== requestedSubjectId) return;
        versions.value = sorted;
        if (!detail) return;
        latest.value = detail;
        viewing.value = detail;
        selectedVersionId.value = detail.id;
        effectivePracticeDate.value = minimumEffectivePracticeDate.value;
        const dates: Record<string, string> = {};
        const labels: Record<string, string> = {};
        for (const node of detail.nodes) {
          if (!node.currentKnowledgeNodeId) continue;
          dates[node.currentKnowledgeNodeId] = node.firstTaughtDate;
          labels[node.currentKnowledgeNodeId] = node.breadcrumb || node.title;
        }
        baselineDates.value = dates;
        selectedDates.value = { ...dates };
        baselineLabels.value = labels;
      },
      onError(caught) {
        if (subjectId.value === requestedSubjectId)
          progressError.value = formatError(caught, '教学进度加载失败');
      },
      onFinally() {
        if (subjectId.value === requestedSubjectId) progressLoading.value = false;
      },
    },
  );
}

async function loadVersionDetail(id: string) {
  if (!id || id === latest.value?.id) {
    versionRequests.cancelLatest();
    versionLoading.value = false;
    viewing.value = id ? latest.value : null;
    return;
  }
  versionLoading.value = true;
  await versionRequests.runLatest(
    ({ signal }) => getTeachingProgressDetail(id, { signal }),
    {
    commit(value) {
      if (selectedVersionId.value === id) viewing.value = value;
    },
    onError(caught) {
      if (selectedVersionId.value !== id) return;
      toast.error(formatError(caught, '历史版本加载失败'));
      selectedVersionId.value = latest.value?.id ?? '';
    },
    onFinally() {
      if (selectedVersionId.value === id) versionLoading.value = false;
    },
    },
  );
}

async function loadLibraries() {
  libraryRequests.cancelLatest();
  nodeRequests.cancelLatest();
  nodesLoading.value = false;
  libraries.value = [];
  libraryId.value = '';
  nodes.value = [];
  if (!subjectId.value) return;
  sourceError.value = '';
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
          sourceError.value = formatError(caught, '共享知识库加载失败');
      },
    },
  );
}

async function loadNodes(append = false) {
  if (!libraryId.value || !subjectId.value) return;
  nodesLoading.value = true;
  sourceError.value = '';
  const requestedPage = append ? nodePage.value + 1 : 1;
  const requestedSubjectId = subjectId.value;
  const requestedLibraryId = libraryId.value;
  await nodeRequests.runLatest(async ({ signal }) => {
    const params = new URLSearchParams({
      subjectId: requestedSubjectId,
      page: String(requestedPage),
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
        sourceError.value = formatError(caught, '知识节点加载失败');
    },
    onFinally() {
      if (subjectId.value === requestedSubjectId && libraryId.value === requestedLibraryId)
        nodesLoading.value = false;
    },
  });
}

async function changeSubject() {
  await Promise.all([loadProgress(), loadLibraries()]);
}

async function publish() {
  if (!subjectId.value || publishing.value) return;
  if (!viewingIsLatest.value) {
    toast.error('正在查看历史版本，请切换回最新版本后再发布');
    return;
  }
  if (!hasChanges.value) {
    toast.error('教学范围没有需要发布的变更');
    return;
  }
  if (!selectedIds.value.length) {
    toast.error('教学进度至少需要一个知识节点');
    return;
  }
  if (Object.values(selectedDates.value).some((date) => date > effectivePracticeDate.value)) {
    toast.error('首次讲授日期不能晚于生效练习日');
    return;
  }
  if (effectivePracticeDate.value < minimumEffectivePracticeDate.value) {
    toast.error(`生效练习日不能早于 ${minimumEffectivePracticeDate.value}`);
    return;
  }
  if (correction.value && !correctionReason.value.trim()) {
    toast.error('移除节点或修改讲授日期时必须填写更正原因');
    return;
  }
  const targetSubjectId = subjectId.value;
  const targetLatestId = latest.value?.id ?? null;
  const targetChangeType = changeType.value;
  const targetEffectivePracticeDate = effectivePracticeDate.value;
  const targetCorrection = correction.value;
  const targetAddedCount = addedCount.value;
  const targetRemovedCount = removedCount.value;
  const targetChangedDateCount = changedDateCount.value;
  const payload = {
    subjectId: targetSubjectId,
    effectivePracticeDate: targetEffectivePracticeDate,
    changeType: targetChangeType,
    ...(targetLatestId ? { basedOnProgressId: targetLatestId } : {}),
    expectedVersion: latest.value?.version ?? 0,
    ...(note.value.trim() ? { note: note.value.trim() } : {}),
    ...(targetCorrection
      ? { correctionReason: correctionReason.value.trim() }
      : {}),
    nodes: selectedIds.value.map((id) => ({
      knowledgeNodeId: id,
      firstTaughtDate: selectedDates.value[id]!,
    })),
  } satisfies Parameters<typeof publishTeachingProgress>[0];
  publishing.value = true;
  try {
    const ok = await confirm({
      title: '发布教学进度',
      body: `将发布 ${targetChangeType} 修订：新增 ${targetAddedCount}、移除 ${targetRemovedCount}、改期 ${targetChangedDateCount} 个节点，自 ${targetEffectivePracticeDate} 生效。`,
      confirmText: '发布进度',
      danger: targetCorrection,
    });
    if (
      !ok
      || subjectId.value !== targetSubjectId
      || (latest.value?.id ?? null) !== targetLatestId
    ) return;
    await publishTeachingProgress(payload);
    if (subjectId.value !== targetSubjectId) return;
    note.value = '';
    correctionReason.value = '';
    toast.success('教学进度已发布');
    await loadProgress();
  } catch (caught) {
    toast.error(formatError(caught, '教学进度发布失败'));
    if (subjectId.value === targetSubjectId) await loadProgress();
  } finally {
    publishing.value = false;
  }
}

watch(subjectId, () => void changeSubject());
watch(libraryId, () => {
  nodeRequests.cancelLatest();
  nodesLoading.value = false;
  nodes.value = [];
  if (libraryId.value) void loadNodes(false);
});
watch(selectedVersionId, (id) => void loadVersionDetail(id));

onMounted(() => void loadSubjects());
</script>

<template>
  <section class="progress-section" aria-labelledby="teaching-progress-title">
    <header class="section-heading">
      <div>
        <p class="section-kicker">教学范围</p>
        <h3 id="teaching-progress-title">教学进度</h3>
      </div>
      <button
        type="button"
        class="icon-button"
        title="刷新教学进度"
        aria-label="刷新教学进度"
        :disabled="progressLoading || publishing"
        @click="changeSubject"
      ><RefreshCw :size="16" aria-hidden="true" /></button>
    </header>

    <div class="progress-toolbar">
      <div class="field">
        <label for="progress-subject">学科</label>
        <select id="progress-subject" v-model="subjectId" :disabled="subjectsLoading || publishing">
          <option value="">请选择学科</option>
          <option v-for="subject in subjects" :key="subject.id" :value="subject.id">
            {{ subject.name }}
          </option>
        </select>
      </div>
      <div class="field">
        <label for="progress-effective-date">生效练习日</label>
        <input
          id="progress-effective-date"
          v-model="effectivePracticeDate"
          type="date"
          :min="minimumEffectivePracticeDate"
          :disabled="publishing"
        />
        <p class="field-hint">
          生效日为今日时，今日已冻结的周期不会自动更新，需在「周期管理」对其执行重新冻结后生效。
        </p>
      </div>
      <div class="field">
        <label for="progress-batch-date">新选节点首次讲授日</label>
        <input id="progress-batch-date" v-model="batchTaughtDate" type="date" :disabled="publishing" />
      </div>
    </div>
    <p v-if="subjectsError" class="alert error">{{ subjectsError }}</p>
    <SkeletonBlock v-if="progressLoading" :lines="3" />
    <ErrorState v-else-if="progressError" :message="progressError" @retry="loadProgress" />
    <template v-else>
      <div v-if="versions.length" class="field version-select">
        <label for="progress-version">版本历史</label>
        <select id="progress-version" v-model="selectedVersionId" :disabled="versionLoading || publishing">
          <option v-for="item in versions" :key="item.id" :value="item.id">
            版本 {{ item.version }} · {{ teachingProgressChangeTypeLabels[item.changeType] }} ·
            生效 {{ item.effectivePracticeDate }}{{ item.id === latest?.id ? '（当前）' : '' }}
          </option>
        </select>
      </div>
      <div class="current-progress">
        <template v-if="shownDetail">
          <StatusBadge :text="`版本 ${shownDetail.version}`" tone="accent" />
          <span>{{ teachingProgressChangeTypeLabels[shownDetail.changeType] }} · {{ shownDetail.nodeCount }} 个节点</span>
          <span>生效日 {{ shownDetail.effectivePracticeDate }}</span>
          <span>候选题 {{ shownDetail.eligibleQuestionCount }}</span>
          <span v-if="shownDetail.unresolvedNodeCount" class="unresolved">
            {{ shownDetail.unresolvedNodeCount }} 个节点待解析
          </span>
          <span v-if="viewedRemappedNodes.length" class="remapped">
            {{ viewedRemappedNodes.length }} 个节点已重映射
          </span>
        </template>
        <span v-else>该学科尚未发布教学进度。</span>
      </div>
      <p v-if="!viewingIsLatest" class="alert warning history-banner">
        正在查看历史版本 v{{ shownDetail?.version }}；发布始终以最新版本 v{{ latest?.version }}
        为基准。切换回「当前」版本后才能发布。
      </p>
    </template>

    <section
      v-if="viewedRemappedNodes.length"
      class="remapped-baseline"
      aria-labelledby="remapped-baseline-title"
    >
      <div>
        <strong id="remapped-baseline-title">已自动重映射到替换文档</strong>
        <p>这些节点的原知识文档已被替换，系统已自动映射到替换文档中的对应节点；发布会保留其首次讲授日期，无需人工处理。</p>
      </div>
      <ul>
        <li v-for="node in viewedRemappedNodes" :key="node.id">
          <span>{{ node.breadcrumb || node.title }}</span>
          <small>
            文档
            <code :title="node.documentId">{{ shortDocumentId(node.documentId) }}</code>
            →
            <code :title="node.resolvedDocumentId ?? undefined">{{ shortDocumentId(node.resolvedDocumentId) }}</code>
            · 首次讲授 {{ node.firstTaughtDate }}
          </small>
        </li>
      </ul>
    </section>

    <section
      v-if="viewedUnresolvedNodes.length"
      class="unresolved-baseline"
      aria-labelledby="unresolved-baseline-title"
    >
      <div>
        <strong id="unresolved-baseline-title">无法解析的节点</strong>
        <p>这些节点无法映射到当前知识库。本次发布会将其明确计为移除项，并要求填写更正原因。</p>
      </div>
      <ul>
        <li v-for="node in viewedUnresolvedNodes" :key="node.id">
          <span>{{ node.breadcrumb || node.title }}</span>
          <small>首次讲授 {{ node.firstTaughtDate }}</small>
        </li>
      </ul>
    </section>

    <div class="node-toolbar">
      <div class="field">
        <label for="progress-library">共享知识库</label>
        <select id="progress-library" v-model="libraryId" :disabled="publishing || !libraries.length">
          <option value="">请选择知识库</option>
          <option v-for="library in libraries" :key="library.id" :value="library.id">
            {{ library.name }}（{{ library.nodeCount }} 节点）
          </option>
        </select>
      </div>
      <form class="node-search" @submit.prevent="loadNodes(false)">
        <Search :size="16" aria-hidden="true" />
        <input v-model="nodeQuery" aria-label="搜索知识节点" placeholder="搜索标题或路径" :disabled="publishing" />
        <button type="submit" class="button secondary" :disabled="publishing || nodesLoading">搜索</button>
      </form>
    </div>
    <p v-if="sourceError" class="alert error">{{ sourceError }}</p>
    <SkeletonBlock v-if="nodesLoading && !nodes.length" :lines="6" />
    <EmptyState
      v-else-if="libraryId && !nodes.length"
      title="没有可选择的知识节点"
      hint="仅显示同学科、共享、已发布且已完成处理的知识节点"
    />
    <div v-else-if="nodes.length" class="node-tree" aria-label="教学知识节点">
      <div
        v-for="node in visibleNodes"
        :key="node.id"
        class="node-row"
        :style="{ '--node-level': node.level }"
      >
        <button
          v-if="node.hasChildren"
          type="button"
          class="node-expand"
          :aria-label="collapsed.has(node.id) ? '展开节点' : '收起节点'"
          @click="toggleCollapsed(node.id)"
        >
          <ChevronRight v-if="collapsed.has(node.id)" :size="15" aria-hidden="true" />
          <ChevronDown v-else :size="15" aria-hidden="true" />
        </button>
        <span v-else class="node-spacer" aria-hidden="true" />
        <label>
          <input type="checkbox" :checked="nodeChecked(node)" :disabled="publishing" @change="toggleNode(node)" />
          <span>
            <strong>{{ node.title }}</strong>
            <small>{{ node.breadcrumb }} · {{ node.hasChildren ? `${node.leafNodeCount} 个末级节点` : '末级节点' }}</small>
          </span>
        </label>
      </div>
    </div>
    <button
      v-if="nodes.length < nodeTotal"
      type="button"
      class="button ghost load-more"
      :disabled="publishing || nodesLoading"
      @click="loadNodes(true)"
    >{{ nodesLoading ? '加载中…' : '继续加载节点' }}</button>

    <section class="progress-diff" aria-labelledby="progress-diff-title">
      <header>
        <h4 id="progress-diff-title">发布预览</h4>
        <StatusBadge :text="changeType" :tone="correction ? 'warning' : 'accent'" />
      </header>
      <p>
        完整范围 {{ selectedIds.length }} 个节点 · 新增 {{ addedCount }} · 移除 {{ removedCount }} ·
        改期 {{ changedDateCount }}
      </p>
      <details v-if="selectedIds.length">
        <summary>查看并调整所选节点日期</summary>
        <ul class="selected-node-list">
          <li v-for="id in selectedIds.slice(0, 200)" :key="id">
            <span>{{ nodeById.get(id)?.breadcrumb || baselineLabels[id] || id }}</span>
            <input
              v-model="selectedDates[id]"
              type="date"
              :aria-label="`设置 ${nodeById.get(id)?.title || baselineLabels[id] || id} 的首次讲授日期`"
              :disabled="publishing"
            />
          </li>
        </ul>
        <p v-if="selectedIds.length > 200" class="field-hint">
          当前仅展示前 200 项；发布时仍会提交全部 {{ selectedIds.length }} 个节点。
        </p>
      </details>
      <div class="field">
        <label for="progress-note">发布说明</label>
        <textarea id="progress-note" v-model="note" maxlength="500" rows="3" :disabled="publishing" />
      </div>
      <div v-if="correction" class="field">
        <label for="progress-correction">更正原因</label>
        <textarea id="progress-correction" v-model="correctionReason" maxlength="500" rows="3" required :disabled="publishing" />
      </div>
      <button
        type="button"
        class="button publish-button"
        :disabled="publishing || !selectedIds.length || !hasChanges || !viewingIsLatest"
        @click="publish"
      >
        <Save :size="16" aria-hidden="true" />
        {{ publishing ? '正在发布…' : '发布教学进度' }}
      </button>
    </section>
  </section>
</template>

<style scoped>
.progress-section {
  display: grid;
  gap: var(--space-5);
  padding-top: var(--space-6);
  border-top: 1px solid var(--border);
}

.section-heading,
.progress-diff header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.section-heading h3,
.section-kicker,
.progress-diff h4,
.progress-diff p,
.selected-node-list {
  margin: 0;
}

.section-heading h3 {
  margin-top: 3px;
  font-size: 18px;
}

.section-kicker {
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
}

.progress-toolbar {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

.current-progress {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  padding-block: var(--space-3);
  border-block: 1px solid var(--border);
  color: var(--muted);
  font-size: 13px;
}

.unresolved {
  color: var(--warning);
}

.remapped {
  color: var(--accent-dark);
}

.version-select {
  max-width: 460px;
}

.history-banner {
  margin: 0;
}

.unresolved-baseline,
.remapped-baseline {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-s);
}

.unresolved-baseline {
  border: 1px solid var(--danger-border);
  background: var(--danger-bg);
}

.unresolved-baseline strong {
  color: var(--danger);
}

.remapped-baseline {
  border: 1px solid var(--warning-border, #d7b86b);
  background: var(--warning-soft, #fff8e8);
}

.remapped-baseline strong {
  color: var(--warning);
}

.unresolved-baseline p,
.unresolved-baseline ul,
.remapped-baseline p,
.remapped-baseline ul {
  margin: 0;
}

.unresolved-baseline p,
.remapped-baseline p {
  margin-top: var(--space-1);
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.6;
}

.unresolved-baseline ul,
.remapped-baseline ul {
  display: grid;
  gap: var(--space-2);
  padding-left: 20px;
}

.unresolved-baseline li,
.remapped-baseline li {
  color: var(--ink-soft);
  font-size: 13px;
}

.unresolved-baseline li small,
.remapped-baseline li small {
  display: block;
  color: var(--muted);
}

.remapped-baseline li code {
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.node-toolbar {
  display: grid;
  grid-template-columns: minmax(220px, 0.4fr) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: end;
}

.node-search {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
}

.node-search input {
  min-width: 0;
  min-height: 44px;
}

.node-tree {
  max-height: 480px;
  overflow: auto;
  border-block: 1px solid var(--border);
}

.node-row {
  min-width: 0;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  align-items: start;
  padding: 9px 8px 9px calc(8px + var(--node-level) * 16px);
  border-bottom: 1px solid var(--border);
}

.node-expand,
.node-spacer {
  width: 28px;
  height: 28px;
}

.node-expand {
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
}

.node-row label {
  min-width: 0;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: var(--space-2);
  cursor: pointer;
}

.node-row input {
  width: 18px;
  height: 18px;
  margin-top: 3px;
  accent-color: var(--accent);
}

.node-row label span {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.node-row strong,
.node-row small {
  overflow-wrap: anywhere;
}

.node-row strong {
  font-size: 13px;
}

.node-row small {
  color: var(--muted);
  font-size: 11px;
}

.load-more {
  justify-self: center;
}

.progress-diff {
  display: grid;
  gap: var(--space-4);
  padding-top: var(--space-5);
  border-top: 1px solid var(--border);
}

.progress-diff p {
  color: var(--muted);
  line-height: 1.6;
}

.selected-node-list {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) 0 0;
  list-style: none;
}

.selected-node-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 160px;
  align-items: center;
  gap: var(--space-3);
}

.selected-node-list span {
  color: var(--ink-soft);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.selected-node-list input {
  min-height: 38px;
}

.publish-button {
  justify-self: start;
}

@media (max-width: 700px) {
  .progress-toolbar,
  .node-toolbar {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .node-search,
  .selected-node-list li {
    grid-template-columns: 1fr;
  }

  .node-search svg {
    display: none;
  }

  .node-tree {
    max-height: 360px;
  }

  .publish-button {
    width: 100%;
  }
}
</style>
