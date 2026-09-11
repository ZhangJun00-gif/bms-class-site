<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  EyeOff,
  Flag,
  Lock,
  LockOpen,
  Pencil,
  Pin,
  PinOff,
  Send,
  Trash2,
} from 'lucide-vue-next';
import BaseDialog from '../common/BaseDialog.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import ThreadComposerDialog from './ThreadComposerDialog.vue';
import ReportDialog, { type ReportTarget } from './ReportDialog.vue';
import { api, formatError } from '../../lib/api';
import { formatDateTime } from '../../lib/formatters';
import { useAuthStore } from '../../stores/auth';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import type { ForumPost, ForumThread } from '../../types';

const props = defineProps<{ threadId: string }>();
const emit = defineEmits<{ deleted: []; changed: [] }>();

const auth = useAuthStore();
const toast = useToast();
const { confirm } = useConfirm();

const thread = ref<ForumThread | null>(null);
const loading = ref(true);
const error = ref('');
const reply = ref('');
const sending = ref(false);
const replyError = ref('');
const editing = ref(false);
const reportTarget = ref<ReportTarget | null>(null);
const editingPostId = ref('');
const editingPostBody = ref('');
const postBusy = ref(false);
const moderationBusy = ref(false);

const isAuthor = computed(() =>
  Boolean(thread.value && auth.user && thread.value.authorId === auth.user.id),
);
const canManageThread = computed(() => isAuthor.value || auth.canEdit);

watch(
  () => props.threadId,
  (id) => {
    void loadThread(id);
  },
  { immediate: true },
);

/** 初始加载/失败重试：完整管理 loading 与 error 状态 */
async function loadThread(id: string) {
  loading.value = true;
  error.value = '';
  reply.value = '';
  replyError.value = '';
  editingPostId.value = '';
  try {
    thread.value = await api<ForumThread>(`/forum/threads/${id}`);
  } catch (caught) {
    thread.value = null;
    error.value = formatError(caught, '主题加载失败');
  } finally {
    loading.value = false;
  }
}

function retryLoad() {
  void loadThread(props.threadId);
}

/**
 * 写操作成功后的静默刷新：刷新失败不代表写入失败，
 * 不得向上抛错让调用方误报"发送失败"导致用户重复提交。
 */
async function refreshDetail() {
  try {
    thread.value = await api<ForumThread>(`/forum/threads/${props.threadId}`);
    emit('changed');
  } catch {
    toast.error('内容已保存，但刷新失败，请稍后手动刷新');
  }
}

async function sendReply() {
  const text = reply.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  replyError.value = '';
  try {
    await api(`/forum/threads/${props.threadId}/posts`, {
      method: 'POST',
      body: JSON.stringify({ body: text }),
    });
    reply.value = '';
    await refreshDetail();
  } catch (caught) {
    // 失败时保留输入内容
    replyError.value = formatError(caught, '回复发送失败，请稍后重试');
  } finally {
    sending.value = false;
  }
}

async function deleteThread() {
  const ok = await confirm({
    title: '删除主题',
    body: '删除后主题与回复将不再显示。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/forum/threads/${props.threadId}`, { method: 'DELETE' });
    toast.success('主题已删除');
    emit('deleted');
  } catch (caught) {
    toast.error(formatError(caught, '删除失败'));
  }
}

async function toggleModeration(field: 'pinned' | 'locked', value: boolean) {
  moderationBusy.value = true;
  try {
    await api(`/forum/threads/${props.threadId}/moderation`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    });
    await refreshDetail();
  } catch (caught) {
    toast.error(formatError(caught, '操作失败'));
  } finally {
    moderationBusy.value = false;
  }
}

async function hideThread() {
  const ok = await confirm({
    title: '隐藏主题',
    body: '隐藏后主题与回复将从论坛列表消失，但不会被删除。',
    confirmText: '隐藏主题',
    danger: true,
  });
  if (!ok) return;
  moderationBusy.value = true;
  try {
    await api(`/forum/threads/${props.threadId}/moderation`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden: true }),
    });
    toast.success('主题已隐藏');
    emit('deleted');
  } catch (caught) {
    toast.error(formatError(caught, '隐藏失败'));
  } finally {
    moderationBusy.value = false;
  }
}

