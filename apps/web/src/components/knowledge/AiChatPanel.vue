<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
} from 'vue';
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  History,
  LockKeyhole,
  RotateCw,
  Search,
  Send,
  Square,
  Trash2,
  Users,
} from 'lucide-vue-next';
import {
  useSseChat,
  type KnowledgeChatScopeSelection,
} from '../../composables/useSseChat';
import { ApiClientError, api, formatError, isAbortError } from '../../lib/api';
import { conversationMessages } from '../../lib/aiConversation';
import { formatDateTime } from '../../lib/formatters';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useToast } from '../../composables/useToast';
import type {
  AiConversationDeleteResult,
  AiConversationDetail,
  AiConversationListResponse,
  AiConversationSummary,
  Citation,
  KnowledgeCitation,
  KnowledgeConversationMode,
  KnowledgeLibrary,
  KnowledgeLibraryChapterOption,
  KnowledgeLibraryChapterOptionsResponse,
  KnowledgeLibraryDirectoryResponse,
} from '../../types';
import BaseDialog from '../common/BaseDialog.vue';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import KnowledgeMarkdownHeading from './KnowledgeMarkdownHeading.vue';

const props = defineProps<{
  subjectId: string;
  initialConversationId?: string;
}>();
const emit = defineEmits<{
  locate: [citation: Citation];
  subjectChange: [subjectId: string];
  conversationChange: [conversationId: string | null];
}>();

const { confirm } = useConfirm();
const toast = useToast();

const mode = ref<KnowledgeConversationMode>('SHARED');
const libraryPage = ref(1);
const libraryQueryInput = ref('');
const libraryQuery = ref('');
const libraryData = ref<KnowledgeLibraryDirectoryResponse | null>(null);
const libraryLoading = ref(false);
const scopeError = ref('');
const selectedLibraryIds = ref<string[]>([]);
const knownLibraries = ref<Record<string, KnowledgeLibrary>>({});
const chaptersByLibrary = ref<Record<string, KnowledgeLibraryChapterOption[]>>(
  {},
);
const chapterMode = ref<'ALL' | 'SELECTED'>('ALL');
const selectedChapterIds = ref<string[]>([]);
let libraryController: AbortController | null = null;
let chapterGeneration = 0;

const historyOpen = ref(false);
const historyItems = ref<AiConversationSummary[]>([]);
const historyCursor = ref<string | null>(null);
const historyLoaded = ref(false);
const historyError = ref('');
const historyAppendError = ref('');
const selectedHistoryId = ref('');
const restoredConversation = ref<AiConversationDetail | null>(null);
const pendingRestore = ref<AiConversationDetail | null>(null);
const historyRequests = useLatestRequest();
const detailRequests = useLatestRequest();
const historyMutations = useLatestRequest();

