<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PageHeader from '../components/layout/PageHeader.vue';
import EmptyState from '../components/common/EmptyState.vue';
import ErrorState from '../components/common/ErrorState.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import AiChatPanel from '../components/knowledge/AiChatPanel.vue';
import KnowledgeLibraryDirectory from '../components/knowledge/KnowledgeLibraryDirectory.vue';
import KnowledgeLibraryManager from '../components/knowledge/KnowledgeLibraryManager.vue';
import KnowledgeReader from '../components/knowledge/KnowledgeReader.vue';
import { useAsyncState } from '../composables/useAsyncState';
import { api } from '../lib/api';
import type {
  Citation,
  KnowledgeCitation,
  KnowledgeLibrary,
  KnowledgeSubject,
} from '../types';

const route = useRoute();
const router = useRouter();
const tab = ref<'browse' | 'chat' | 'manage'>(
  typeof route.query.conversation === 'string' ? 'chat' : 'browse',
);
const selectedSubjectId = ref<string | null>(null);
const selectedLibraryId = ref(
  typeof route.query.libraryId === 'string' ? route.query.libraryId : null,
);
const subjectsState = useAsyncState(async () => api<KnowledgeSubject[]>('/subjects'));
const subjects = computed(() => subjectsState.data.value ?? []);
const subjectsLoading = computed(() => subjectsState.loading.value);
const subjectsLoaded = computed(() => subjectsState.loaded.value);
const subjectsError = computed(() => subjectsState.error.value);
const initialNodeId = computed(() =>
  typeof route.query.nodeId === 'string' ? route.query.nodeId : undefined,
);
const initialBlockId = computed(() =>
  typeof route.query.blockId === 'string' ? route.query.blockId : undefined,
);
const initialConversationId = computed(() =>
  typeof route.query.conversation === 'string'
    ? route.query.conversation
    : undefined,
);
const initialView = computed<'READ' | 'MINDMAP'>(() =>
  route.query.view === 'mindmap' ? 'MINDMAP' : 'READ',
);

function rememberedSubject() {
  try {
    return window.localStorage.getItem('knowledge-subject-id');
  } catch {
    return null;
  }
}

function rememberSubject(subjectId: string) {
  try {
    window.localStorage.setItem('knowledge-subject-id', subjectId);
  } catch {
    // 偏好写入失败不影响当前授权请求
  }
}

function routeSubject() {
  return typeof route.query.subjectId === 'string'
    ? route.query.subjectId
    : null;
}

watch(
  subjects,
  (items) => {
    if (!items.length || selectedSubjectId.value) return;
    const candidate = routeSubject() ?? rememberedSubject();
    if (candidate && items.some((subject) => subject.id === candidate)) {
      selectedSubjectId.value = candidate;
    }
  },
  { immediate: true },
);

function cleanQuery(
  values: Record<string, string | undefined>,
) {
  const query = { ...route.query } as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete query[key];
    else query[key] = value;
  }
  return query;
}

function selectSubject(subjectId: string, preserveConversation = false) {
  if (!subjectId || subjectId === selectedSubjectId.value) return;
  selectedSubjectId.value = subjectId;
  selectedLibraryId.value = null;
  rememberSubject(subjectId);
  const updates: Record<string, string | undefined> = {
      subjectId,
      libraryId: undefined,
      view: undefined,
      nodeId: undefined,
      blockId: undefined,
  };
  if (!preserveConversation) updates.conversation = undefined;
  void router.replace({
    query: cleanQuery(updates),
  });
}

function restoreConversationSubject(subjectId: string) {
  selectSubject(subjectId, true);
}

function updateConversation(conversationId: string | null) {
  void router.replace({
    query: cleanQuery({
      conversation: conversationId ?? undefined,
      subjectId: selectedSubjectId.value ?? undefined,
    }),
  });
}

function openLibrary(library: KnowledgeLibrary) {
  selectedLibraryId.value = library.id;
  void router.replace({
    query: cleanQuery({
      subjectId: selectedSubjectId.value ?? undefined,
      libraryId: library.id,
      view: 'read',
      nodeId: undefined,
      blockId: undefined,
    }),
  });
}

function closeReader() {
  selectedLibraryId.value = null;
  void router.replace({
    query: cleanQuery({
      libraryId: undefined,
      view: undefined,
      nodeId: undefined,
      blockId: undefined,
    }),
  });
}

function updateLocation(location: { nodeId: string; blockId?: string }) {
  void router.replace({
    query: cleanQuery({
      view: 'read',
      nodeId: location.nodeId,
      blockId: location.blockId,
    }),
  });
}

function updateView(view: 'READ' | 'MINDMAP') {
  void router.replace({
    query: cleanQuery({ view: view === 'MINDMAP' ? 'mindmap' : 'read' }),
  });
}

