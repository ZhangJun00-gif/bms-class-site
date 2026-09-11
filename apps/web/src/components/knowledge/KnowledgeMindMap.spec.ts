import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import KnowledgeMindMap from './KnowledgeMindMap.vue';

const markmapMock = vi.hoisted(() => ({
  create: vi.fn(),
  setData: vi.fn().mockResolvedValue(undefined),
  fit: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn(),
  rescale: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('markmap-view', () => ({
  Markmap: { create: markmapMock.create },
}));

const items = [
  {
    nodeId: 'node-h2',
    parentId: null,
    level: 2,
    title: 'Chapter',
    titleMarkdown: 'Chapter',
    sequenceKey: '001',
    previousNodeId: null,
    nextNodeId: 'node-h3',
  },
  {
    nodeId: 'node-h3',
    parentId: 'node-h2',
    level: 3,
    title: 'Section',
    titleMarkdown: 'Section',
    sequenceKey: '002',
    previousNodeId: 'node-h2',
    nextNodeId: 'node-h4',
  },
  {
    nodeId: 'node-h4',
    parentId: 'node-h3',
    level: 4,
    title: 'Topic',
    titleMarkdown: 'Topic',
    sequenceKey: '003',
    previousNodeId: 'node-h3',
    nextNodeId: null,
  },
];

describe('KnowledgeMindMap folding', () => {
  beforeEach(() => {
    markmapMock.create.mockReset();
    markmapMock.setData.mockReset().mockResolvedValue(undefined);
    markmapMock.fit.mockReset().mockResolvedValue(undefined);
    markmapMock.destroy.mockClear();
    markmapMock.rescale.mockReset().mockResolvedValue(undefined);
    markmapMock.create.mockReturnValue({
      setData: markmapMock.setData,
      fit: markmapMock.fit,
      destroy: markmapMock.destroy,
      rescale: markmapMock.rescale,
    });
  });

  it('keeps Markmap from overriding the component folding modes', async () => {
    const wrapper = mount(KnowledgeMindMap, {
      props: {
        libraryName: 'Library root',
        items,
        complete: true,
        progress: 1,
      },
    });
    await flushPromises();

    expect(markmapMock.create).toHaveBeenCalledWith(
      expect.any(SVGElement),
      expect.objectContaining({ initialExpandLevel: -1 }),
    );
    const initialTree = markmapMock.setData.mock.calls.at(-1)![0];
    expect(initialTree.content).toBe('Library root');
    expect(initialTree.payload.fold).toBe(0);
    expect(initialTree.children[0].payload.fold).toBe(1);

    await wrapper.get('button[title="全部展开"]').trigger('click');
    await flushPromises();
    const expandedTree = markmapMock.setData.mock.calls.at(-1)![0];
    expect(expandedTree.payload.fold).toBe(0);
    expect(expandedTree.children[0].payload.fold).toBe(0);
    expect(expandedTree.children[0].children[0].payload.fold).toBe(0);

    await wrapper.get('button[title="收起到章节"]').trigger('click');
    await flushPromises();
    const collapsedTree = markmapMock.setData.mock.calls.at(-1)![0];
    expect(collapsedTree.payload.fold).toBe(0);
    expect(collapsedTree.children[0].payload.fold).toBe(2);

    wrapper.unmount();
    expect(markmapMock.destroy).toHaveBeenCalledTimes(1);
  });

  it('reads direct Markmap datum for labels and node selection', async () => {
    let markmapSvg: SVGElement | undefined;
    markmapMock.create.mockImplementation((element: SVGElement) => {
      markmapSvg = element;
      return {
        setData: markmapMock.setData,
        fit: markmapMock.fit,
        destroy: markmapMock.destroy,
        rescale: markmapMock.rescale,
      };
    });
    markmapMock.setData.mockImplementation(async (root) => {
      if (!markmapSvg) return;
      markmapSvg.replaceChildren();
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.classList.add('markmap-node');
      (group as unknown as { __data__: unknown }).__data__ = root.children[0];
      const foreignObject = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'foreignObject',
      );
      const label = document.createElement('div');
      label.textContent = 'Chapter';
      foreignObject.append(label);
      group.append(foreignObject);
      markmapSvg.append(group);
    });

    const wrapper = mount(KnowledgeMindMap, {
      props: {
        libraryName: 'Library root',
        items,
        complete: true,
        progress: 1,
      },
    });
    await flushPromises();

    const group = wrapper.get<SVGGElement>('g.markmap-node');
    expect(group.attributes('tabindex')).toBe('0');
    expect(group.attributes('aria-label')).toBe('Chapter');

    await group.get('foreignObject div').trigger('click');
    await group.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')).toEqual([['node-h2'], ['node-h2']]);
  });
});