const libraries = computed(() => libraryData.value?.items ?? []);
const libraryPageCount = computed(() =>
  Math.max(
    1,
    Math.ceil(
      (libraryData.value?.total ?? 0) /
        (libraryData.value?.pageSize ?? 12),
    ),
  ),
);
const selectedLibraries = computed(() =>
  selectedLibraryIds.value
    .map((id) => knownLibraries.value[id])
    .filter((library): library is KnowledgeLibrary => Boolean(library)),
);
const selectedChapters = computed(() =>
  selectedLibraries.value.flatMap(
    (library) => chaptersByLibrary.value[library.id] ?? [],
  ),
);
const lockedLibraries = computed(() =>
  restoredConversation.value?.libraries ?? selectedLibraries.value,
);
const lockedMode = computed(() =>
  restoredConversation.value?.knowledgeMode ?? mode.value,
);
const lockedChapterCount = computed(() =>
  restoredConversation.value
    ? restoredConversation.value.libraryChapters.length
    : selectedChapterIds.value.length,
);
const scopeValidation = computed(() => {
  if (!selectedLibraries.value.length) return '请至少选择一个知识库';
  if (selectedLibraries.value.some((library) => !libraryEligible(library))) {
    return '所选知识库当前不能用于 AI 问答';
  }
  const shared = selectedLibraries.value.filter(
    (library) => library.scope === 'SHARED',
  ).length;
  const privateCount = selectedLibraries.value.length - shared;
  if (mode.value === 'SHARED' && privateCount) return '共享模式只能选择共享知识库';
  if (mode.value === 'PRIVATE' && shared) return '私有模式只能选择我的知识库';
  if (mode.value === 'COMBINED' && (!shared || !privateCount)) {
    return '组合模式需要同时选择共享知识库和已启用 AI 的私有知识库';
  }
  if (
    chapterMode.value === 'SELECTED' &&
    !selectedChapterIds.value.length
  ) {
    return '指定章节模式下请至少选择一个章节';
  }
  return '';
});
const chatScope = computed<KnowledgeChatScopeSelection | null>(() =>
  scopeValidation.value
    ? null
    : {
        subjectId: props.subjectId,
        knowledgeMode: mode.value,
        libraryIds: [...selectedLibraryIds.value],
        ...(chapterMode.value === 'SELECTED'
          ? { libraryChapterIds: [...selectedChapterIds.value] }
          : {}),
      },
);
const {
  messages,
  busy,
  error,
  conversationId,
  ask,
  retry,
  abort,
  reset,
  restore,
} = useSseChat(chatScope);
const scopeLocked = computed(() => Boolean(conversationId.value));
const scopeControlsDisabled = computed(() => scopeLocked.value || busy.value);
const question = ref('');
const scroller = ref<HTMLElement>();
const FOLLOW_THRESHOLD = 80;
let scrollQueued = false;

function libraryEligible(library: KnowledgeLibrary) {
  return (
    (library.reader?.documentCount ?? 0) > 0 &&
    (library.scope === 'SHARED' || library.aiEnabled)
  );
}

function modeScope() {
  if (mode.value === 'SHARED') return 'SHARED';
  if (mode.value === 'PRIVATE') return 'PRIVATE';
  return undefined;
}

async function loadLibraries() {
  libraryController?.abort();
  libraryController = new AbortController();
  libraryLoading.value = true;
  scopeError.value = '';
  const params = new URLSearchParams({
    subjectId: props.subjectId,
    page: String(libraryPage.value),
    pageSize: '12',
  });
  const scope = modeScope();
  if (scope) params.set('scope', scope);
  if (libraryQuery.value) params.set('query', libraryQuery.value);
  try {
    const result = await api<KnowledgeLibraryDirectoryResponse>(
      `/knowledge/libraries?${params.toString()}`,
      { signal: libraryController.signal },
    );
    libraryData.value = result;
    const next = { ...knownLibraries.value };
    for (const library of result.items) next[library.id] = library;
    knownLibraries.value = next;
  } catch (caught) {
    if (!isAbortError(caught)) {
      scopeError.value = formatError(caught, '知识库范围加载失败');
    }
  } finally {
    libraryLoading.value = false;
  }
}

async function loadLibraryChapters(libraryId: string, generation: number) {
  if (chaptersByLibrary.value[libraryId]) return;
  const items: KnowledgeLibraryChapterOption[] = [];
  let page = 1;
  let total = 0;
  do {
    const response = await api<KnowledgeLibraryChapterOptionsResponse>(
      `/knowledge/libraries/${encodeURIComponent(libraryId)}/chapters?page=${page}&pageSize=100`,
    );
    if (generation !== chapterGeneration) return;
    items.push(...response.items);
    total = response.total;
    page += 1;
  } while (items.length < total);
  chaptersByLibrary.value = {
    ...chaptersByLibrary.value,
    [libraryId]: items,
  };
}

function applyLibrarySearch() {
  libraryQuery.value = libraryQueryInput.value.trim();
  libraryPage.value = 1;
  void loadLibraries();
}

function changeLibraryPage(page: number) {
  libraryPage.value = Math.min(libraryPageCount.value, Math.max(1, page));
  void loadLibraries();
}

function changeMode(nextMode: KnowledgeConversationMode) {
  if (scopeControlsDisabled.value || mode.value === nextMode) return;
  mode.value = nextMode;
  selectedLibraryIds.value = [];
  selectedChapterIds.value = [];
  chapterMode.value = 'ALL';
  libraryPage.value = 1;
  void loadLibraries();
}

