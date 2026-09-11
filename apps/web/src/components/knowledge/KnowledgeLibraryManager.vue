<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  routeLocationKey,
  routerKey,
  type RouteLocationNormalizedLoaded,
} from 'vue-router';
import {
  Check,
  CircleHelp,
  Download,
  Eye,
  FileArchive,
  ListTree,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-vue-next';
import BaseDialog from '../common/BaseDialog.vue';
import { ApiClientError, api, formatError, uploadForm, type UploadProgress } from '../../lib/api';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { usePaneVisibility } from '../../composables/usePaneVisibility';
import { useToast } from '../../composables/useToast';
import { formatDate } from '../../lib/formatters';
import { downloadKnowledgeAuthoringGuide } from '../../lib/knowledgeAuthoringGuide';
import type {
  KnowledgeImportJob,
  KnowledgeImportStructureResponse,
  KnowledgeLibrary,
  KnowledgeLibraryDocument,
  KnowledgeLibraryScope,
  KnowledgeVersion,
  Subject,
} from '../../types';
import KnowledgeCandidatePreview from './KnowledgeCandidatePreview.vue';
import KnowledgeAuthoringGuide from './KnowledgeAuthoringGuide.vue';
import KnowledgeMarkdownHeading from './KnowledgeMarkdownHeading.vue';

const props = withDefaults(defineProps<{
  scope: KnowledgeLibraryScope;
  active?: boolean;
}>(), { active: true });
const route = inject(
  routeLocationKey,
  { query: {} } as RouteLocationNormalizedLoaded,
);
const router = inject(routerKey, undefined);
const toast = useToast();
const { confirm } = useConfirm();
const baseRequests = useLatestRequest();
const documentRequests = useLatestRequest();
const detailRequests = useLatestRequest();
const versionRequests = useLatestRequest();
const mutations = useLatestRequest();
const paneVisible = usePaneVisibility(() => props.active);

const subjects = ref<Subject[]>([]);
const libraries = ref<KnowledgeLibrary[]>([]);
const selectedLibraryId = ref('');
const documents = ref<KnowledgeLibraryDocument[]>([]);
const imports = ref<KnowledgeImportJob[]>([]);
const versions = ref<Record<string, KnowledgeVersion[]>>({});
const importDetails = ref<Record<string, KnowledgeImportStructureResponse>>({});
const importDetailsLoading = ref(new Set<string>());
const authoringGuideOpen = ref(false);
const previewDocumentId = ref(
  typeof route.query.previewDocumentId === 'string'
    ? route.query.previewDocumentId
    : '',
);
const previewVersionId = ref(
  typeof route.query.previewVersionId === 'string'
    ? route.query.previewVersionId
    : '',
);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const name = ref('');
const subjectId = ref('');
const file = ref<File | null>(null);
const fileInput = ref<HTMLInputElement>();
const targetDocumentId = ref('');
const progress = ref<UploadProgress | null>(null);
const acknowledged = ref(false);
const newSubjectName = ref('');
const newSubjectSlug = ref('');
let uploadController: AbortController | null = null;
let pollTimer: number | undefined;

const visibleLibraries = computed(() =>
  libraries.value.filter((library) => library.scope === props.scope),
);
const selectedLibrary = computed(() =>
  visibleLibraries.value.find((library) => library.id === selectedLibraryId.value),
);
const selectedImports = computed(() =>
  imports.value.filter((job) => job.libraryId === selectedLibraryId.value),
);
const hasActiveJobs = computed(() =>
  selectedImports.value.some((job) =>
    [
      'PREFLIGHT_PENDING',
      'PREFLIGHTING',
      'AWAITING_CONFIRMATION',
      'INDEX_PENDING',
      'PROCESSING',
    ].includes(job.status),
  ),
);

async function loadBase(background = false) {
  if (!paneVisible.value) {
    loading.value = false;
    return;
  }
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
  if (!background) loading.value = true;
  error.value = '';
  const previousLibraryId = selectedLibraryId.value;
  const result = await baseRequests.runLatest(
    ({ signal }) => Promise.all([
      api<Subject[]>('/subjects', { signal }),
      api<{ items: KnowledgeLibrary[] }>('/knowledge/libraries', { signal }),
      api<{ items: KnowledgeImportJob[] }>(
        '/knowledge/imports?page=1&pageSize=100',
        { signal },
      ),
    ]),
    {
      commit([subjectRows, libraryPage, importPage]) {
        subjects.value = subjectRows;
        libraries.value = libraryPage.items;
        imports.value = importPage.items;
        if (!subjectId.value) subjectId.value = subjectRows[0]?.id ?? '';
        if (
          !selectedLibraryId.value ||
          !visibleLibraries.value.some((library) => library.id === selectedLibraryId.value)
        ) selectedLibraryId.value = visibleLibraries.value[0]?.id ?? '';
      },
      onError(caught) {
        error.value = formatError(caught, '知识库加载失败');
      },
      onFinally() {
        loading.value = false;
      },
    },
  );
  if (result.status === 'committed' && selectedLibraryId.value === previousLibraryId)
    await loadDocuments();
  if (result.status !== 'aborted' && result.status !== 'stale') schedulePoll();
}

async function loadDocuments() {
  documentRequests.cancelLatest();
  versions.value = {};
  if (!paneVisible.value || !selectedLibraryId.value) {
    documents.value = [];
    return;
  }
  const requestedLibraryId = selectedLibraryId.value;
  await documentRequests.runLatest(
    ({ signal }) => api<{ items: KnowledgeLibraryDocument[] }>(
      `/knowledge/libraries/${requestedLibraryId}/documents`,
      { signal },
    ),
    {
      commit(result) {
        if (selectedLibraryId.value === requestedLibraryId) documents.value = result.items;
      },
      onError(caught) {
        if (selectedLibraryId.value === requestedLibraryId)
          error.value = formatError(caught, '文档加载失败');
      },
    },
  );
}

watch(selectedLibraryId, () => {
  targetDocumentId.value = '';
  schedulePoll();
  void loadDocuments();
});

watch(
  () => [route.query.previewDocumentId, route.query.previewVersionId],
  ([documentId, versionId]) => {
    previewDocumentId.value =
      typeof documentId === 'string' ? documentId : '';
    previewVersionId.value = typeof versionId === 'string' ? versionId : '';
  },
);

async function createLibrary() {
  if (!name.value.trim() || !subjectId.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const created = await api<KnowledgeLibrary>('/knowledge/libraries', {
      method: 'POST',
      body: JSON.stringify({
        name: name.value.trim(),
        subjectId: subjectId.value,
        scope: props.scope,
      }),
    });
    libraries.value.push(created);
    selectedLibraryId.value = created.id;
    name.value = '';
    toast.success('知识库已创建');
  } catch (caught) {
    error.value = formatError(caught, '知识库创建失败');
  } finally {
    busy.value = false;
  }
}

async function createSubject() {
  if (
    props.scope !== 'SHARED' ||
    !newSubjectName.value.trim() ||
    !newSubjectSlug.value.trim() ||
    busy.value
  ) return;
  busy.value = true;
  error.value = '';
  try {
    const created = await api<Subject>('/knowledge/subjects', {
      method: 'POST',
      body: JSON.stringify({
        name: newSubjectName.value.trim(),
        slug: newSubjectSlug.value.trim(),
      }),
    });
    subjects.value.push(created);
    subjectId.value = created.id;
    newSubjectName.value = '';
    newSubjectSlug.value = '';
    toast.success('学科已创建');
  } catch (caught) {
    error.value = formatError(caught, '学科创建失败');
  } finally {
    busy.value = false;
  }
}

async function toggleLibraryActive() {
  const library = selectedLibrary.value;
  if (!library || busy.value) return;
  busy.value = true;
  try {
    const updated = await api<KnowledgeLibrary>(`/knowledge/libraries/${library.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: !library.active }),
    });
    Object.assign(library, updated);
  } catch (caught) {
    error.value = formatError(caught, '知识库状态更新失败');
  } finally {
    busy.value = false;
  }
}

async function toggleAi() {
  const library = selectedLibrary.value;
  if (!library || library.scope !== 'PRIVATE' || busy.value) return;
  if (!library.aiEnabled && !acknowledged.value) {
    error.value = '启用 AI 前请勾选数据使用确认';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const updated = await api<KnowledgeLibrary>(
      `/knowledge/libraries/${library.id}/ai-settings`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          enabled: !library.aiEnabled,
          acknowledged: acknowledged.value,
        }),
      },
    );
    Object.assign(library, updated);
    acknowledged.value = false;
  } catch (caught) {
    error.value = formatError(caught, 'AI 设置更新失败');
  } finally {
    busy.value = false;
  }
}

function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const picked = input.files?.[0] ?? null;
  progress.value = null;
  error.value = '';
  if (!picked) {
    file.value = null;
    return;
  }
  const extension = picked.name.toLowerCase().split('.').at(-1);
  const limit = extension === 'md' ? 10 * 1024 * 1024 : 200 * 1024 * 1024;
  if (!['md', 'zip'].includes(extension ?? '') || picked.size > limit) {
    input.value = '';
    file.value = null;
    error.value = extension === 'md'
      ? 'Markdown 文件不能超过 10 MiB'
      : '仅支持 200 MiB 以内的 Markdown 或 ZIP';
    return;
  }
  file.value = picked;
}

async function upload() {
  if (!file.value || !selectedLibrary.value || busy.value) return;
  busy.value = true;
  error.value = '';
  progress.value = null;
  uploadController = new AbortController();
  try {
    const form = new FormData();
    form.append('file', file.value);
    form.append('libraryId', selectedLibrary.value.id);
    if (targetDocumentId.value)
      form.append('targetDocumentId', targetDocumentId.value);
    const job = await uploadForm<KnowledgeImportJob>('/knowledge/imports', form, {
      signal: uploadController.signal,
      onProgress(value) {
        progress.value = value;
      },
    });
    imports.value.unshift(job);
    file.value = null;
    targetDocumentId.value = '';
    if (fileInput.value) fileInput.value.value = '';
    toast.success('知识包已进入预检队列');
    schedulePoll();
  } catch (caught) {
    if (!(caught instanceof DOMException && caught.name === 'AbortError'))
      error.value = formatError(caught, '知识包上传失败');
  } finally {
    busy.value = false;
    uploadController = null;
  }
}

function cancelUpload() {
  uploadController?.abort();
}

function downloadAuthoringGuide() {
  downloadKnowledgeAuthoringGuide();
  toast.success('文件编写说明已开始下载');
}

function replaceImport(updated: KnowledgeImportJob) {
  const index = imports.value.findIndex((item) => item.id === updated.id);
  if (index >= 0) imports.value[index] = updated;
  else imports.value.unshift(updated);
}

async function confirmImport(job: KnowledgeImportJob) {
  const key = `import:${job.id}`;
  await mutations.runBusy(key, async () => {
    try {
      const updated = await api<KnowledgeImportJob>(
        `/knowledge/imports/${job.id}/confirm`,
        { method: 'POST' },
      );
      replaceImport(updated);
      toast.success('知识导入已确认');
      schedulePoll();
    } catch (caught) {
      error.value = formatError(caught, '导入确认失败');
      toast.error(error.value);
      if (caught instanceof ApiClientError && caught.status === 409) await loadBase(true);
    }
  });
}

async function cancelImport(job: KnowledgeImportJob) {
  const accepted = await confirm({
    title: '取消知识导入',
    body: `取消“${job.sourceName}”的导入任务？`,
    confirmText: '取消任务',
    danger: true,
  });
  if (!accepted) return;
  await mutations.runBusy(`import:${job.id}`, async () => {
    try {
      const updated = await api<KnowledgeImportJob>(`/knowledge/imports/${job.id}`, {
        method: 'DELETE',
      });
      replaceImport(updated);
      toast.success('知识导入已取消');
      schedulePoll();
    } catch (caught) {
      error.value = formatError(caught, '取消知识导入失败');
      toast.error(error.value);
      if (caught instanceof ApiClientError && caught.status === 409) await loadBase(true);
    }
  });
}

async function retryCompensation(job: KnowledgeImportJob) {
  const key = `import:${job.id}`;
  error.value = '';
  await mutations.runBusy(key, async () => {
    try {
      const updated = await api<KnowledgeImportJob>(
        `/knowledge/imports/${job.id}/retry-compensation`,
        { method: 'POST' },
      );
      replaceImport(updated);
      toast.success('已重新提交补偿清理');
      schedulePoll();
    } catch (caught) {
      error.value = formatError(caught, '补偿清理重试失败');
      toast.error(error.value);
      if (caught instanceof ApiClientError && caught.status === 409) await loadBase(true);
    }
  });
}

async function toggleImportDetails(job: KnowledgeImportJob) {
  if (importDetails.value[job.id]) {
    const next = { ...importDetails.value };
    delete next[job.id];
    importDetails.value = next;
    return;
  }
  if (importDetailsLoading.value.has(job.id)) return;
  importDetailsLoading.value = new Set(importDetailsLoading.value).add(job.id);
  await detailRequests.runLatest(
    ({ signal }) => api<KnowledgeImportStructureResponse>(
      `/knowledge/imports/${job.id}/structure?cursor=0&pageSize=50`,
      { signal },
    ),
    {
      commit(response) {
        importDetails.value = { ...importDetails.value, [job.id]: response };
      },
      onError(caught) {
        error.value = formatError(caught, '预检详情加载失败');
      },
    },
  );
  const next = new Set(importDetailsLoading.value);
  next.delete(job.id);
  importDetailsLoading.value = next;
}

async function loadMoreImportDetails(job: KnowledgeImportJob) {
  const current = importDetails.value[job.id];
  if (!current?.nextCursor || importDetailsLoading.value.has(job.id)) return;
  importDetailsLoading.value = new Set(importDetailsLoading.value).add(job.id);
  await detailRequests.runLatest(
    ({ signal }) => api<KnowledgeImportStructureResponse>(
      `/knowledge/imports/${job.id}/structure?cursor=${current.nextCursor}&pageSize=50`,
      { signal },
    ),
    {
      commit(response) {
        if (importDetails.value[job.id] !== current) return;
        importDetails.value = {
          ...importDetails.value,
          [job.id]: {
            ...current,
            items: [...current.items, ...response.items],
            nextCursor: response.nextCursor,
          },
        };
      },
      onError(caught) {
        error.value = formatError(caught, '更多预检结构加载失败');
      },
    },
  );
  const next = new Set(importDetailsLoading.value);
  next.delete(job.id);
  importDetailsLoading.value = next;
}

function previewQuery(documentId?: string, versionId?: string) {
  const query = { ...route.query };
  if (documentId && versionId) {
    query.previewDocumentId = documentId;
    query.previewVersionId = versionId;
  } else {
    delete query.previewDocumentId;
    delete query.previewVersionId;
  }
  void router?.replace({ query });
}

function openPreview(documentId: string, versionId: string) {
  previewDocumentId.value = documentId;
  previewVersionId.value = versionId;
  previewQuery(documentId, versionId);
}

function closePreview() {
  previewDocumentId.value = '';
  previewVersionId.value = '';
  previewQuery();
}

async function loadVersions(document: KnowledgeLibraryDocument) {
  if (versions.value[document.id]) {
    delete versions.value[document.id];
    versions.value = { ...versions.value };
    return;
  }
  await versionRequests.runLatest(
    ({ signal }) => api<{ items: KnowledgeVersion[] }>(
      `/knowledge/documents/${document.id}/versions`,
      { signal },
    ),
    {
      commit(result) {
        if (documents.value.some((item) => item.id === document.id))
          versions.value = { ...versions.value, [document.id]: result.items };
      },
      onError(caught) {
        error.value = formatError(caught, '版本加载失败');
      },
    },
  );
}

async function publishVersion(
  document: KnowledgeLibraryDocument,
  version: KnowledgeVersion,
) {
  if (version.indexStatus !== 'READY') return;
  await mutations.runBusy(`document:${document.id}`, async () => {
    try {
      await api(
        `/knowledge/documents/${document.id}/versions/${version.id}/publish`,
        { method: 'POST' },
      );
      if (documents.value.some((item) => item.id === document.id)) {
        document.activeVersionId = version.id;
        document.status = 'PUBLISHED';
      }
      toast.success('版本已发布');
    } catch (caught) {
      error.value = formatError(caught, '版本发布失败');
      toast.error(error.value);
      if (caught instanceof ApiClientError && caught.status === 409) await loadDocuments();
    }
  });
}

async function removeDocument(document: KnowledgeLibraryDocument) {
  const accepted = await confirm({
    title: '删除知识文档',
    body: `删除“${document.title}”的全部版本？向量和图片将进入后台清理。`,
    confirmText: '删除',
    danger: true,
  });
  if (!accepted) return;
  await mutations.runBusy(`document:${document.id}`, async () => {
    try {
      await api(`/knowledge/documents/${document.id}`, { method: 'DELETE' });
      documents.value = documents.value.filter((item) => item.id !== document.id);
      toast.success('知识文档已删除');
    } catch (caught) {
      error.value = formatError(caught, '文档删除失败');
      toast.error(error.value);
      if (caught instanceof ApiClientError && caught.status === 409) await loadDocuments();
    }
  });
}

async function removeLibrary() {
  const library = selectedLibrary.value;
  if (!library) return;
  const accepted = await confirm({
    title: '删除知识库',
    body: `删除“${library.name}”及其全部文档？向量和图片将进入后台清理。`,
    confirmText: '删除',
    danger: true,
  });
  if (!accepted) return;
  await mutations.runBusy(`library-delete:${library.id}`, async () => {
    try {
      await api(`/knowledge/libraries/${library.id}`, { method: 'DELETE' });
      libraries.value = libraries.value.filter((item) => item.id !== library.id);
      if (selectedLibraryId.value === library.id)
        selectedLibraryId.value = visibleLibraries.value[0]?.id ?? '';
      toast.success('知识库已删除');
    } catch (caught) {
      error.value = formatError(caught, '知识库删除失败');
      toast.error(error.value);
      if (caught instanceof ApiClientError && caught.status === 409) await loadBase(true);
    }
  });
}

function schedulePoll() {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
  if (!paneVisible.value || !hasActiveJobs.value) return;
  pollTimer = window.setTimeout(() => void loadBase(true), 4_000);
}

watch(paneVisible, (visible) => {
  if (!visible) {
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;
    baseRequests.cancelLatest();
    documentRequests.cancelLatest();
    detailRequests.cancelLatest();
    versionRequests.cancelLatest();
    loading.value = false;
    return;
  }
  void loadBase(true);
});

onMounted(() => {
  if (paneVisible.value) void loadBase();
  else loading.value = false;
});

onBeforeUnmount(() => {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  uploadController?.abort();
});
</script>

<template>
  <section class="library-manager" :aria-label="scope === 'PRIVATE' ? '私有知识库管理' : '共享知识库管理'">
    <div v-if="error" class="alert danger" role="alert">{{ error }}</div>
    <div v-if="loading" class="loading-row" role="status">
      <LoaderCircle :size="18" class="spin" aria-hidden="true" />
      正在加载
    </div>

    <template v-else>
      <form v-if="scope === 'SHARED'" class="library-create" @submit.prevent="createSubject">
        <div class="field">
          <label for="knowledge-subject-name">学科名称</label>
          <input id="knowledge-subject-name" v-model="newSubjectName" maxlength="100" required />
        </div>
        <div class="field">
          <label for="knowledge-subject-slug">学科标识</label>
          <input id="knowledge-subject-slug" v-model="newSubjectSlug" maxlength="100" required />
        </div>
        <button class="button ghost" type="submit" :disabled="busy || !newSubjectName.trim() || !newSubjectSlug.trim()">
          <Plus :size="16" aria-hidden="true" />
          新建学科
        </button>
      </form>

      <form class="library-create" @submit.prevent="createLibrary">
        <div class="field">
          <label :for="`library-name-${scope}`">知识库名称</label>
          <input :id="`library-name-${scope}`" v-model="name" maxlength="160" required />
        </div>
        <div class="field">
          <label :for="`library-subject-${scope}`">学科</label>
          <select :id="`library-subject-${scope}`" v-model="subjectId" required>
            <option v-for="subject in subjects" :key="subject.id" :value="subject.id">
              {{ subject.name }}
            </option>
          </select>
        </div>
        <button class="button" type="submit" :disabled="busy || !name.trim() || !subjectId">
          <Plus :size="16" aria-hidden="true" />
          新建
        </button>
      </form>

      <div v-if="visibleLibraries.length" class="library-toolbar">
        <label :for="`library-select-${scope}`">当前知识库</label>
        <select :id="`library-select-${scope}`" v-model="selectedLibraryId" :disabled="busy">
          <option v-for="library in visibleLibraries" :key="library.id" :value="library.id">
            {{ library.name }} · {{ library.subject.name }}
          </option>
        </select>
        <button type="button" class="button ghost" :disabled="busy" @click="loadBase()">
          <RefreshCw :size="15" aria-hidden="true" />
          刷新
        </button>
      </div>

      <template v-if="selectedLibrary">
        <div class="library-settings">
          <label class="toggle-row">
            <input
              type="checkbox"
              :checked="selectedLibrary.active"
              :disabled="busy"
              @change="toggleLibraryActive"
            />
            启用知识库
          </label>
          <template v-if="selectedLibrary.scope === 'PRIVATE'">
            <label v-if="!selectedLibrary.aiEnabled" class="toggle-row acknowledgement">
              <input v-model="acknowledged" type="checkbox" />
              我确认正文与图片替代文本将发送给第三方模型
            </label>
            <button type="button" class="button ghost" :disabled="busy" @click="toggleAi">
              <Check :size="15" aria-hidden="true" />
              {{ selectedLibrary.aiEnabled ? '关闭 AI' : '启用 AI' }}
            </button>
          </template>
          <button type="button" class="icon-button danger" title="删除知识库" :disabled="mutations.isBusy(`library-delete:${selectedLibrary.id}`)" @click="removeLibrary">
            <Trash2 :size="17" aria-hidden="true" />
            <span class="sr-only">删除知识库</span>
          </button>
        </div>

        <form class="import-form" @submit.prevent="upload">
          <div class="field file-field">
            <div class="file-field-header">
              <label :for="`knowledge-package-${scope}`">Markdown 或 ZIP</label>
              <div v-if="scope === 'PRIVATE'" class="authoring-guide-actions">
                <button
                  type="button"
                  class="button ghost authoring-guide-open"
                  @click="authoringGuideOpen = true"
                >
                  <CircleHelp :size="15" aria-hidden="true" />
                  文件编写说明
                </button>
                <button
                  type="button"
                  class="icon-button small authoring-guide-download"
                  title="下载知识库文件编写说明"
                  aria-label="下载知识库文件编写说明"
                  @click="downloadAuthoringGuide"
                >
                  <Download :size="16" aria-hidden="true" />
                </button>
              </div>
            </div>
            <input
              :id="`knowledge-package-${scope}`"
              ref="fileInput"
              type="file"
              accept=".md,.zip,text/markdown,application/zip"
              required
              @change="pickFile"
            />
          </div>
          <div class="field">
            <label :for="`target-document-${scope}`">写入目标</label>
            <select :id="`target-document-${scope}`" v-model="targetDocumentId">
              <option value="">新建文档</option>
              <option
                v-for="document in documents.filter((item) => item.kind === 'MARKDOWN')"
                :key="document.id"
                :value="document.id"
              >
                {{ document.title }}
              </option>
            </select>
          </div>
          <button class="button" type="submit" :disabled="busy || !file || !selectedLibrary.active">
            <Upload :size="16" aria-hidden="true" />
            上传
          </button>
          <button v-if="busy && file" type="button" class="button ghost" @click="cancelUpload">
            取消上传
          </button>
        </form>
        <progress v-if="progress" :value="progress.loaded" :max="progress.total || 1">
          {{ progress.percent }}%
        </progress>

        <section class="manager-section" aria-label="导入任务">
          <h3>导入任务</h3>
          <p v-if="!selectedImports.length" class="empty-state">暂无导入任务</p>
          <ul v-else class="task-list">
            <li v-for="job in selectedImports" :key="job.id">
              <FileArchive :size="17" aria-hidden="true" />
              <div>
                <strong>{{ job.title || job.sourceName }}</strong>
                <span>{{ job.status }} · {{ job.nodeCount }} 节点 · {{ job.estimatedChunkCount }} 分片 · {{ job.imageCount }} 图</span>
                <span v-if="job.errorMessage" class="danger-text">{{ job.errorMessage }}</span>
              </div>
              <button
                v-if="!['PREFLIGHT_PENDING', 'PREFLIGHTING'].includes(job.status)"
                type="button"
                class="button ghost small"
                :disabled="importDetailsLoading.has(job.id)"
                @click="toggleImportDetails(job)"
              >
                <ListTree :size="14" aria-hidden="true" />
                {{ importDetails[job.id] ? '收起预检' : '预检详情' }}
              </button>
              <button
                v-if="job.status === 'AWAITING_CONFIRMATION'"
                type="button"
                class="button small"
                :disabled="mutations.isBusy(`import:${job.id}`)"
                @click="confirmImport(job)"
              >
                确认索引
              </button>
              <button
                v-if="job.status === 'COMPENSATION_FAILED'"
                type="button"
                class="button small"
                :disabled="mutations.isBusy(`import:${job.id}`)"
                @click="retryCompensation(job)"
              >
                重试清理
              </button>
              <button
                v-if="['PREFLIGHT_PENDING', 'PREFLIGHTING', 'AWAITING_CONFIRMATION', 'INDEX_PENDING', 'PROCESSING'].includes(job.status)"
                type="button"
                class="button ghost small"
                :disabled="mutations.isBusy(`import:${job.id}`)"
                @click="cancelImport(job)"
              >
                取消
              </button>
              <section v-if="importDetails[job.id]" class="preflight-details" aria-label="预检详情">
                <div
                  v-if="importDetails[job.id]!.replacement"
                  class="replacement-summary"
                  :class="importDetails[job.id]!.replacement!.mode.toLowerCase()"
                >
                  <strong>
                    {{ importDetails[job.id]!.replacement!.mode === 'REPLACE' ? '整份替换' : '新建文档' }}
                  </strong>
                  <span v-if="importDetails[job.id]!.replacement!.mode === 'REPLACE'">
                    替换“{{ importDetails[job.id]!.replacement!.targetDocumentTitle }}”，保留首次创建位置
                    <template v-if="importDetails[job.id]!.replacement!.targetDocumentCreatedAt">
                      （{{ formatDate(importDetails[job.id]!.replacement!.targetDocumentCreatedAt!) }}）
                    </template>
                  </span>
                  <span v-else>确认后创建新的逻辑文档</span>
                  <span v-if="importDetails[job.id]!.replacement!.matchedH2Titles.length">
                    命中 H2：{{ importDetails[job.id]!.replacement!.matchedH2Titles.join('、') }}
                  </span>
                </div>
                <div class="preflight-version-title">
                  <span>H1 版本标识</span>
                  <KnowledgeMarkdownHeading
                    v-if="importDetails[job.id]!.titleMarkdown"
                    :markdown="importDetails[job.id]!.titleMarkdown!"
                    :fallback="job.title || job.sourceName"
                  />
                </div>
                <ol class="structure-list" :start="1">
                  <li v-for="item in importDetails[job.id]!.items" :key="item.path">
                    <span>H{{ item.level }}</span>
                    <KnowledgeMarkdownHeading :markdown="item.titleMarkdown" :fallback="item.title" />
                    <small>{{ item.chapterName }} · {{ item.chunkCount }} 分片</small>
                  </li>
                </ol>
                <button
                  v-if="importDetails[job.id]!.nextCursor !== null"
                  type="button"
                  class="button ghost small"
                  :disabled="importDetailsLoading.has(job.id)"
                  @click="loadMoreImportDetails(job)"
                >
                  加载更多（{{ importDetails[job.id]!.items.length }} / {{ importDetails[job.id]!.total }}）
                </button>
              </section>
            </li>
          </ul>
        </section>

        <section class="manager-section" aria-label="知识文档">
          <h3>知识文档</h3>
          <p v-if="!documents.length" class="empty-state">暂无文档</p>
          <ul v-else class="document-list">
            <li v-for="document in documents" :key="document.id">
              <button type="button" class="document-toggle" @click="loadVersions(document)">
                <strong>{{ document.title }}</strong>
                <span>{{ document.status }} · {{ document._count.versions }} 个版本</span>
              </button>
              <button
                type="button"
                class="document-delete"
                title="删除知识文档"
                :disabled="mutations.isBusy(`document:${document.id}`)"
                @click="removeDocument(document)"
              >
                <Trash2 :size="15" aria-hidden="true" />
                <span class="sr-only">删除知识文档</span>
              </button>
              <ul v-if="versions[document.id]" class="version-list">
                <li v-for="version in versions[document.id]" :key="version.id">
                  <span>v{{ version.version }} · {{ version.indexStatus }} · {{ version.chunkCount }} 分片</span>
                  <button
                    v-if="version.renderStatus === 'READY'"
                    type="button"
                    class="button ghost small"
                    @click="openPreview(document.id, version.id)"
                  >
                    <Eye :size="14" aria-hidden="true" />
                    预览
                  </button>
                  <button
                    v-if="version.indexStatus === 'READY' && document.activeVersionId !== version.id"
                    type="button"
                    class="button small"
                    :disabled="mutations.isBusy(`document:${document.id}`)"
                    @click="publishVersion(document, version)"
                  >
                    发布
                  </button>
                  <span v-else-if="document.activeVersionId === version.id" class="active-label">活动版本</span>
                </li>
              </ul>
            </li>
          </ul>
        </section>
      </template>

      <p v-else class="empty-state">暂无知识库</p>
    </template>

    <BaseDialog
      :open="authoringGuideOpen"
      title="知识库文件编写说明"
      :width="1120"
      @close="authoringGuideOpen = false"
    >
      <KnowledgeAuthoringGuide v-if="authoringGuideOpen" />
    </BaseDialog>

    <BaseDialog
      :open="Boolean(previewDocumentId && previewVersionId)"
      title="候选文档预览"
      :width="1180"
      @close="closePreview"
    >
      <KnowledgeCandidatePreview
        v-if="previewDocumentId && previewVersionId"
        :document-id="previewDocumentId"
        :version-id="previewVersionId"
      />
    </BaseDialog>
  </section>
</template>

<style scoped>
.library-manager {
  display: grid;
  gap: var(--space-5);
}

.library-create,
.library-toolbar,
.library-settings,
.import-form {
  display: flex;
  align-items: end;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.library-toolbar,
.library-settings {
  align-items: center;
}

.field {
  display: grid;
  gap: var(--space-1);
  min-width: min(240px, 100%);
}

.field label,
.library-toolbar > label {
  font-size: 13px;
  font-weight: 600;
}

.file-field {
  flex: 1 1 380px;
}

.file-field-header,
.authoring-guide-actions {
  min-width: 0;
  display: flex;
  align-items: center;
}

.file-field-header {
  justify-content: space-between;
  gap: var(--space-3);
}

.authoring-guide-actions {
  flex: none;
  gap: 6px;
}

.authoring-guide-open {
  min-height: 32px;
  padding: 0 11px;
  border-radius: var(--radius-m);
  box-shadow: none;
}

.authoring-guide-actions .icon-button {
  margin-left: 0;
}

input,
select {
  min-height: 40px;
  max-width: 100%;
}

.library-toolbar select {
  min-width: min(360px, 100%);
}

.toggle-row {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.acknowledgement {
  max-width: 460px;
  color: var(--muted);
  font-size: 13px;
}

.icon-button {
  width: 40px;
  height: 40px;
  display: inline-grid;
  place-items: center;
  margin-left: auto;
}

progress {
  width: 100%;
}

.manager-section {
  border-top: 1px solid var(--border);
  padding-top: var(--space-4);
}

.manager-section h3 {
  margin: 0 0 var(--space-3);
  font-size: 16px;
}

.task-list,
.document-list,
.version-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.task-list > li,
.version-list > li {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 48px;
  border-bottom: 1px solid var(--border-soft);
}

.task-list > li {
  flex-wrap: wrap;
}

.task-list > li > div {
  display: grid;
  flex: 1;
  min-width: 0;
}

.preflight-details {
  flex: 1 0 100%;
  min-width: 0;
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3) 0 var(--space-4) 29px;
  border-top: 1px dashed var(--border);
}

.replacement-summary {
  display: grid;
  gap: 3px;
  padding: 10px 12px;
  border-left: 3px solid var(--success);
  background: var(--success-bg);
  color: var(--ink-soft);
  font-size: 13px;
}

.replacement-summary.replace {
  border-left-color: var(--warning);
  background: var(--warning-bg);
}

.preflight-version-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.preflight-version-title > span,
.structure-list small,
.structure-list > li > span {
  color: var(--muted);
  font-size: 12px;
}

.structure-list {
  max-height: 320px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border-soft);
}

.structure-list li {
  min-width: 0;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--space-2);
  padding: 7px 4px;
  border-bottom: 1px solid var(--border-soft);
}

.task-list span,
.document-toggle span,
.version-list span {
  color: var(--muted);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.document-toggle {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 12px 0;
  border: 0;
  border-bottom: 1px solid var(--border-soft);
  background: transparent;
  text-align: left;
}

.document-toggle span {
  flex: 0 0 auto;
  white-space: nowrap;
}

.document-list > li {
  position: relative;
}

.document-delete {
  position: absolute;
  top: 8px;
  right: 0;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--danger);
}

.document-toggle {
  padding-right: 44px;
}

.version-list {
  padding-left: var(--space-4);
}

.version-list > li > :first-child {
  flex: 1;
}

.active-label {
  color: var(--success) !important;
  font-weight: 600;
}

.danger-text {
  color: var(--danger) !important;
}

.loading-row,
.empty-state {
  color: var(--muted);
}

.spin {
  animation: manager-spin 1s linear infinite;
}

@keyframes manager-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 640px) {
  .library-create,
  .library-toolbar,
  .library-settings,
  .import-form {
    align-items: stretch;
    flex-direction: column;
  }

  .file-field-header {
    align-items: flex-start;
  }

  .field,
  .library-toolbar select,
  .button {
    width: 100%;
  }

  .icon-button {
    margin-left: 0;
  }

  .task-list > li {
    align-items: stretch;
    flex-direction: column;
    padding: var(--space-3) 0;
  }

  .preflight-details {
    padding-left: 0;
  }

  .structure-list li {
    grid-template-columns: 28px minmax(0, 1fr);
  }

  .structure-list small {
    grid-column: 2;
  }
}
</style>
