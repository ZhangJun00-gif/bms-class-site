import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConversationDetail, AiConversationSummary } from '../../types';
import AiChatPanel from './AiChatPanel.vue';

const originalScrollTo = HTMLElement.prototype.scrollTo;

const mocks = vi.hoisted(() => ({
  reset: vi.fn(),
  abort: vi.fn(),
  restore: vi.fn(),
  confirm: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../composables/useSseChat', async () => {
  const { ref } = await import('vue');
  return {
    useSseChat: () => {
      const messages = ref<unknown[]>([]);
      const conversationId = ref<string>();
      return {
        messages,
        busy: ref(false),
        error: ref(''),
        conversationId,
        ask: vi.fn(),
        retry: vi.fn(),
        abort: () => mocks.abort(),
        reset: () => {
          mocks.reset();
          messages.value = [];
          conversationId.value = undefined;
        },
        restore: (id: string, restoredMessages: unknown[]) => {
          mocks.restore(id, restoredMessages);
          messages.value = restoredMessages;
          conversationId.value = id;
        },
      };
    },
  };
});
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: mocks.confirm }),
}));
vi.mock('../../composables/useToast', () => ({
  useToast: () => ({
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
  }),
}));

const DialogStub = defineComponent({
  props: ['open', 'title'],
  emits: ['close'],
  template: '<section v-if="open" class="dialog-stub"><h2>{{ title }}</h2><slot /></section>',
});

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function summary(id = 'conv-1'): AiConversationSummary {
  return {
    id,
    title: '心动周期复习',
    subjectId: 'subject-1',
    subject: { id: 'subject-1', name: '生理学' },
    knowledgeMode: 'SHARED',
    libraries: [{ id: 'library-1', name: '生理学教材', scope: 'SHARED' }],
    messageCount: 2,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
}

function detail(id = 'conv-1', subjectId = 'subject-1'): AiConversationDetail {
  return {
    ...summary(id),
    subjectId,
    subject: { id: subjectId, name: subjectId === 'subject-1' ? '生理学' : '病理学' },
    libraryChapters: [],
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: '什么是心动周期？',
        citations: null,
        attachments: null,
        model: null,
        createdAt: '2026-08-10T00:00:00.000Z',
      },
      {
        id: 'message-2',
        role: 'assistant',
        content: '心动周期是一次心搏的完整过程。',
        citations: [],
        attachments: [],
        model: 'deepseek-v4-flash',
        createdAt: '2026-08-10T00:00:01.000Z',
      },
    ],
    hasEarlierMessages: false,
  };
}

function installFetch(options: {
  detail?: AiConversationDetail;
  history?: AiConversationSummary[];
} = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/knowledge/libraries')) {
      return response({ items: [], total: 0, page: 1, pageSize: 12 });
    }
    if (url.pathname.endsWith('/ai/conversations') && !init?.method) {
      return response({ items: options.history ?? [], nextCursor: null });
    }
    if (url.pathname.includes('/ai/conversations/') && init?.method === 'DELETE') {
      return response({ id: url.pathname.split('/').at(-1), deleted: true });
    }
    if (url.pathname.includes('/ai/conversations/') && options.detail) {
      return response(options.detail);
    }
    return response({ message: `未模拟请求 ${url.pathname}` }, 500);
  });
}

function mountPanel(props: { subjectId: string; initialConversationId?: string }) {
  return mount(AiChatPanel, {
    props,
    global: { stubs: { BaseDialog: DialogStub } },
  });
}

describe('AiChatPanel conversation lifecycle', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.confirm.mockResolvedValue(true);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    if (originalScrollTo) {
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        value: originalScrollTo,
      });
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    }
    vi.restoreAllMocks();
  });

  it('resets the conversation state whenever the shared subject changes', async () => {
    installFetch();
    const wrapper = mountPanel({ subjectId: 'subject-1' });
    await flushPromises();
    expect(mocks.reset).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ subjectId: 'subject-2' });
    await flushPromises();
    expect(mocks.reset).toHaveBeenCalledTimes(2);
  });

  it('restores an initial URL conversation and emits its persisted id', async () => {
    installFetch({ detail: detail() });
    const wrapper = mountPanel({
      subjectId: 'subject-1',
      initialConversationId: 'conv-1',
    });
    await flushPromises();

    expect(mocks.restore).toHaveBeenCalledWith('conv-1', [
      { role: 'user', content: '什么是心动周期？' },
      {
        role: 'assistant',
        content: '心动周期是一次心搏的完整过程。',
        status: 'done',
      },
    ]);
    expect(wrapper.emitted('conversationChange')?.at(-1)).toEqual(['conv-1']);
    expect(wrapper.text()).toContain('生理学教材');
  });

  it('requests a subject switch before restoring a cross-subject conversation', async () => {
    installFetch({ detail: detail('conv-2', 'subject-2') });
    const wrapper = mountPanel({
      subjectId: 'subject-1',
      initialConversationId: 'conv-2',
    });
    await flushPromises();

    expect(wrapper.emitted('subjectChange')?.at(-1)).toEqual(['subject-2']);
    expect(mocks.restore).not.toHaveBeenCalled();

    await wrapper.setProps({ subjectId: 'subject-2' });
    await flushPromises();
    expect(mocks.restore).toHaveBeenCalledWith('conv-2', expect.any(Array));
  });

  it('lists and explicitly deletes the current user conversation', async () => {
    const fetchMock = installFetch({ history: [summary()] });
    const wrapper = mountPanel({ subjectId: 'subject-1' });
    await flushPromises();

    await wrapper.findAll('button').find((button) => button.text().includes('会话历史'))!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('心动周期复习');

    await wrapper.get('button[aria-label="删除会话心动周期复习"]').trigger('click');
    await flushPromises();

    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/ai/conversations/conv-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(wrapper.find('.history-main').exists()).toBe(false);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('AI 会话已删除');
  });
});