function toggleLibrary(library: KnowledgeLibrary) {
  if (scopeControlsDisabled.value || !libraryEligible(library)) return;
  const selected = selectedLibraryIds.value.includes(library.id);
  if (selected) {
    selectedLibraryIds.value = selectedLibraryIds.value.filter(
      (id) => id !== library.id,
    );
    const chapterIds = new Set(
      (chaptersByLibrary.value[library.id] ?? []).map((chapter) => chapter.id),
    );
    selectedChapterIds.value = selectedChapterIds.value.filter(
      (id) => !chapterIds.has(id),
    );
    return;
  }
  if (selectedLibraryIds.value.length >= 20) {
    scopeError.value = '每个会话最多选择 20 个知识库';
    return;
  }
  knownLibraries.value = {
    ...knownLibraries.value,
    [library.id]: library,
  };
  selectedLibraryIds.value = [...selectedLibraryIds.value, library.id];
  const generation = chapterGeneration;
  void loadLibraryChapters(library.id, generation).catch((caught) => {
    if (generation === chapterGeneration) {
      scopeError.value = formatError(caught, '知识库章节加载失败');
    }
  });
}

function setChapterMode(nextMode: 'ALL' | 'SELECTED') {
  if (scopeControlsDisabled.value) return;
  chapterMode.value = nextMode;
  if (nextMode === 'ALL') selectedChapterIds.value = [];
}

function toggleChapter(chapterId: string) {
  if (scopeControlsDisabled.value) return;
  selectedChapterIds.value = selectedChapterIds.value.includes(chapterId)
    ? selectedChapterIds.value.filter((id) => id !== chapterId)
    : [...selectedChapterIds.value, chapterId];
}

function startNewScope() {
  const restored = Boolean(restoredConversation.value);
  pendingRestore.value = null;
  restoredConversation.value = null;
  selectedHistoryId.value = '';
  if (restored) {
    selectedLibraryIds.value = [];
    selectedChapterIds.value = [];
    chapterMode.value = 'ALL';
  }
  reset();
}

function openHistory() {
  historyOpen.value = true;
  if (!historyLoaded.value) void loadHistory(false);
}

async function loadHistory(append: boolean) {
  if (append && (!historyCursor.value || historyRequests.loading.value)) return;
  const cursor = append ? historyCursor.value : null;
  if (!append) {
    historyError.value = '';
    historyAppendError.value = '';
  }
  const params = new URLSearchParams({ pageSize: '20' });
  if (cursor) params.set('cursor', cursor);
  await historyRequests.runLatest(
    ({ signal }) => api<AiConversationListResponse>(
      `/ai/conversations?${params.toString()}`,
      { signal },
    ),
    {
      commit(result) {
        const merged = append
          ? [...historyItems.value, ...result.items]
          : result.items;
        historyItems.value = Array.from(
          new Map(merged.map((item) => [item.id, item])).values(),
        );
        historyCursor.value = result.nextCursor;
        historyLoaded.value = true;
      },
      onError(caught) {
        const message = formatError(caught, 'AI 会话历史加载失败');
        if (append) historyAppendError.value = message;
        else historyError.value = message;
      },
    },
  );
}

function applyRestoredConversation(detail: AiConversationDetail) {
  restoredConversation.value = detail;
  selectedHistoryId.value = detail.id;
  mode.value = detail.knowledgeMode ?? 'SHARED';
  selectedLibraryIds.value = detail.libraries.map((library) => library.id);
  selectedChapterIds.value = detail.libraryChapters.map((chapter) => chapter.id);
  chapterMode.value = detail.libraryChapters.length ? 'SELECTED' : 'ALL';
  restore(detail.id, conversationMessages(detail.messages));
  historyOpen.value = false;
}

async function openConversation(id: string) {
  if (busy.value || id === conversationId.value) {
    if (id === conversationId.value) historyOpen.value = false;
    return;
  }
  historyError.value = '';
  await detailRequests.runLatest(
    ({ signal }) => api<AiConversationDetail>(
      `/ai/conversations/${encodeURIComponent(id)}`,
      { signal },
    ),
    {
      commit(detail) {
        if (detail.subjectId && detail.subjectId !== props.subjectId) {
          pendingRestore.value = detail;
          emit('subjectChange', detail.subjectId);
          return;
        }
        applyRestoredConversation(detail);
      },
      onError(caught) {
        historyError.value = formatError(caught, 'AI 会话详情加载失败');
        if (props.initialConversationId === id) {
          scopeError.value = historyError.value;
          emit('conversationChange', null);
        }
      },
    },
  );
}

