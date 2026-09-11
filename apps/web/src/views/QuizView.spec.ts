import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { reactive } from 'vue';
import { routeLocationKey, routerKey } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuizView from "./QuizView.vue";

function mountView(
  query: Record<string, string> = {},
  replace = vi.fn().mockResolvedValue(undefined),
) {
  return mount(QuizView, {
    global: {
      provide: {
        [routeLocationKey as symbol]: { query },
        [routerKey as symbol]: { replace },
      },
      stubs: {
        RouterLink: RouterLinkStub,
        PageHeader: {
          props: ["title", "description"],
          template: "<div class='page-header-stub' :data-title='title' :data-description='description'><slot name='breadcrumb'/></div>",
        },
        QuizStartPanel: true,
        QuizLibrary: true,
        QuizPapers: true,
        QuizRunner: true,
        QuizHistory: true,
        QuizWrong: true,
      },
    },
  });
}

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

describe("QuizView", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the library mounted after visiting to preserve cross-page selections", async () => {
    const wrapper = mountView();
    await wrapper.findAll('[role="tab"]')[1]!.trigger("click");
    expect(wrapper.findComponent({ name: "QuizLibrary" }).exists()).toBe(true);

    await wrapper.findAll('[role="tab"]')[2]!.trigger("click");
    expect(wrapper.findComponent({ name: "QuizLibrary" }).exists()).toBe(true);
  });

  it("opens the wrong-question panel from /quiz?mode=wrong", () => {
    const wrapper = mountView({ mode: "wrong" });

    expect(wrapper.findAll('[role="tab"]')[4]!.attributes("aria-selected")).toBe("true");
    expect(wrapper.findComponent({ name: "QuizWrong" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "QuizStartPanel" }).isVisible()).toBe(false);
  });

  it("switches into the runner when a library selection starts and back on restart", async () => {
    const replace = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountView({}, replace);
    await wrapper.findAll('[role="tab"]')[1]!.trigger("click");
    await flushPromises();

    wrapper.findComponent({ name: "QuizLibrary" }).vm.$emit("started", {
      attemptId: "attempt-1",
      questions: [],
    });
    await flushPromises();

    expect(wrapper.findComponent({ name: "QuizRunner" }).exists()).toBe(true);
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false);
    expect(replace).toHaveBeenCalledWith({ query: { attempt: 'attempt-1' } });

    wrapper.findComponent({ name: "QuizRunner" }).vm.$emit("restart");
    await flushPromises();
    expect(wrapper.findComponent({ name: "QuizRunner" }).exists()).toBe(false);
    expect(wrapper.find('[role="tablist"]').exists()).toBe(true);
  });

  it('restores an attempt from the query after a refresh', async () => {
    const restored = {
      attemptId: 'attempt-refresh',
      status: 'DRAFT',
      revision: 4,
      position: 1,
      answers: { q1: ['A'] },
      questions: [],
      savedAt: '2026-08-10T02:00:00.000Z',
      expiresAt: '2026-08-17T02:00:00.000Z',
      score: null,
      total: 2,
      results: null,
      gradingError: null,
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(restored));

    const wrapper = mountView({ attempt: 'attempt-refresh' });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/quizzes/attempts/attempt-refresh',
      expect.objectContaining({ credentials: 'include' }),
    );
    const runner = wrapper.findComponent({ name: 'QuizRunner' });
    expect(runner.exists()).toBe(true);
    expect(runner.props('attemptId')).toBe('attempt-refresh');
    expect(runner.props('initialState')).toMatchObject({
      revision: 4,
      position: 1,
      answers: { q1: ['A'] },
    });
  });

  it('aborts a pending query restore when the view unmounts', async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return pending.promise;
    });
    const wrapper = mountView({ attempt: 'attempt-pending' });
    await wrapper.vm.$nextTick();

    wrapper.unmount();
    expect(signal?.aborted).toBe(true);
    pending.resolve(jsonResponse({ message: 'late response' }));
    await flushPromises();
  });

  it('returns to the quiz entry when an invalid attempt query is removed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ message: '答题记录不存在' }, 404),
    );
    const query = reactive<Record<string, string>>({ attempt: 'missing' });
    const wrapper = mountView(query);
    await flushPromises();

    expect(wrapper.find('.restore-error').exists()).toBe(true);
    delete query.attempt;
    await flushPromises();

    expect(wrapper.find('.restore-error').exists()).toBe(false);
    expect(wrapper.find('[role="tablist"]').exists()).toBe(true);
  });
});