function startEditPost(post: ForumPost) {
  editingPostId.value = post.id;
  editingPostBody.value = post.body;
}

async function savePost() {
  if (!editingPostId.value || postBusy.value) return;
  postBusy.value = true;
  try {
    await api(`/forum/posts/${editingPostId.value}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: editingPostBody.value }),
    });
    editingPostId.value = '';
    await refreshDetail();
    toast.success('回复已更新');
  } catch (caught) {
    toast.error(formatError(caught, '保存失败'));
  } finally {
    postBusy.value = false;
  }
}

async function deletePost(post: ForumPost) {
  const ok = await confirm({
    title: '删除回复',
    body: '删除后该回复不再显示。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/forum/posts/${post.id}`, { method: 'DELETE' });
    await refreshDetail();
    toast.success('回复已删除');
  } catch (caught) {
    toast.error(formatError(caught, '删除失败'));
  }
}
</script>

<template>
  <SkeletonBlock v-if="loading" :lines="5" />
  <ErrorState
    v-else-if="error"
    :message="error"
    retry-label="重新加载"
    @retry="retryLoad"
  />
  <article v-else-if="thread" class="thread-detail">
    <header class="thread-head">
      <div class="thread-badges">
        <StatusBadge v-if="thread.pinned" text="置顶" tone="accent" />
        <StatusBadge v-if="thread.locked" text="已锁定" tone="muted" />
      </div>
      <h2 class="thread-heading">{{ thread.title }}</h2>
      <div class="meta">
        <span>{{ thread.author.displayName }}</span>
        <time>{{ formatDateTime(thread.createdAt) }}</time>
      </div>
      <div class="thread-actions">
        <button
          v-if="canManageThread"
          type="button"
          class="action-link"
          @click="editing = true"
        >
          <Pencil :size="14" aria-hidden="true" />编辑
        </button>
        <button
          v-if="canManageThread"
          type="button"
          class="action-link danger"
          @click="deleteThread"
        >
          <Trash2 :size="14" aria-hidden="true" />删除
        </button>
        <button
          v-if="!isAuthor && !auth.canEdit"
          type="button"
          class="action-link"
          @click="
            reportTarget = {
              kind: 'thread',
              id: thread.id,
              label: thread.title,
            }
          "
        >
          <Flag :size="14" aria-hidden="true" />举报
        </button>
        <template v-if="auth.canEdit">
          <button
            type="button"
            class="action-link"
            :disabled="moderationBusy"
            @click="toggleModeration('pinned', !thread.pinned)"
          >
            <PinOff v-if="thread.pinned" :size="14" aria-hidden="true" />
            <Pin v-else :size="14" aria-hidden="true" />
            {{ thread.pinned ? '取消置顶' : '置顶' }}
          </button>
          <button
            type="button"
            class="action-link"
            :disabled="moderationBusy"
            @click="toggleModeration('locked', !thread.locked)"
          >
            <LockOpen v-if="thread.locked" :size="14" aria-hidden="true" />
            <Lock v-else :size="14" aria-hidden="true" />
            {{ thread.locked ? '解锁' : '锁定' }}
          </button>
          <button
            type="button"
            class="action-link danger"
            :disabled="moderationBusy"
            @click="hideThread"
          >
            <EyeOff :size="14" aria-hidden="true" />隐藏
          </button>
        </template>
      </div>
    </header>

    <!-- 主题与回复正文均由后端 sanitize-html 清洗 -->
    <div class="rich-text" v-html="thread.body" />

    <section class="replies" aria-label="回复列表">
      <h3 class="replies-title">回复（{{ thread.posts?.length ?? 0 }}）</h3>
      <p v-if="!thread.posts?.length" class="text-muted replies-empty">
        还没有回复。
      </p>
      <div v-for="post in thread.posts" :key="post.id" class="reply">
        <div class="meta">
          <span>{{ post.author.displayName }}</span>
          <time>{{ formatDateTime(post.createdAt) }}</time>
          <template
            v-if="auth.user && (post.authorId === auth.user.id || auth.canEdit)"
          >
            <button
              type="button"
              class="action-link"
              @click="startEditPost(post)"
            >
              <Pencil :size="13" aria-hidden="true" />编辑
            </button>
            <button
              type="button"
              class="action-link danger"
              @click="deletePost(post)"
            >
              <Trash2 :size="13" aria-hidden="true" />删除
            </button>
          </template>
          <button
            v-else-if="!auth.canEdit"
            type="button"
            class="action-link"
            @click="
              reportTarget = {
                kind: 'post',
                id: post.id,
                label: `${post.author.displayName} 的回复`,
              }
            "
          >
            <Flag :size="13" aria-hidden="true" />举报
          </button>
        </div>
        <form
          v-if="editingPostId === post.id"
          class="form reply-edit"
          @submit.prevent="savePost"
        >
          <div class="field">
            <label :for="`edit-post-${post.id}`" class="sr-only"
              >编辑回复</label
            >
            <textarea
              :id="`edit-post-${post.id}`"
              v-model="editingPostBody"
              required
            ></textarea>
          </div>
          <div class="reply-edit-actions">
            <button
              type="button"
              class="button ghost"
              :disabled="postBusy"
              @click="editingPostId = ''"
            >
              取消
            </button>
            <button type="submit" class="button" :disabled="postBusy">
              {{ postBusy ? '保存中…' : '保存' }}
            </button>
          </div>
        </form>
        <div v-else class="rich-text" v-html="post.body" />
      </div>
    </section>

    <p v-if="thread.locked" class="alert info">
      主题已锁定，无法继续回复。如有需要可联系编辑或管理员。
    </p>
    <form v-else class="reply-form" @submit.prevent="sendReply">
      <p v-if="replyError" class="alert error" role="alert">{{ replyError }}</p>
      <div class="field">
        <label for="reply-body">回复主题</label>
        <textarea
          id="reply-body"
          v-model="reply"
          required
          placeholder="友善交流，围绕主题"
        ></textarea>
      </div>
      <button class="button" type="submit" :disabled="sending">
        <Send :size="16" aria-hidden="true" />
        {{ sending ? '发送中…' : '发送回复' }}
      </button>
    </form>

    <ThreadComposerDialog
      :open="editing"
      :initial="thread"
      @close="editing = false"
      @saved="refreshDetail"
    />
    <ReportDialog
      :open="Boolean(reportTarget)"
      :target="reportTarget"
      @close="reportTarget = null"
    />
  </article>
</template>

<style scoped>
.thread-detail {
  display: grid;
  gap: var(--space-5);
}

.thread-head {
  display: grid;
  gap: var(--space-2);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.thread-badges {
  display: flex;
  gap: var(--space-2);
}

.thread-heading {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.thread-actions {
  display: flex;
  gap: var(--space-4);
  flex-wrap: wrap;
  margin-top: var(--space-1);
}

.action-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border: 0;
  background: none;
  padding: 0;
  color: var(--accent-dark);
  font-size: 13px;
  cursor: pointer;
}

.action-link:hover {
  text-decoration: underline;
}

.action-link:disabled {
  color: var(--muted);
  cursor: wait;
  text-decoration: none;
}

.action-link.danger {
  color: var(--danger);
}

.replies {
  display: grid;
}

.replies-title {
  margin: 0 0 var(--space-2);
  font-size: 16px;
}

.replies-empty {
  margin: 0;
  font-size: 14px;
}

.reply {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-4) 0;
  border-top: 1px solid var(--border);
}

.reply-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}

.reply-form {
  display: grid;
  gap: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
}
</style>