async function deleteConversation(item: AiConversationSummary) {
  if (busy.value && item.id === conversationId.value) return;
  const accepted = await confirm({
    title: '删除 AI 会话',
    body: `会话「${item.title}」及其消息将永久删除，审计记录仍会保留。`,
    confirmText: '删除会话',
    danger: true,
  });
  if (!accepted) return;
  await historyMutations.runBusy(`conversation:${item.id}`, async () => {
    try {
      await api<AiConversationDeleteResult>(
        `/ai/conversations/${encodeURIComponent(item.id)}`,
        { method: 'DELETE' },
      );
      historyItems.value = historyItems.value.filter(
        (conversation) => conversation.id !== item.id,
      );
      if (item.id === conversationId.value) startNewScope();
      if (pendingRestore.value?.id === item.id) pendingRestore.value = null;
      toast.success('AI 会话已删除');
    } catch (caught) {
      toast.error(formatError(caught, 'AI 会话删除失败'));
      if (caught instanceof ApiClientError && caught.status === 404)
        await loadHistory(false);
    }
  });
}

watch(
  () => props.subjectId,
  () => {
    abort();
    reset();
    restoredConversation.value = null;
    selectedHistoryId.value = '';
    chapterGeneration += 1;
    selectedLibraryIds.value = [];
    selectedChapterIds.value = [];
    chaptersByLibrary.value = {};
    knownLibraries.value = {};
    libraryPage.value = 1;
    void loadLibraries();
    const pending = pendingRestore.value;
    if (pending && pending.subjectId === props.subjectId) {
      pendingRestore.value = null;
      applyRestoredConversation(pending);
    }
  },
  { immediate: true },
);

watch(
  () => props.initialConversationId,
  (id) => {
    if (id && id !== conversationId.value) void openConversation(id);
  },
  { immediate: true },
);

watch(conversationId, (id) => emit('conversationChange', id ?? null));

watch(
  () => messages.value.at(-1)?.content,
  () => {
    if (scrollQueued) return;
    scrollQueued = true;
    void nextTick(() => {
      scrollQueued = false;
      const element = scroller.value;
      if (!element) return;
      const nearBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight <
        FOLLOW_THRESHOLD;
      if (nearBottom) element.scrollTo({ top: element.scrollHeight });
    });
  },
);

async function submit() {
  const text = question.value.trim();
  if (!text || busy.value || (!scopeLocked.value && !chatScope.value)) return;
  question.value = '';
  await ask(text);
  if (conversationId.value) await loadHistory(false);
}

async function retryQuestion() {
  await retry();
  if (conversationId.value) await loadHistory(false);
}

function isKnowledgeCitation(citation: Citation): citation is KnowledgeCitation {
  return 'libraryName' in citation;
}

function citationLabel(citation: Citation) {
  return isKnowledgeCitation(citation)
    ? `${citation.libraryName} · ${citation.headingPath
        .map((item) => item.title)
        .join(' > ')}`
    : citation.title;
}

function imageCitation(index: number | undefined, citations: Citation[] | undefined) {
  if (!index) return undefined;
  return citations?.find(
    (citation) => isKnowledgeCitation(citation) && citation.index === index,
  );
}

onBeforeUnmount(() => {
  libraryController?.abort();
  historyRequests.cancelLatest();
  detailRequests.cancelLatest();
  abort();
});
</script>

