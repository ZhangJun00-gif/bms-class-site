import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetQuizFiltersCache } from '../../composables/useQuizFilters';
import QuizWrong from './QuizWrong.vue';

const filtersPayload = {
  subjects: ['生理学'],
  types: ['SINGLE'],
  subjectGroups: [
    {
      subjectId: 'subject-1',
      subject: '生理学',
      pastPaperCount: 0,
      types: [
        {
          label: '单选题',
          gradingTypes: ['SINGLE'],
          total: 3,
          randomEligibleCount: 3,
          pastPaperCount: 0,
        },
      ],
      chapters: [
        {
          chapterId: 'chapter-1',
          chapter: '循环',
          total: 3,
          randomEligibleCount: 3,
          pastPaperCount: 0,
          types: [],
        },
      ],
      pastPapers: [],
    },
  ],
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function wrong(id: string) {
  return {
    id,
    type: 'SINGLE',
    typeLabel: '单选题',
    subjectId: 'subject-1',
    subject: '生理学',
    chapterIds: ['chapter-1'],
    chapter: '循环',
    chapters: [
      {
        id: 'chapter-1',
        subjectId: 'subject-1',
        name: '循环',
        slug: 'circulation',
        sortOrder: 1,
        active: true,
      },
    ],
    category: 'STANDARD',
    origin: 'MANUAL',
    prompt: '题干示例',
    options: [
      { id: 'a', text: '选项 A' },
      { id: 'b', text: '选项 B' },
    ],
    correctAnswer: ['a'],
    maxScore: 1,
    explanation: '解析示例',
    wrongCount: 3,
    lastWrongAt: '2026-07-20T08:00:00.000Z',
  };
}

function shortWrong(id: string) {
  return {
    ...wrong(id),
    type: 'SHORT_ANSWER',
    typeLabel: '简答题',
    prompt: '说明肺泡通气量的含义',
    options: [],
    correctAnswer: ['每分钟进入肺泡参与气体交换的新鲜气体量'],
    maxScore: 3,
    lastScore: 1,
    lastWrongAnswer: '每分钟进入肺泡的全部气体量',
    lastFeedback: '需要排除无效腔通气量。',
  };
}

describe('QuizWrong pagination', () => {
  afterEach(() => {
    resetQuizFiltersCache();
    vi.restoreAllMocks();
  });

  it('rolls back pagination and hides stale results when a filtered request fails', async () => {
    let wrongRequestCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/quizzes/filters')) return response(filtersPayload);
      wrongRequestCount += 1;
      if (wrongRequestCount === 1) {
        return response({
          items: [wrong('q1')],
          total: 30,
          page: 1,
          pageSize: 20,
        });
      }
      return response({ message: '筛选加载失败' }, 503);
    });
    const wrapper = mount(QuizWrong);
    await flushPromises();

    await wrapper.get('#wrong-subject').setValue('subject-1');
    await flushPromises();

    expect(wrapper.findComponent({ name: 'PaginationControl' }).exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain('筛选加载失败');
    expect(wrapper.text()).not.toContain('题干示例');
    wrapper.unmount();
  });

  it('fetches the new last page before committing when the total shrinks', async () => {
    let wrongRequestCount = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/quizzes/filters')) return response(filtersPayload);
      wrongRequestCount += 1;
      if (wrongRequestCount === 1) {
        return response({ items: [wrong('q1')], total: 30, page: 1, pageSize: 20 });
      }
      if (wrongRequestCount === 2) {
        return response({ items: [], total: 5, page: 2, pageSize: 20 });
      }
      return response({
        items: [{ ...wrong('q-new'), prompt: '纠偏后的题干' }],
        total: 5,
        page: 1,
        pageSize: 20,
      });
    });
    const wrapper = mount(QuizWrong);
    await flushPromises();
    wrapper.findComponent({ name: 'PaginationControl' }).vm.$emit('update:page', 2);
    await flushPromises();

    const wrongUrls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes('/quizzes/wrong'));
    expect(wrongUrls).toHaveLength(3);
    expect(wrongUrls[1]).toContain('page=2');
    expect(wrongUrls[2]).toContain('page=1');
    expect(wrapper.findComponent({ name: 'PaginationControl' }).props('page')).toBe(1);
    expect(wrapper.text()).toContain('纠偏后的题干');
    wrapper.unmount();
  });

  it('keeps the stable page and visible data when the correction request fails', async () => {
    let wrongRequestCount = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/quizzes/filters')) return response(filtersPayload);
      wrongRequestCount += 1;
      if (wrongRequestCount === 1) {
        return response({ items: [wrong('q1')], total: 30, page: 1, pageSize: 20 });
      }
      if (wrongRequestCount === 2) {
        return response({ items: [], total: 5, page: 2, pageSize: 20 });
      }
      if (wrongRequestCount === 3) return response({ message: '纠偏请求失败' }, 503);
      return response({ items: [wrong('q1')], total: 5, page: 1, pageSize: 20 });
    });
    const wrapper = mount(QuizWrong);
    await flushPromises();
    wrapper.findComponent({ name: 'PaginationControl' }).vm.$emit('update:page', 2);
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('纠偏请求失败');
    expect(wrapper.findComponent({ name: 'ErrorState' }).exists()).toBe(false);
    expect(wrapper.text()).toContain('题干示例');
    expect(wrapper.findComponent({ name: 'PaginationControl' }).props('page')).toBe(1);
    await wrapper.get('[role="alert"] button').trigger('click');
    await flushPromises();
    const wrongUrls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes('/quizzes/wrong'));
    expect(wrongUrls).toHaveLength(4);
    expect(wrongUrls.at(-1)).toContain('page=1');
    expect(wrapper.findComponent({ name: 'PaginationControl' }).props('page')).toBe(1);
    wrapper.unmount();
  });

  it('sends subject, chapter, type, source, comprehensive and search filters', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        String(input).includes('/quizzes/filters')
          ? response(filtersPayload)
          : response({ items: [], total: 0, page: 1, pageSize: 20 }),
      );
    const wrapper = mount(QuizWrong);
    await flushPromises();

    await wrapper.find('#wrong-subject').setValue('subject-1');
    await flushPromises();
    await wrapper.find('#wrong-chapters').trigger('click');
    await wrapper
      .findAll('.chapter-select-option')
      .find((option) => option.text().includes('循环'))!
      .trigger('click');
    await flushPromises();
    await wrapper.find('#wrong-type').setValue('单选题');
    await flushPromises();
    await wrapper.find('#wrong-source').setValue('NON_AI');
    await flushPromises();
    await wrapper.find('#wrong-comprehensive').setValue('true');
    await flushPromises();
    await wrapper.find('#wrong-search-input').setValue('题干');
    await wrapper.find('.wrong-filters').trigger('submit');
    await flushPromises();

    const urls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes('/quizzes/wrong'))
      .map((url) => new URL(url, 'http://localhost'));
    const last = urls.at(-1)!;
    expect(last.searchParams.get('subjectId')).toBe('subject-1');
    expect(last.searchParams.get('chapterIds')).toBe('chapter-1');
    expect(last.searchParams.get('chapterMatch')).toBe('ANY');
    expect(last.searchParams.get('typeLabel')).toBe('单选题');
    expect(last.searchParams.get('source')).toBe('NON_AI');
    expect(last.searchParams.get('includeCrossChapter')).toBe('true');
    expect(last.searchParams.get('search')).toBe('题干');
    wrapper.unmount();
  });

  it('shows the latest wrong answer for short-answer questions', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/quizzes/filters')
        ? response(filtersPayload)
        : response({
            items: [shortWrong('short-1')],
            total: 1,
            page: 1,
            pageSize: 20,
          }),
    );
    const wrapper = mount(QuizWrong);
    await flushPromises();

    expect(wrapper.text()).toContain('最近错误答案：');
    expect(wrapper.text()).toContain('每分钟进入肺泡的全部气体量');
    expect(wrapper.text()).toContain('需要排除无效腔通气量');
    wrapper.unmount();
  });
});
