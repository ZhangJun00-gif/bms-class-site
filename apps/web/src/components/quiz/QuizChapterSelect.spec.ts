import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import QuizChapterSelect from './QuizChapterSelect.vue';

const options = [
  { id: 'chapter-1', label: '第一章', count: 3 },
  { id: 'chapter-2', label: '第二章', count: 2 },
];

describe('QuizChapterSelect', () => {
  it('provides multi-selection in one dropdown without checkbox inputs', async () => {
    const wrapper = mount(QuizChapterSelect, {
      props: {
        id: 'chapters',
        modelValue: [],
        match: 'ANY',
        options,
      },
    });

    await wrapper.get('#chapters').trigger('click');
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    const chapterButtons = wrapper.findAll('.chapter-select-option').slice(1);
    await chapterButtons[0]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([
      ['chapter-1'],
    ]);

    await wrapper.setProps({ modelValue: ['chapter-1', 'chapter-2'] });
    expect(wrapper.get('#chapters').text()).toContain('已选 2 个章节');
    const allMatch = wrapper
      .findAll('.match-options button')
      .find((button) => button.text().includes('全部命中'))!;
    await allMatch.trigger('click');
    expect(wrapper.emitted('update:match')?.at(-1)).toEqual(['ALL']);
  });

  it('returns to ANY matching when fewer than two chapters remain', async () => {
    const wrapper = mount(QuizChapterSelect, {
      props: {
        id: 'chapters',
        modelValue: ['chapter-1', 'chapter-2'],
        match: 'ALL',
        options,
      },
    });
    await wrapper.get('#chapters').trigger('click');
    await wrapper.findAll('.chapter-select-option')[2]!.trigger('click');

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([
      ['chapter-1'],
    ]);
    expect(wrapper.emitted('update:match')?.at(-1)).toEqual(['ANY']);
  });

  it('supports assignment mode without filter matching controls', async () => {
    const wrapper = mount(QuizChapterSelect, {
      props: {
        id: 'assigned-chapters',
        modelValue: ['chapter-1', 'chapter-2'],
        options,
        showMatch: false,
      },
    });

    expect(wrapper.get('#assigned-chapters').text()).toContain('已选 2 个章节');
    expect(wrapper.get('#assigned-chapters').text()).not.toContain('任一命中');
    await wrapper.get('#assigned-chapters').trigger('click');
    expect(wrapper.find('.chapter-match').exists()).toBe(false);
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
  });
});