<template>
  <section class="chat" aria-label="AI 知识问答">
    <header class="scope-panel">
      <div class="scope-heading">
        <strong>知识范围</strong>
        <div class="scope-actions">
          <button
            type="button"
            class="button ghost small"
            :disabled="busy"
            @click="openHistory"
          >
            <History :size="15" aria-hidden="true" />
            会话历史
          </button>
          <button
            v-if="scopeLocked"
            type="button"
            class="button ghost small"
            :disabled="busy"
            @click="startNewScope"
          >
            更换范围
          </button>
        </div>
      </div>

      <div v-if="scopeLocked" class="locked-scope">
        <span>{{ lockedMode === 'SHARED' ? '共享' : lockedMode === 'PRIVATE' ? '私有' : '组合' }}</span>
        <strong v-for="library in lockedLibraries" :key="library.id">{{ library.name }}</strong>
        <span>{{ lockedChapterCount ? `${lockedChapterCount} 个指定章节` : '全部章节' }}</span>
      </div>

      <template v-else>
        <div class="mode-segments" role="group" aria-label="知识库模式">
          <button type="button" :class="{ active: mode === 'SHARED' }" :disabled="busy" @click="changeMode('SHARED')">共享</button>
          <button type="button" :class="{ active: mode === 'PRIVATE' }" :disabled="busy" @click="changeMode('PRIVATE')">私有</button>
          <button type="button" :class="{ active: mode === 'COMBINED' }" :disabled="busy" @click="changeMode('COMBINED')">组合</button>
        </div>

        <form class="library-search" role="search" @submit.prevent="applyLibrarySearch">
          <label class="sr-only" for="chat-library-search">搜索知识库</label>
          <input id="chat-library-search" v-model="libraryQueryInput" maxlength="160" placeholder="搜索知识库" :disabled="busy" />
          <button type="submit" class="icon-button" title="搜索" aria-label="搜索知识库" :disabled="busy">
            <Search :size="16" aria-hidden="true" />
          </button>
        </form>

        <p v-if="scopeError" class="scope-message danger-text" role="alert">{{ scopeError }}</p>
        <div class="library-options" :aria-busy="libraryLoading">
          <label v-for="library in libraries" :key="library.id" class="library-option" :class="{ disabled: !libraryEligible(library) }">
            <input
              type="checkbox"
              :checked="selectedLibraryIds.includes(library.id)"
              :disabled="busy || !libraryEligible(library)"
              @change="toggleLibrary(library)"
            />
            <Users v-if="library.scope === 'SHARED'" :size="16" aria-hidden="true" />
            <LockKeyhole v-else :size="16" aria-hidden="true" />
            <span>
              <strong>{{ library.name }}</strong>
              <small v-if="(library.reader?.documentCount ?? 0) === 0">暂无可检索内容</small>
              <small v-else-if="library.scope === 'PRIVATE' && !library.aiEnabled">未启用 AI</small>
              <small v-else>{{ library.reader?.h2Count ?? 0 }} 个章节</small>
            </span>
          </label>
          <p v-if="!libraryLoading && !libraries.length" class="scope-message">没有符合条件的知识库</p>
        </div>

        <div v-if="libraryPageCount > 1" class="library-pagination" aria-label="知识库分页">
          <button type="button" class="icon-button" title="上一页" aria-label="上一页" :disabled="libraryPage <= 1 || busy" @click="changeLibraryPage(libraryPage - 1)">
            <ChevronLeft :size="17" aria-hidden="true" />
          </button>
          <span>{{ libraryPage }} / {{ libraryPageCount }}</span>
          <button type="button" class="icon-button" title="下一页" aria-label="下一页" :disabled="libraryPage >= libraryPageCount || busy" @click="changeLibraryPage(libraryPage + 1)">
            <ChevronRight :size="17" aria-hidden="true" />
          </button>
        </div>

        <div v-if="selectedLibraries.length" class="chapter-scope">
          <div class="chapter-heading">
            <strong>章节范围</strong>
            <div class="mode-segments compact" role="group" aria-label="章节范围">
              <button type="button" :class="{ active: chapterMode === 'ALL' }" :disabled="busy" @click="setChapterMode('ALL')">全部</button>
              <button type="button" :class="{ active: chapterMode === 'SELECTED' }" :disabled="busy" @click="setChapterMode('SELECTED')">指定章节</button>
            </div>
          </div>
          <div v-if="chapterMode === 'SELECTED'" class="chapter-groups">
            <fieldset v-for="library in selectedLibraries" :key="library.id">
              <legend>{{ library.name }}</legend>
              <label v-for="chapter in chaptersByLibrary[library.id] ?? []" :key="chapter.id">
                <input type="checkbox" :checked="selectedChapterIds.includes(chapter.id)" :disabled="busy" @change="toggleChapter(chapter.id)" />
                {{ chapter.name }}
              </label>
              <span v-if="!(chaptersByLibrary[library.id]?.length)" class="scope-message">暂无章节</span>
            </fieldset>
          </div>
        </div>
        <p v-if="scopeValidation" class="scope-message">{{ scopeValidation }}</p>
      </template>
    </header>

    <div ref="scroller" class="chat-messages">
      <p v-if="restoredConversation?.hasEarlierMessages" class="history-limit" role="status">
        此会话较长，当前显示最近 200 条消息。
      </p>
      <div v-if="!messages.length" class="chat-welcome">
        <Bot :size="30" aria-hidden="true" />
        <p>选择知识范围后开始提问。</p>
      </div>

      <div v-for="(message, messageIndex) in messages" :key="messageIndex" class="message-row" :class="message.role">
        <div class="message" :class="[message.role, message.status]">
          <p class="message-content">
            {{ message.content || (message.status === 'streaming' ? '正在检索与生成…' : '') }}
            <span v-if="message.status === 'streaming' && message.content" class="stream-caret" aria-hidden="true" />
          </p>

          <p v-if="message.status === 'aborted'" class="message-note">已中止生成，可以重新提问。</p>
          <div v-else-if="message.status === 'failed'" class="message-note failed">
            <span>{{ error || '回答失败' }}</span>
            <button type="button" class="retry-link" @click="retryQuestion">
              <RotateCw :size="13" aria-hidden="true" />
              重新提问
            </button>
          </div>

          <div v-if="message.citations?.length" class="citations">
            <strong>引用资料</strong>
            <button
              v-for="citation in message.citations"
              :key="isKnowledgeCitation(citation) ? `${citation.documentVersionId}-${citation.index}` : `${citation.documentId ?? citation.title}-${citation.index ?? 0}`"
              type="button"
              class="citation-link"
              :aria-label="citationLabel(citation)"
              :disabled="!isKnowledgeCitation(citation) && !citation.documentId"
              @click="emit('locate', citation)"
            >
              <template v-if="isKnowledgeCitation(citation)">
                <span>{{ citation.libraryName }} · </span>
                <template v-for="(heading, headingIndex) in citation.headingPath" :key="heading.nodeId">
                  <span v-if="headingIndex" aria-hidden="true"> &gt; </span>
                  <KnowledgeMarkdownHeading :markdown="heading.titleMarkdown" :fallback="heading.title" />
                </template>
              </template>
              <template v-else>
                {{ citation.title }}<span v-if="citation.pageNumber"> · 第 {{ citation.pageNumber }} 页</span>
              </template>
            </button>
          </div>
          <div v-if="message.images?.length" class="answer-images">
            <button
              v-for="image in message.images"
              :key="image.photoId"
              type="button"
              :disabled="!imageCitation(image.citationIndex, message.citations)"
              @click="imageCitation(image.citationIndex, message.citations) && emit('locate', imageCitation(image.citationIndex, message.citations)!)"
            >
              <img :src="image.url" :alt="image.altText" loading="lazy" />
              <span>{{ image.altText }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <form class="chat-form" @submit.prevent="submit">
      <label for="chat-question" class="sr-only">输入问题</label>
      <input id="chat-question" v-model="question" maxlength="2000" placeholder="询问所选知识范围" :disabled="busy" />
      <button v-if="busy" type="button" class="button danger" @click="abort">
        <Square :size="15" aria-hidden="true" />
        中止
      </button>
      <button v-else type="submit" class="button" :disabled="!question.trim() || (!scopeLocked && !chatScope)">
        <Send :size="16" aria-hidden="true" />
        发送
      </button>
    </form>
    <p class="chat-disclaimer">AI 内容仅供学习，不构成诊疗建议。</p>

    <BaseDialog
      :open="historyOpen"
      title="AI 会话历史"
      :width="760"
      @close="historyOpen = false"
    >
      <div class="history-dialog">
        <div class="history-toolbar">
          <span>仅显示当前账号的会话</span>
          <button
            type="button"
            class="icon-button"
            title="刷新会话历史"
            aria-label="刷新会话历史"
            :disabled="historyRequests.loading.value || detailRequests.loading.value"
            @click="loadHistory(false)"
          >
            <RotateCw :size="16" aria-hidden="true" />
          </button>
        </div>
        <p v-if="historyError && historyItems.length" class="alert error" role="alert">{{ historyError }}</p>
        <SkeletonBlock
          v-if="(historyRequests.loading.value || detailRequests.loading.value) && !historyLoaded"
          :lines="5"
        />
        <ErrorState
          v-else-if="historyError && !historyItems.length"
          :message="historyError"
          retry-label="重试加载会话历史"
          @retry="loadHistory(false)"
        />
        <EmptyState v-else-if="!historyItems.length" title="暂无 AI 会话" />
        <ul v-else class="history-list" :aria-busy="detailRequests.loading.value || undefined">
          <li
            v-for="item in historyItems"
            :key="item.id"
            :class="{ active: item.id === conversationId }"
          >
            <button
              type="button"
              class="history-main"
              :disabled="busy || detailRequests.loading.value"
              @click="openConversation(item.id)"
            >
              <strong>{{ item.title }}</strong>
              <span>
                {{ item.subject?.name ?? '未关联学科' }} · {{ item.messageCount }} 条消息 ·
                {{ formatDateTime(item.updatedAt) }}
              </span>
              <small>
                {{ item.libraries.length ? item.libraries.map((library) => library.name).join('、') : '未记录知识库' }}
              </small>
            </button>
            <button
              type="button"
              class="icon-button history-delete"
              :title="busy && item.id === conversationId ? '生成期间不能删除当前会话' : '删除会话'"
              :aria-label="`删除会话${item.title}`"
              :disabled="
                historyMutations.isBusy(`conversation:${item.id}`)
                || detailRequests.loading.value
                || (busy && item.id === conversationId)
              "
              @click="deleteConversation(item)"
            >
              <Trash2 :size="16" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p v-if="historyAppendError" class="alert error" role="alert">{{ historyAppendError }}</p>
        <button
          v-if="historyCursor"
          type="button"
          class="button ghost history-more"
          :disabled="historyRequests.loading.value"
          @click="loadHistory(true)"
        >
          {{ historyRequests.loading.value ? '正在加载…' : '加载更多会话' }}
        </button>
      </div>
    </BaseDialog>
  </section>
</template>

<style scoped>
.chat {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-s);
  overflow: hidden;
}

