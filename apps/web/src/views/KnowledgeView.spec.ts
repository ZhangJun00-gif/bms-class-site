import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import KnowledgeView from './KnowledgeView.vue';

const subjects = [
  {
    id: 'subject-1',
    name: '组织学',
    slug: 'histology',
    sortOrder: 1,
    active: true,
  },
  {
    id: 'subject-2',
    name: '生理学',
    slug: 'physiology',
    sortOrder: 2,
    active: true,
  },
];

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const DirectoryStub = defineComponent({
  name: 'KnowledgeLibraryDirectory',
  props: ['subjectId'],
  emits: ['open'],
  template:
    '<button class="directory-stub" @click="$emit(\'open\', { id: \'library-1\', subjectId, name: \'组织学库\' })">{{ subjectId }}</button>',
});

const ReaderStub = defineComponent({
  name: 'KnowledgeReader',
  props: [
    'libraryId',
    'initialNodeId',
    'initialBlockId',
    'initialView',
  ],
  emits: ['back', 'locate', 'view'],
  template:
    '<div class="reader-stub">{{ libraryId }}|{{ initialNodeId }}|{{ initialBlockId }}|{{ initialView }}</div>',
});

const ChatStub = defineComponent({
  name: 'AiChatPanel',
  props: ['subjectId', 'initialConversationId'],
  emits: ['subjectChange', 'conversationChange'],
  template: `
    <div class="chat-stub">
      {{ subjectId }}|{{ initialConversationId }}
      <button class="restore-subject" @click="$emit('subjectChange', 'subject-2')">恢复跨学科会话</button>
      <button class="change-conversation" @click="$emit('conversationChange', 'conv-2')">切换会话</button>
    </div>
  `,
});

async function mountView(path = '/knowledge') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/knowledge', component: KnowledgeView }],
  });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(KnowledgeView, {
    global: {
      plugins: [router],
      stubs: {
        RouterLink: true,
        PageHeader: { template: '<header><slot name="breadcrumb" /></header>' },
        KnowledgeLibraryDirectory: DirectoryStub,
        KnowledgeReader: ReaderStub,
        AiChatPanel: ChatStub,
        KnowledgeLibraryManager: { template: '<div class="manager-stub" />' },
      },
    },
  });
  await flushPromises();
  return { wrapper, router };
}

describe('KnowledgeView library reader flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('requires an explicit subject and never offers an all-subject reader', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(subjects));
    const { wrapper } = await mountView();

    expect(wrapper.get('#knowledge-subject').text()).not.toContain('全部学科');
    expect(wrapper.find('.directory-stub').exists()).toBe(false);
    expect(wrapper.text()).toContain('请选择学科');

    await wrapper.get('#knowledge-subject').setValue('subject-1');
    await flushPromises();
    expect(wrapper.get('.directory-stub').text()).toBe('subject-1');
    wrapper.unmount();
  });

  it('opens one library as one continuous reader instead of a document switcher', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(subjects));
    const { wrapper, router } = await mountView();
    await wrapper.get('#knowledge-subject').setValue('subject-1');
    await flushPromises();
    await wrapper.get('.directory-stub').trigger('click');
    await flushPromises();

    expect(wrapper.get('.reader-stub').text()).toContain('library-1');
    expect(router.currentRoute.value.query).toMatchObject({
      subjectId: 'subject-1',
      libraryId: 'library-1',
      view: 'read',
    });
    expect(wrapper.find('.documents-stub').exists()).toBe(false);
    wrapper.unmount();
  });

  it('passes only stable reader deep-link identifiers to the reader', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(subjects));
    const { wrapper } = await mountView(
      '/knowledge?subjectId=subject-1&libraryId=library-1&view=mindmap&nodeId=node-1&blockId=block-1',
    );

    expect(wrapper.get('.reader-stub').text()).toBe(
      'library-1|node-1|block-1|MINDMAP',
    );
    expect(wrapper.html()).not.toContain('documentId');
    wrapper.unmount();
  });

  it('writes reader view and target identifiers in one location update', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(subjects));
    const { wrapper, router } = await mountView(
      '/knowledge?subjectId=subject-1&libraryId=library-1&view=mindmap&nodeId=node-1&blockId=block-1',
    );

    wrapper.findComponent(ReaderStub).vm.$emit('locate', { nodeId: 'node-2' });
    await flushPromises();

    expect(router.currentRoute.value.query).toMatchObject({
      subjectId: 'subject-1',
      libraryId: 'library-1',
      view: 'read',
      nodeId: 'node-2',
    });
    expect(router.currentRoute.value.query).not.toHaveProperty('blockId');
    wrapper.unmount();
  });

  it('opens a URL conversation in chat and preserves it during history-driven subject restore', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(subjects));
    const { wrapper, router } = await mountView(
      '/knowledge?subjectId=subject-1&conversation=conv-1',
    );

    expect(wrapper.get('.chat-stub').text()).toContain('subject-1|conv-1');
    await wrapper.get('.restore-subject').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.query).toMatchObject({
      subjectId: 'subject-2',
      conversation: 'conv-1',
    });
    await wrapper.get('.change-conversation').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.conversation).toBe('conv-2');
    wrapper.unmount();
  });

  it('clears the old conversation when the user manually changes subject', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(subjects));
    const { wrapper, router } = await mountView(
      '/knowledge?subjectId=subject-1&conversation=conv-1',
    );

    await wrapper.get('#knowledge-subject').setValue('subject-2');
    await flushPromises();

    expect(router.currentRoute.value.query.subjectId).toBe('subject-2');
    expect(router.currentRoute.value.query).not.toHaveProperty('conversation');
    wrapper.unmount();
  });
});
