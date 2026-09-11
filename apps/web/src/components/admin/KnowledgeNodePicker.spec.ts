import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { AiQuestionGenerationNode } from '../../types';
import KnowledgeNodePicker from './KnowledgeNodePicker.vue';

const nodes: AiQuestionGenerationNode[] = [
  {
    id: 'parent',
    parentId: null,
    hasChildren: true,
    leafNodeCount: 2,
    leafNodeIds: ['leaf-a', 'leaf-b'],
    level: 2,
    title: '循环调节',
    titleMarkdown: '循环调节',
    path: '循环调节',
    breadcrumb: '循环调节',
    sortOrder: 1,
    libraryChapterId: 'library-chapter-1',
    documentId: 'document-1',
    documentVersionId: 'version-1',
    chunkCount: 1,
    tokenCount: 20,
  },
  {
    id: 'leaf-a',
    parentId: 'parent',
    hasChildren: false,
    leafNodeCount: 1,
    leafNodeIds: ['leaf-a'],
    level: 3,
    title: '压力感受性反射',
    titleMarkdown: '压力感受性反射',
    path: '循环调节 > 压力感受性反射',
    breadcrumb: '循环调节 / 压力感受性反射',
    sortOrder: 2,
    libraryChapterId: 'library-chapter-1',
    documentId: 'document-1',
    documentVersionId: 'version-1',
    chunkCount: 1,
    tokenCount: 100,
  },
  {
    id: 'leaf-b',
    parentId: 'parent',
    hasChildren: false,
    leafNodeCount: 1,
    leafNodeIds: ['leaf-b'],
    level: 3,
    title: '化学感受性反射',
    titleMarkdown: '化学感受性反射',
    path: '循环调节 > 化学感受性反射',
    breadcrumb: '循环调节 / 化学感受性反射',
    sortOrder: 3,
    libraryChapterId: 'library-chapter-1',
    documentId: 'document-1',
    documentVersionId: 'version-1',
    chunkCount: 1,
    tokenCount: 120,
  },
];

describe('KnowledgeNodePicker', () => {
  it('selects descendant leaves instead of the parent heading', async () => {
    const wrapper = mount(KnowledgeNodePicker, {
      props: { nodes, modelValue: [] },
    });

    await wrapper.get('.node-row input[type="checkbox"]').setValue(true);

    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([
      'leaf-a',
      'leaf-b',
    ]);
    expect(wrapper.text()).toContain('全选其下 2 条末级证据');
  });

  it('shows a partially selected parent and keeps its expand control', async () => {
    const wrapper = mount(KnowledgeNodePicker, {
      props: { nodes, modelValue: ['leaf-a'] },
    });
    const parentCheckbox = wrapper.get<HTMLInputElement>(
      '.node-row input[type="checkbox"]',
    );

    expect(parentCheckbox.element.indeterminate).toBe(true);
    expect(wrapper.get('.node-row').attributes('aria-checked')).toBe('mixed');

    await wrapper.get('.node-expand').trigger('click');
    expect(wrapper.findAll('.node-row')).toHaveLength(1);
    expect(wrapper.find('.node-expand').exists()).toBe(true);
  });

  it('disables a parent whose descendant leaves exceed the task limit', () => {
    const wrapper = mount(KnowledgeNodePicker, {
      props: {
        nodes: [
          {
            ...nodes[0]!,
            leafNodeCount: 21,
            leafNodeIds: [],
          },
        ],
        modelValue: [],
      },
    });

    expect(
      wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.disabled,
    ).toBe(true);
    expect(wrapper.text()).toContain('超过单任务上限');
  });
});