.scope-panel {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface-tint);
}

.scope-heading,
.chapter-heading,
.locked-scope,
.library-pagination {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.scope-heading,
.chapter-heading {
  justify-content: space-between;
}

.scope-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.locked-scope {
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 13px;
}

.locked-scope strong {
  color: var(--ink);
}

.mode-segments {
  width: fit-content;
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-muted);
}

.mode-segments button {
  min-height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.mode-segments button.active {
  background: var(--surface);
  color: var(--primary);
  box-shadow: var(--shadow-s);
}

.mode-segments.compact button {
  min-height: 30px;
  padding-inline: 10px;
  font-size: 12px;
}

.library-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: min(420px, 100%);
}

.library-search input {
  min-width: 0;
  flex: 1;
  min-height: 38px;
  padding: 0 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface);
}

.library-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-top: 1px solid var(--border);
}

.library-option {
  min-width: 0;
  min-height: 54px;
  display: grid;
  grid-template-columns: auto 18px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-soft);
  cursor: pointer;
}

.library-option:nth-child(odd) {
  border-right: 1px solid var(--border-soft);
}

.library-option.disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.library-option > span {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.library-option strong,
.library-option small {
  overflow-wrap: anywhere;
}

.library-option small {
  color: var(--muted);
}

.library-pagination {
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
}

.chapter-scope {
  display: grid;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
}

.chapter-groups {
  max-height: 220px;
  overflow-y: auto;
  display: grid;
  gap: var(--space-3);
}

.chapter-groups fieldset {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 0;
  padding: 8px 0 0;
  border: 0;
}

.chapter-groups legend {
  width: 100%;
  color: var(--ink-soft);
  font-size: 13px;
  font-weight: 600;
}

.chapter-groups label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.scope-message {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.danger-text {
  color: var(--danger);
}

.chat-messages {
  min-height: 320px;
  max-height: 54vh;
  overflow-y: auto;
  padding: var(--space-5);
  display: grid;
  gap: var(--space-4);
  align-content: start;
}

.history-limit {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-left: 3px solid var(--accent);
  color: var(--muted);
  background: var(--accent-soft);
  font-size: 12px;
}

.history-dialog {
  display: grid;
  gap: var(--space-4);
}

.history-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 13px;
}

.history-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}

