import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuizRunner from "./QuizRunner.vue";
import type { QuizQuestion } from "../../types";

const leaveGuard = vi.hoisted(
  () => ({ current: null }) as { current: null | (() => Promise<boolean>) },
);

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>();
  return {
    ...actual,
    onBeforeRouteLeave: (guard: () => Promise<boolean>) => {
      leaveGuard.current = guard;
    },
    onBeforeRouteUpdate: (guard: () => Promise<boolean>) => {
      leaveGuard.current = guard;
    },
  };
});

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function lifecycle(
  status:
    | 'DRAFT'
    | 'SCORING'
    | 'SCORING_FAILED'
    | 'SUBMITTED'
    | 'ABANDONED',
  overrides: Record<string, unknown> = {},
) {
  return {
    attemptId: 'a1',
    status,
    revision: 2,
    position: 0,
    answers: { q1: ['A'] },
    questions: [makeQuestion()],
    savedAt: '2026-08-10T02:00:00.000Z',
    expiresAt: '2026-08-17T02:00:00.000Z',
    score: null,
    total: 1,
    results: null,
    gradingError: null,
    ...overrides,
  };
}

function makeQuestion(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: "q1",
    type: "SINGLE",
    gradingType: "SINGLE",
    typeLabel: "单选题",
    subjectId: "subject-1",
    subject: "生理学",
    chapterIds: ["chapter-1"],
    chapter: "第一章",
    chapters: [
      {
        id: "chapter-1",
        subjectId: "subject-1",
        name: "第一章",
        slug: "chapter-1",
        sortOrder: 1,
        active: true,
      },
    ],
    category: "STANDARD",
    origin: "MANUAL",
    prompt: "题干内容",
    options: [
      { id: "A", text: "选项甲" },
      { id: "B", text: "选项乙" },
    ],
    images: [],
    isPastPaper: false,
    pastPaper: null,
    paperOrder: null,
    maxScore: 1,
    ...overrides,
  };
}

