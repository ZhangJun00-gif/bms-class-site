import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDocument } from '../../types';
import KnowledgeDocuments from './KnowledgeDocuments.vue';

const subject = {
  id: 'subject-1',
  name: '生理学',
  slug: 'physiology',
  sortOrder: 1,
  active: true,
};

function document(id: string, title: string): KnowledgeDocument {
  return {
    id,
    title,
    kind: 'ARTICLE',
    indexStatus: 'READY',
    sourceName: null,
    mimeType: null,
    fileSize: 100,
    subject,
    publishedAt: '2026-07-21T00:00:00.000Z',
  };
}

function detail(id: string, title: string) {
  return { ...document(id, title), body: `<p>${title}正文</p>` };
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('KnowledgeDocuments detail loading', () => {
  afterEach(() => vi.restoreAllMocks());

  it('ignores a late detail response for a previously selected document', async () => {
    let resolveA!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/knowledge/a'))
        return new Promise<Response>((resolve) => (resolveA = resolve));
      if (url.endsWith('/knowledge/b')) return response(detail('b', '文档B'));
      return response({ message: 'not found' }, 404);
    });
    const wrapper = mount(KnowledgeDocuments, {
      props: {
        documents: [document('a', '文档A'), document('b', '文档B')],
        selectedId: null,
      },
    });

    await wrapper.setProps({ selectedId: 'a' });
    await wrapper.setProps({ selectedId: 'b' });
    await flushPromises();
    expect(wrapper.get('.reader-title').text()).toBe('文档B');

    resolveA(response(detail('a', '文档A')));
    await flushPromises();
    expect(wrapper.get('.reader-title').text()).toBe('文档B');
    wrapper.unmount();
  });

  it('drops the in-flight response when the selection is cleared', async () => {
    let resolveA!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Promise<Response>((resolve) => (resolveA = resolve)),
    );
    const wrapper = mount(KnowledgeDocuments, {
      props: { documents: [document('a', '文档A')], selectedId: null },
    });

    await wrapper.setProps({ selectedId: 'a' });
    await wrapper.setProps({ selectedId: null });
    resolveA(response(detail('a', '文档A')));
    await flushPromises();

    expect(wrapper.find('.reader').exists()).toBe(false);
    expect(wrapper.text()).toContain('选择左侧资料开始阅读');
    wrapper.unmount();
  });
});