.history-list li {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  border-bottom: 1px solid var(--border);
}

.history-list li:first-child {
  border-top: 1px solid var(--border);
}

.history-list li.active {
  background: var(--primary-soft);
}

.history-main {
  min-width: 0;
  display: grid;
  gap: 3px;
  padding: var(--space-4) 0;
  border: 0;
  color: var(--ink);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.history-main strong,
.history-main span,
.history-main small {
  overflow-wrap: anywhere;
}

.history-main span,
.history-main small {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.history-delete {
  color: var(--danger);
}

.history-more {
  justify-self: center;
}

.chat-welcome {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  padding: var(--space-10) var(--space-5);
  color: var(--muted);
  text-align: center;
}

.chat-welcome p,
.message-content {
  margin: 0;
}

.message-row {
  display: flex;
}

.message-row.user {
  justify-content: flex-end;
}

.message {
  max-width: 84%;
  padding: 12px 16px;
  border-radius: var(--radius-l);
  line-height: 1.7;
}

.message.user {
  border-bottom-right-radius: var(--radius-s);
  background: var(--gradient-primary);
  color: #ffffff;
  box-shadow: 0 8px 18px -10px rgba(20, 31, 75, 0.5);
}

.message.assistant {
  border: 1px solid #cfe4e6;
  border-bottom-left-radius: var(--radius-s);
  background: var(--info-bg);
}

.message.assistant.failed {
  background: var(--danger-bg);
}

.message-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.stream-caret {
  display: inline-block;
  width: 8px;
  height: 1.1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--accent);
  animation: caret-blink 0.9s step-end infinite;
}

@keyframes caret-blink {
  50% { opacity: 0; }
}

.message-note {
  margin: var(--space-2) 0 0;
  font-size: 13px;
  color: var(--muted);
}

.message-note.failed {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--danger);
}

