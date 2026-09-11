import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue';
import { formatError, streamChat } from '../lib/api';
import type {
  ChatMessage,
  KnowledgeChatRequest,
  KnowledgeConversationMode,
} from '../types';

export interface KnowledgeChatScopeSelection {
  subjectId: string;
  knowledgeMode: KnowledgeConversationMode;
  libraryIds: string[];
  libraryChapterIds?: string[];
}

/**
 * AI 问答会话状态机。
 * - 支持流式追加、中止当前回答、失败后重新提问
 * - 中止/失败保留已生成内容，并明确标记状态
 * - 组件卸载时自动中止进行中的流，避免继续写已卸载组件的状态
 */
export function useSseChat(
  scope?: Ref<KnowledgeChatScopeSelection | null | undefined>,
) {
  const messages = ref<ChatMessage[]>([]);
  const busy = ref(false);
  const error = ref('');
  const conversationId = ref<string>();
  const lastQuestion = ref('');
  let controller: AbortController | null = null;
  // 逐 token 渲染开销大：先在缓冲中累积，按时间片合批写入
  let tokenBuffer = '';
  let flushTimer: number | null = null;

  function clearFlushTimer() {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function flushTokens() {
    clearFlushTimer();
    if (!tokenBuffer) return;
    const answer = messages.value.at(-1);
    const buffered = tokenBuffer;
    tokenBuffer = '';
    if (answer) answer.content += buffered;
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = window.setTimeout(flushTokens, 40);
  }

  // 在组件/效果作用域内创建时，随作用域销毁自动中止
  if (getCurrentScope())
    onScopeDispose(() => {
      controller?.abort();
      clearFlushTimer();
    });

  async function send(questionText: string, reusePlaceholder: boolean) {
    const text = questionText.trim();
    if (!text || busy.value) return;
    lastQuestion.value = text;
    error.value = '';

    if (reusePlaceholder && messages.value.at(-1)?.role === 'assistant') {
      const answer = messages.value[messages.value.length - 1]!;
      answer.content = '';
      answer.citations = undefined;
      answer.images = undefined;
      answer.status = 'streaming';
    } else {
      messages.value.push({ role: 'user', content: text });
      messages.value.push({ role: 'assistant', content: '', status: 'streaming' });
    }
    const answer = messages.value[messages.value.length - 1]!;

    busy.value = true;
    controller = new AbortController();
    tokenBuffer = '';
    try {
      const selectedScope = scope?.value;
      if (
        !conversationId.value &&
        (!selectedScope?.subjectId || !selectedScope.libraryIds.length)
      ) {
        throw new Error('请先选择有效的知识范围');
      }
      const request: KnowledgeChatRequest = conversationId.value
        ? { question: text, conversationId: conversationId.value }
        : {
            question: text,
            subjectId: selectedScope!.subjectId,
            knowledgeMode: selectedScope!.knowledgeMode,
            libraryIds: [...selectedScope!.libraryIds],
            ...(selectedScope!.libraryChapterIds?.length
              ? { libraryChapterIds: [...selectedScope!.libraryChapterIds] }
              : {}),
          };
      await streamChat(request, {
        signal: controller.signal,
        onMeta(meta) {
          conversationId.value = meta.conversationId;
          answer.citations = meta.citations;
          answer.images = meta.images;
        },
        onToken(token) {
          tokenBuffer += token;
          scheduleFlush();
        },
      });
      flushTokens();
      if (answer.status === 'streaming') answer.status = 'done';
    } catch (caught) {
      flushTokens();
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        answer.status = 'aborted';
      } else {
        answer.status = 'failed';
        error.value = formatError(caught, '问答失败，请稍后重试');
      }
    } finally {
      busy.value = false;
      controller = null;
    }
  }

  function ask(text: string) {
    return send(text, false);
  }

  /** 用上一次的问题重新提问，复用失败/中止的回答占位 */
  function retry() {
    if (!lastQuestion.value) return Promise.resolve();
    return send(lastQuestion.value, true);
  }

  function abort() {
    controller?.abort();
  }

  function reset() {
    abort();
    messages.value = [];
    conversationId.value = undefined;
    lastQuestion.value = '';
    error.value = '';
  }

  function restore(id: string, restoredMessages: ChatMessage[]) {
    abort();
    clearFlushTimer();
    tokenBuffer = '';
    messages.value = restoredMessages.map((message) => ({ ...message }));
    conversationId.value = id;
    lastQuestion.value = '';
    error.value = '';
  }

  return {
    messages,
    busy,
    error,
    conversationId,
    lastQuestion,
    ask,
    retry,
    abort,
    reset,
    restore,
  };
}