describe("QuizRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    leaveGuard.current = null;
  });

  it("shows the custom type label instead of the grading type", () => {
    const wrapper = mount(QuizRunner, {
      props: {
        attemptId: "a1",
        questions: [
          makeQuestion({ typeLabel: "病例分析题", gradingType: "SHORT_ANSWER" }),
        ],
      },
    });
    expect(wrapper.text()).toContain("病例分析题");
    expect(wrapper.find(".short-answer-field textarea").exists()).toBe(true);
  });

  it("uses gradingType to choose checkbox inputs for MULTIPLE questions", () => {
    const wrapper = mount(QuizRunner, {
      props: {
        attemptId: "a1",
        questions: [
          makeQuestion({
            gradingType: "MULTIPLE",
            type: "MULTIPLE",
            typeLabel: "不定项选择题",
          }),
        ],
      },
    });
    const inputs = wrapper.findAll(".option input");
    expect(inputs.every((input) => input.attributes("type") === "checkbox")).toBe(
      true,
    );
  });

  it("keeps the quiz finish label by default and supports a daily-practice label", async () => {
    const wrapper = mount(QuizRunner, {
      props: {
        attemptId: "a1",
        questions: [makeQuestion()],
        finishLabel: "返回今日练习",
      },
    });
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes('/draft')
        ? jsonResponse({
            attemptId: 'a1',
            revision: 1,
            position: 0,
            savedAt: '2026-08-10T03:00:00.000Z',
            expiresAt: '2026-08-17T03:00:00.000Z',
          })
        : jsonResponse({
          attemptId: 'a1',
          status: 'SUBMITTED',
          pending: false,
          score: 1,
          total: 1,
          results: [
            {
              questionId: "q1",
              correct: true,
              score: 1,
              maxScore: 1,
              correctAnswer: ["A"],
              explanation: "解析",
            },
          ],
          submittedAt: '2026-08-10T03:00:01.000Z',
        }),
    );

    await wrapper.find('.option input').setValue(true);
    await wrapper.findAll('.quiz-controls button')[1]!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('返回今日练习');
    expect(wrapper.emitted('submitted')?.[0]?.[0]).toMatchObject({ score: 1, total: 1 });
  });

  it('debounces draft saves and surfaces a revision conflict without overwriting answers', async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse(
        { message: '草稿版本或状态已变化，请重新载入后继续' },
        409,
      );
    });
    const wrapper = mount(QuizRunner, {
      props: {
        attemptId: 'a1',
        questions: [makeQuestion()],
        initialState: lifecycle('DRAFT', { revision: 3, answers: {} }),
      },
    });

    await wrapper.find('.option input').setValue(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/quizzes/attempts/a1/draft');
    expect(calls[0]!.body).toMatchObject({
      revision: 3,
      position: 0,
      answers: { q1: ['A'] },
    });
    expect(wrapper.get('.draft-save-status').text()).toContain('草稿冲突');
    expect(wrapper.find('.option input').element).toMatchObject({ checked: true });
    wrapper.unmount();
  });

  it('flushes a dirty draft before allowing an internal route leave', async () => {
    vi.useFakeTimers();
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({
        attemptId: 'a1',
        revision: 1,
        position: 0,
        savedAt: '2026-08-10T03:00:00.000Z',
        expiresAt: '2026-08-17T03:00:00.000Z',
      });
    });
    const wrapper = mount(QuizRunner, {
      props: { attemptId: 'a1', questions: [makeQuestion()] },
    });
    await wrapper.find('.option input').setValue(true);

    expect(leaveGuard.current).toBeTruthy();
    await expect(leaveGuard.current!()).resolves.toBe(true);
    expect(requests).toEqual([
      { revision: 0, position: 0, answers: { q1: ['A'] } },
    ]);
    expect(wrapper.get('.draft-save-status').text()).toContain('已保存');
    wrapper.unmount();
  });

  it('aborts an in-flight draft save on unmount and never schedules a follow-up save', async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    let requestCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestCount += 1;
      signal = init?.signal ?? undefined;
      return pending.promise;
    });
    const wrapper = mount(QuizRunner, {
      props: { attemptId: 'a1', questions: [makeQuestion()] },
    });

    await wrapper.findAll('.option input')[0]!.setValue(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(requestCount).toBe(1);
    await wrapper.findAll('.option input')[1]!.setValue(true);
    wrapper.unmount();

    expect(signal?.aborted).toBe(true);
    pending.resolve(jsonResponse({
      attemptId: 'a1',
      revision: 1,
      position: 0,
      savedAt: '2026-08-10T03:00:00.000Z',
      expiresAt: '2026-08-17T03:00:00.000Z',
    }));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestCount).toBe(1);
  });

  it('aborts an in-flight submit on unmount and ignores its late completion', async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return pending.promise;
    });
    const wrapper = mount(QuizRunner, {
      props: {
        attemptId: 'a1',
        questions: [makeQuestion()],
        initialState: lifecycle('DRAFT'),
      },
    });
    await wrapper
      .findAll('.quiz-controls button')
      .find((button) => button.text().includes('提交答案'))!
      .trigger('click');
    await flushPromises();
    wrapper.unmount();

    expect(signal?.aborted).toBe(true);
    pending.resolve(jsonResponse({
      attemptId: 'a1',
      status: 'SUBMITTED',
      pending: false,
      score: 1,
      total: 1,
      results: [],
      submittedAt: '2026-08-10T03:00:00.000Z',
    }));
    await flushPromises();
    expect(scroll).not.toHaveBeenCalled();
    expect(wrapper.emitted('submitted')).toBeUndefined();
  });

  it('does not overlap scoring polls and renders the completed result', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (response: Response) => void;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let requestCount = 0;
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      requestCount += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      if (requestCount === 1) {
        const response = await new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
        activeRequests -= 1;
        return response;
      }
      activeRequests -= 1;
      return jsonResponse(
        lifecycle('SUBMITTED', {
          score: 1,
          results: [
            {
              questionId: 'q1',
              correct: true,
              score: 1,
              maxScore: 1,
              correctAnswer: ['A'],
              explanation: '解析',
            },
          ],
        }),
      );
    });
    const wrapper = mount(QuizRunner, {
      props: {
        attemptId: 'a1',
        questions: [makeQuestion()],
        initialState: lifecycle('SCORING'),
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(requestCount).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestCount).toBe(1);

    resolveFirst(jsonResponse(lifecycle('SCORING')));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_500);
    await flushPromises();

    expect(requestCount).toBe(2);
    expect(maxActiveRequests).toBe(1);
    expect(wrapper.text()).toContain('本次得分：1 / 1');
    wrapper.unmount();
  });

  it('reconciles a submit 409 to the authoritative SCORING state', async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      urls.push(String(input));
      return init?.method === 'POST'
        ? jsonResponse({ message: '答题状态已变化，请刷新' }, 409)
        : jsonResponse(lifecycle('SCORING'));
    });
    const wrapper = mount(QuizRunner, {
      props: {
        attemptId: 'a1',
        questions: [makeQuestion()],
        initialState: lifecycle('DRAFT'),
      },
    });

    await wrapper
      .findAll('.quiz-controls button')
      .find((button) => button.text().includes('提交答案'))!
      .trigger('click');
    await flushPromises();

    expect(urls).toEqual([
      '/api/v1/quizzes/a1/submit',
      '/api/v1/quizzes/attempts/a1',
    ]);
    expect(wrapper.text()).toContain('正在评分');
    expect(wrapper.find('.option input').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('reconciles a grading 5xx to the authoritative SCORING_FAILED state', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      init?.method === 'POST'
        ? jsonResponse({ message: '评分服务暂时不可用' }, 500)
        : jsonResponse(lifecycle('SCORING_FAILED', {
            gradingError: '评分服务暂时不可用',
          })),
    );
    const wrapper = mount(QuizRunner, {
      props: {
        attemptId: 'a1',
        questions: [makeQuestion()],
        initialState: lifecycle('DRAFT'),
      },
    });

    await wrapper
      .findAll('.quiz-controls button')
      .find((button) => button.text().includes('提交答案'))!
      .trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('评分服务暂时不可用');
    expect(wrapper.text()).toContain('用相同答案重新评分');
    expect(wrapper.find('.option input').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('locks answers and keeps draft flush single-flight during submission', async () => {
    const draft = deferred<Response>();
    let draftCount = 0;
    let submitCount = 0;
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/draft')) {
        draftCount += 1;
        return draft.promise;
      }
      submitCount += 1;
      return jsonResponse({
        attemptId: 'a1',
        status: 'SUBMITTED',
        pending: false,
        score: 1,
        total: 1,
        results: [],
      });
    });
    const wrapper = mount(QuizRunner, {
      props: { attemptId: 'a1', questions: [makeQuestion()] },
    });
    await wrapper.find('.option input').setValue(true);
    const submitButton = wrapper
      .findAll('.quiz-controls button')
      .find((button) => button.text().includes('提交答案'))!;

    await submitButton.trigger('click');
    expect(draftCount).toBe(1);
    expect(submitButton.attributes('disabled')).toBeDefined();
    expect(wrapper.find('.option input').attributes('disabled')).toBeDefined();
    await submitButton.trigger('click');
    expect(draftCount).toBe(1);

    draft.resolve(jsonResponse({
      attemptId: 'a1',
      revision: 1,
      position: 0,
      savedAt: '2026-08-10T03:00:00.000Z',
      expiresAt: '2026-08-17T03:00:00.000Z',
    }));
    await flushPromises();

    expect(draftCount).toBe(1);
    expect(submitCount).toBe(1);
    wrapper.unmount();
  });

  it('reconciles a submit 409 to the authoritative SUBMITTED result', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      init?.method === 'POST'
        ? jsonResponse({ message: '该次答题已经使用不同答案提交' }, 409)
        : jsonResponse(lifecycle('SUBMITTED', {
            score: 1,
            results: [{
              questionId: 'q1',
              correct: true,
              score: 1,
              maxScore: 1,
              correctAnswer: ['A'],
              explanation: '解析',
            }],
          })),
    );
    const wrapper = mount(QuizRunner, {
      props: {
        attemptId: 'a1',
        questions: [makeQuestion()],
        initialState: lifecycle('DRAFT'),
      },
    });

    await wrapper
      .findAll('.quiz-controls button')
      .find((button) => button.text().includes('提交答案'))!
      .trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('本次得分：1 / 1');
    expect(wrapper.emitted('submitted')).toHaveLength(1);
    wrapper.unmount();
  });

  it('renders a restored ABANDONED attempt as a locked terminal state', async () => {
    const wrapper = mount(QuizRunner, {
      props: {
        attemptId: 'a1',
        questions: [makeQuestion()],
        finishLabel: '返回练习入口',
        initialState: lifecycle('ABANDONED'),
      },
    });

    expect(wrapper.text()).toContain('该答题已放弃');
    expect(wrapper.find('.option input').attributes('disabled')).toBeDefined();
    const finish = wrapper
      .findAll('button')
      .find((button) => button.text().includes('返回练习入口'))!;
    await finish.trigger('click');
    expect(wrapper.emitted('restart')).toHaveLength(1);
    wrapper.unmount();
  });

  it('locks answers while scoring and retries a failed score with the same answers', async () => {
    vi.useFakeTimers();
    const postBodies: Array<Record<string, unknown>> = [];
    let submitCount = 0;
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/quizzes/a1/submit')) {
        postBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        submitCount += 1;
        return submitCount === 1
          ? jsonResponse({ attemptId: 'a1', status: 'SCORING', pending: true }, 202)
          : jsonResponse({
              attemptId: 'a1',
              status: 'SUBMITTED',
              pending: false,
              score: 1,
              total: 1,
              results: [
                {
                  questionId: 'q1',
                  correct: true,
                  score: 1,
                  maxScore: 1,
                  correctAnswer: ['A'],
                  explanation: '解析',
                },
              ],
            });
      }
      return jsonResponse(
        lifecycle('SCORING_FAILED', { gradingError: '评分服务超时' }),
      );
    });
    const wrapper = mount(QuizRunner, {
      props: {
        attemptId: 'a1',
        questions: [makeQuestion()],
        initialState: lifecycle('DRAFT'),
      },
    });

    await wrapper
      .findAll('.quiz-controls button')
      .find((button) => button.text().includes('提交答案'))!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('正在评分');
    expect(wrapper.find('.option input').attributes('disabled')).toBeDefined();

    await vi.advanceTimersByTimeAsync(1_500);
    await flushPromises();
    expect(wrapper.text()).toContain('评分服务超时');
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('用相同答案重新评分'))!
      .trigger('click');
    await flushPromises();

    expect(postBodies).toEqual([
      { answers: { q1: ['A'] } },
      { answers: { q1: ['A'] } },
    ]);
    expect(wrapper.text()).toContain('本次得分：1 / 1');
    wrapper.unmount();
  });
});
