import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetQuizFiltersCache } from "../../composables/useQuizFilters";
import QuizPapers from "./QuizPapers.vue";

const filtersPayload = {
  subjects: ["生理学", "病理学"],
  types: ["SINGLE"],
  subjectGroups: [
    {
      subjectId: "subject-1",
      subject: "生理学",
      pastPaperCount: 3,
      chapters: [],
      types: [],
      pastPapers: [],
    },
    {
      subjectId: "subject-2",
      subject: "病理学",
      pastPaperCount: 0,
      chapters: [],
      types: [],
      pastPapers: [],
    },
  ],
};

const papersPayload = {
  items: [
    {
      id: "paper-1",
      title: "2024 级生理学期末真题",
      subjectId: "subject-1",
      subject: "生理学",
      year: 2024,
      questionCount: 30,
      typeLabels: ["单选题", "病例分析题"],
    },
    {
      id: "paper-2",
      title: "生理学综合卷",
      subjectId: "subject-1",
      subject: "生理学",
      year: null,
      questionCount: 12,
      typeLabels: ["识图题"],
    },
  ],
  total: 2,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(options: { papersFail?: boolean } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/quizzes/filters")) return jsonResponse(filtersPayload);
    if (url.includes("/start")) {
      return jsonResponse({ attemptId: "attempt-paper", questions: [] });
    }
    if (url.includes("/quizzes/papers")) {
      return options.papersFail
        ? jsonResponse({ message: "服务器错误" }, 500)
        : jsonResponse(papersPayload);
    }
    return jsonResponse({ message: "not found" }, 404);
  });
}

async function mountPapers() {
  const wrapper = mount(QuizPapers);
  await flushPromises();
  return wrapper;
}

describe("QuizPapers", () => {
  afterEach(() => {
    resetQuizFiltersCache();
    vi.restoreAllMocks();
  });

  it("filters papers by subject", async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountPapers();
    await wrapper.find("#papers-subject").setValue("subject-1");
    await flushPromises();
    const last = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter(
        (url) => url.includes("/quizzes/papers") && !url.includes("/start"),
      )
      .at(-1)!;
    expect(new URL(last, "http://localhost").searchParams.get("subjectId")).toBe(
      "subject-1",
    );
  });

  it("shows an error state and retries successfully", async () => {
    const fetchMock = mockFetch({ papersFail: true });
    const wrapper = await mountPapers();
    expect(wrapper.text()).toContain("服务器错误");

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/quizzes/filters")) return jsonResponse(filtersPayload);
      if (url.includes("/quizzes/papers")) return jsonResponse(papersPayload);
      return jsonResponse({ message: "not found" }, 404);
    });
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("重试"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("2024 级生理学期末真题");
  });

  it("starts a full paper through the dedicated endpoint and emits started", async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountPapers();
    const button = wrapper
      .findAll("button")
      .find((candidate) => candidate.text().includes("整套测试"))!;
    await button.trigger("click");
    await flushPromises();

    const startCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/quizzes/papers/paper-1/start"),
    );
    expect(startCall).toBeDefined();
    expect(startCall?.[1]?.method).toBe("POST");
    expect(startCall?.[1]?.body).toBeUndefined();
    expect(wrapper.emitted("started")).toHaveLength(1);
    expect(wrapper.emitted("started")![0]).toEqual([
      { attemptId: "attempt-paper", questions: [] },
    ]);
  });

  it("surfaces start failures without emitting", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/quizzes/filters")) return jsonResponse(filtersPayload);
      if (url.includes("/start"))
        return jsonResponse({ message: "该往年真题试卷中没有可用题目" }, 422);
      return jsonResponse(papersPayload);
    });
    const wrapper = await mountPapers();
    await wrapper
      .findAll("button")
      .find((candidate) => candidate.text().includes("整套测试"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("该往年真题试卷中没有可用题目");
    expect(wrapper.emitted("started")).toBeUndefined();
  });
});