.retry-link,
.citation-link {
  border: 0;
  background: none;
  padding: 0;
  cursor: pointer;
}

.retry-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--danger);
  font-size: 13px;
  text-decoration: underline;
}

.citations {
  margin-top: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px solid #b8d8db;
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}

.citation-link {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  color: var(--accent-dark);
  font-size: 12px;
  text-align: left;
}

.citation-link:hover:not(:disabled) {
  text-decoration: underline;
}

.citation-link:disabled {
  color: var(--muted);
  cursor: default;
}

.answer-images {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.answer-images button {
  min-width: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface);
  color: var(--muted);
  text-align: left;
  overflow: hidden;
  cursor: pointer;
}

.answer-images button:disabled {
  cursor: default;
}

.answer-images img {
  display: block;
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: contain;
}

.answer-images span {
  display: block;
  padding: 6px 8px;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.chat-form {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3);
  border-top: 1px solid var(--border);
  background: var(--surface-tint);
}

.chat-form input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 0 18px;
  background: var(--surface);
}

.chat-form input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--focus-ring);
}

.chat-disclaimer {
  margin: 0;
  padding: 0 var(--space-3) var(--space-3);
  color: var(--muted);
  font-size: 12px;
}

@media (max-width: 680px) {
  .library-options {
    grid-template-columns: 1fr;
  }

  .library-option:nth-child(odd) {
    border-right: 0;
  }

  .scope-heading,
  .chapter-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .scope-actions {
    width: 100%;
  }

  .scope-actions .button {
    flex: 1;
  }

  .mode-segments {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .mode-segments.compact {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .message {
    max-width: 94%;
  }

  .chat-form {
    flex-wrap: wrap;
  }

  .chat-form input {
    flex-basis: 100%;
  }

  .chat-form .button {
    width: 100%;
  }
}
</style>