function locateCitation(citation: Citation) {
  tab.value = 'browse';
  if (!('libraryName' in citation)) return;
  const target = citation as KnowledgeCitation;
  selectedLibraryId.value = target.libraryId;
  void router.replace({
    query: cleanQuery({
      subjectId: selectedSubjectId.value ?? undefined,
      libraryId: target.libraryId,
      view: 'read',
      nodeId: target.nodeId,
      blockId: target.renderBlockId,
    }),
  });
}

async function retrySubjects() {
  await subjectsState.reload();
  if (
    selectedSubjectId.value &&
    !subjects.value.some((subject) => subject.id === selectedSubjectId.value)
  ) {
    selectedSubjectId.value = null;
    selectedLibraryId.value = null;
  }
}
</script>

<template>
  <main class="page knowledge-page">
    <PageHeader v-if="!selectedLibraryId" title="知识库">
      <template #breadcrumb>
        <RouterLink to="/">首页</RouterLink>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">知识库</span>
      </template>
    </PageHeader>

    <section class="page-content" :class="{ 'reader-active': selectedLibraryId && tab === 'browse' }">
      <div v-if="!selectedLibraryId || tab !== 'browse'" class="knowledge-tabs" role="tablist" aria-label="知识库功能">
        <button type="button" role="tab" :aria-selected="tab === 'browse'" :class="{ active: tab === 'browse' }" @click="tab = 'browse'">知识库</button>
        <button type="button" role="tab" :aria-selected="tab === 'chat'" :class="{ active: tab === 'chat' }" @click="tab = 'chat'">AI 问答</button>
        <button type="button" role="tab" :aria-selected="tab === 'manage'" :class="{ active: tab === 'manage' }" @click="tab = 'manage'">我的知识库</button>
      </div>

      <div v-if="tab !== 'manage' && !selectedLibraryId" class="subject-bar">
        <label for="knowledge-subject">学科</label>
        <select
          id="knowledge-subject"
          :value="selectedSubjectId ?? ''"
          :disabled="subjectsLoading || Boolean(subjectsError)"
          @change="selectSubject(($event.target as HTMLSelectElement).value)"
        >
          <option value="">请选择学科</option>
          <option v-for="subject in subjects" :key="subject.id" :value="subject.id">{{ subject.name }}</option>
        </select>
      </div>
      <SkeletonBlock v-if="tab !== 'manage' && !selectedLibraryId && subjectsLoading && !subjectsLoaded" :lines="1" />
      <ErrorState
        v-else-if="tab !== 'manage' && !selectedLibraryId && subjectsError"
        :message="subjectsError"
        @retry="retrySubjects"
      />
      <EmptyState
        v-else-if="tab !== 'manage' && !selectedLibraryId && subjectsLoaded && !subjects.length"
        title="暂无可用学科"
      />

      <template v-if="tab === 'browse'">
        <KnowledgeReader
          v-if="selectedLibraryId"
          :library-id="selectedLibraryId"
          :initial-node-id="initialNodeId"
          :initial-block-id="initialBlockId"
          :initial-view="initialView"
          @back="closeReader"
          @locate="updateLocation"
          @view="updateView"
        />
        <KnowledgeLibraryDirectory
          v-else-if="selectedSubjectId && !subjectsError"
          :subject-id="selectedSubjectId"
          @open="openLibrary"
        />
        <EmptyState v-else-if="subjectsLoaded && subjects.length && !subjectsError" title="请选择学科" />
      </template>

      <template v-else-if="tab === 'chat'">
        <AiChatPanel
          v-if="selectedSubjectId"
          :subject-id="selectedSubjectId"
          :initial-conversation-id="initialConversationId"
          @locate="locateCitation"
          @subject-change="restoreConversationSubject"
          @conversation-change="updateConversation"
        />
        <EmptyState v-else-if="subjectsLoaded && subjects.length && !subjectsError" title="请选择学科" />
      </template>

      <KnowledgeLibraryManager v-else scope="PRIVATE" />
    </section>
  </main>
</template>

<style scoped>
.page-content.reader-active {
  width: min(1440px, 100%);
  padding: 0;
}

.knowledge-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: var(--space-6);
  border-bottom: 1px solid var(--border);
}

.knowledge-tabs button {
  min-height: 42px;
  padding: 0 16px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.knowledge-tabs button.active {
  border-bottom-color: var(--accent);
  color: var(--primary-dark);
  font-weight: 600;
}

.subject-bar {
  display: grid;
  grid-template-columns: auto minmax(220px, 340px);
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}

.subject-bar label {
  color: var(--ink-soft);
  font-weight: 600;
}

.subject-bar select {
  min-height: 42px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface);
}

@media (max-width: 560px) {
  .page-content {
    width: calc(100% - 36px);
  }

  .page-content.reader-active {
    width: 100%;
  }

  .knowledge-tabs {
    overflow-x: auto;
  }

  .knowledge-tabs button {
    flex: 1 0 auto;
  }

  .subject-bar {
    grid-template-columns: 1fr;
  }
}
</style>
