import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { useSseChat } from './useSseChat';

const streamChatMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({
  streamChat: streamChatMock,
  formatError: (_caught: unknown, fallback: string) => fallback,
}));

interface StreamOptions {
  signal: AbortSignal;
}

const scope = () => ref({
  subjectId: 'subject-1',
  knowledgeMode: 'SHARED' as const,
  libraryIds: ['library-1'],
});

describe('useSseChat disposal', () => {
  it('aborts the in-flight stream when the owning component unmounts', async () => {
    let capturedSignal: AbortSignal | undefined;
    streamChatMock.mockImplementation(
      (_request: unknown, options: StreamOptions) => {
        capturedSignal = options.signal;
        return new Promise<void>(() => {});
      },
    );
    const wrapper = mount(
      defineComponent({
        setup() {
          const chat = useSseChat(scope());
          void chat.ask('测试问题');
          return () => h('div');
        },
      }),
    );
    await nextTick();
    expect(capturedSignal?.aborted).toBe(false);

    wrapper.unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('can be created outside a component scope', () => {
    expect(() => useSseChat()).not.toThrow();
  });

  it('delivers the full answer after batched token flushes', async () => {
    streamChatMock.mockImplementation(
      async (
        _request: unknown,
        options: {
          onToken: (token: string) => void;
          onMeta: (meta: { conversationId: string; citations: never[] }) => void;
        },
      ) => {
        options.onMeta({ conversationId: 'conv-1', citations: [] });
        options.onToken('你');
        options.onToken('好');
        options.onToken('吗');
      },
    );
    const chat = useSseChat(scope());
    await chat.ask('打招呼');

    const answer = chat.messages.value.at(-1)!;
    expect(answer.content).toBe('你好吗');
    expect(answer.status).toBe('done');
    expect(chat.conversationId.value).toBe('conv-1');
  });

  it('restores a persisted conversation and continues it without resending scope', async () => {
    streamChatMock.mockImplementationOnce(
      (_request: unknown, options: StreamOptions) =>
        new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const chat = useSseChat(scope());
    const pending = chat.ask('尚未完成的问题');
    await nextTick();
    const restored = [{ role: 'user' as const, content: '历史问题' }];

    chat.restore('conv-history', restored);
    await pending;
    restored[0]!.content = '外部修改';

    expect(chat.messages.value).toEqual([{ role: 'user', content: '历史问题' }]);
    expect(chat.conversationId.value).toBe('conv-history');
    expect(chat.lastQuestion.value).toBe('');

    streamChatMock.mockResolvedValueOnce(undefined);
    await chat.ask('继续追问');
    expect(streamChatMock).toHaveBeenLastCalledWith(
      { question: '继续追问', conversationId: 'conv-history' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
