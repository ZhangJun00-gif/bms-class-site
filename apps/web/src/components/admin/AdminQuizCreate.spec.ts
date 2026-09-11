import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminQuizCreate from "./AdminQuizCreate.vue";

const subjects = [
  {
    id: "subject-1",
    name: "生理学",
    slug: "physiology",
    sortOrder: 10,
    active: true,
  },
  {
    id: "subject-2",
    name: "病理学",
    slug: "pathology",
    sortOrder: 20,
    active: true,
  },
];

const chapters = [
  {
    id: "chapter-1",
    subjectId: "subject-1",
    name: "第一章",
    slug: "chapter-1",
    sortOrder: 1,
    active: true,
  },
  {
    id: "chapter-2",
    subjectId: "subject-1",
    name: "第二章",
    slug: "chapter-2",
    sortOrder: 2,
    active: true,
  },
];

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("../../composables/useConfirm", () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const createdQuestion = {
  id: "q-new",
  typeLabel: "病例分析题",
  subject: "生理学",
};

function mockFetch(options: { imageFailsFor?: string } = {}) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/subjects/subject-1/chapters")) {
        return jsonResponse(chapters);
      }
      if (url.includes("/subjects/subject-2/chapters")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/quizzes/questions")) {
        return jsonResponse(createdQuestion, 201);
      }
      if (url.includes("/images/") && init?.method === "DELETE") {
        return jsonResponse({ deleted: true });
      }
      if (url.endsWith("/images")) {
        if (options.imageFailsFor) {
          return jsonResponse({ message: "图片格式不支持" }, 422);
        }
        return jsonResponse(
          {
            id: "photo-1",
            caption: "",
            mimeType: "image/png",
            size: 10,
            width: 10,
            height: 10,
            url: "/api/v1/media/images/photo-1/content",
          },
          201,
        );
      }
      return jsonResponse({ message: "not found" }, 404);
    });
}

async function mountCreate() {
  const wrapper = mount(AdminQuizCreate, { props: { subjects } });
  await flushPromises();
  return wrapper;
}

async function selectChapter(
  wrapper: ReturnType<typeof mount>,
  chapterName: string,
) {
  if (!wrapper.find(".chapter-select-menu").exists()) {
    await wrapper.get("#create-chapters").trigger("click");
  }
  const option = wrapper
    .findAll(".chapter-select-option")
    .find((candidate) => candidate.text().includes(chapterName));
  expect(option).toBeDefined();
  await option!.trigger("click");
  await wrapper.get(".chapter-select-done").trigger("click");
}

async function fillBaseFields(wrapper: ReturnType<typeof mount>) {
  await wrapper.find("#create-subject").setValue("subject-1");
  await flushPromises();
  await selectChapter(wrapper, "第一章");
  await wrapper.find("#create-prompt").setValue("题干内容");
  // 删除 C、D 两个多余选项，只保留 A、B
  await wrapper.find('button[aria-label="删除选项 D"]').trigger("click");
  await wrapper.find('button[aria-label="删除选项 C"]').trigger("click");
  const optionInputs = wrapper.findAll(".option-text");
  await optionInputs[0]!.setValue("选项甲");
  await optionInputs[1]!.setValue("选项乙");
  await wrapper.findAll(".answer-input")[0]!.setValue(true);
}

function createBody(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls.find(([input]) =>
    String(input).endsWith("/quizzes/questions"),
  );
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

async function attachImages(wrapper: ReturnType<typeof mount>, files: File[]) {
  const input = wrapper.find("#question-images");
  Object.defineProperty(input.element, "files", {
    value: files,
    configurable: true,
  });
  await input.trigger("change");
  await flushPromises();
}

describe("AdminQuizCreate", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps chapters owned by the latest subject when responses arrive out of order", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/subjects/subject-1/chapters")) return first.promise;
      if (url.includes("/subjects/subject-2/chapters")) return second.promise;
      return Promise.resolve(jsonResponse({ message: "not found" }, 404));
    });
    const wrapper = mount(AdminQuizCreate, { props: { subjects } });
    await wrapper.get("#create-subject").setValue("subject-2");
    second.resolve(jsonResponse([{ ...chapters[1], id: "chapter-new", subjectId: "subject-2", name: "病理新章" }]));
    await flushPromises();
    first.resolve(jsonResponse(chapters));
    await flushPromises();

    await wrapper.get("#create-chapters").trigger("click");
    expect(wrapper.text()).toContain("病理新章");
    expect(wrapper.text()).not.toContain("第一章");
  });

  it("keeps grading type and display label as separate fields", async () => {
    const wrapper = await mountCreate();
    const typeLabel = wrapper.find("#create-type-label");
    expect((typeLabel.element as HTMLInputElement).value).toBe("单选题");

    await wrapper.find("#create-grading-type").setValue("MULTIPLE");
    expect(
      (wrapper.find("#create-type-label").element as HTMLInputElement).value,
    ).toBe("多选题");

    await wrapper.find("#create-type-label").setValue("不定项案例分析");
    await wrapper.find("#create-grading-type").setValue("SINGLE");
    expect(
      (wrapper.find("#create-type-label").element as HTMLInputElement).value,
    ).toBe("不定项案例分析");
  });

  it("submits gradingType plus a custom typeLabel and never sends type", async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountCreate();
    await fillBaseFields(wrapper);
    await wrapper.find("#create-type-label").setValue("识图题");
    await wrapper.find("#create-category").setValue("KNOWLEDGE_RECALL");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const body = createBody(fetchMock);
    expect(body.gradingType).toBe("SINGLE");
    expect(body.typeLabel).toBe("识图题");
    expect(body.category).toBe("KNOWLEDGE_RECALL");
    expect(body).not.toHaveProperty("type");
    expect(body.options).toEqual([
      { id: "A", text: "选项甲" },
      { id: "B", text: "选项乙" },
    ]);
    expect(body.correctAnswer).toEqual(["A"]);
    expect(wrapper.emitted("created")).toHaveLength(1);
  });

  it("switches the form structure by gradingType, not by the custom label", async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountCreate();
    await wrapper.find("#create-grading-type").setValue("SHORT_ANSWER");
    await wrapper.find("#create-type-label").setValue("病例分析题");
    expect(wrapper.find(".options-fieldset").exists()).toBe(true);
    expect(wrapper.find("#create-reference").exists()).toBe(true);
    expect(wrapper.findAll(".answer-input")).toHaveLength(0);

    await wrapper.find("#create-subject").setValue("subject-1");
    await flushPromises();
    await selectChapter(wrapper, "第二章");
    await wrapper.find("#create-prompt").setValue("分析该病例的诊断依据");
    await wrapper.find("#create-reference").setValue("参考答案一\n参考答案二");
    const criteria = wrapper.findAll(".options-fieldset .option-row");
    await criteria[0]!.find(".option-text").setValue("答出关键机制");
    await criteria[0]!.find(".points-input").setValue(5);
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const body = createBody(fetchMock);
    expect(body.gradingType).toBe("SHORT_ANSWER");
    expect(body.typeLabel).toBe("病例分析题");
    expect(body.options).toEqual([]);
    expect(body.correctAnswer).toEqual(["参考答案一", "参考答案二"]);
    expect(body.gradingRubric).toEqual({
      criteria: [{ description: "答出关键机制", points: 5 }],
    });
  });

  it("blocks submission when required fields are missing", async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountCreate();
    await wrapper.find("#create-subject").setValue("");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find(".alert.error").text()).toContain("请选择学科");
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "POST"),
    ).toBe(false);
  });

  it("accepts images while editing and uploads them after question creation", async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountCreate();
    await fillBaseFields(wrapper);
    const input = wrapper.find("#create-question-images");
    Object.defineProperty(input.element, "files", {
      value: [
        new File(["diagram"], "diagram.webp", { type: "image/webp" }),
        new File(["photo"], "photo.jpg", { type: "image/jpeg" }),
      ],
      configurable: true,
    });
    await input.trigger("change");
    expect(
      fetchMock.mock.calls.some(([, options]) => options?.method === "POST"),
    ).toBe(false);
    expect(wrapper.text()).toContain("已选择 2 张配图");
    await wrapper
      .find('input[aria-label="图片 diagram.webp 的说明"]')
      .setValue("循环示意图");

    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const createIndex = fetchMock.mock.calls.findIndex(([request]) =>
      String(request).endsWith("/quizzes/questions"),
    );
    const imageCalls = fetchMock.mock.calls.filter(([request]) =>
      String(request).endsWith("/images"),
    );
    const firstImageIndex = fetchMock.mock.calls.indexOf(imageCalls[0]!);
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(firstImageIndex).toBeGreaterThan(createIndex);
    expect(imageCalls).toHaveLength(2);
    const firstForm = imageCalls[0]![1]?.body as FormData;
    expect(firstForm.get("caption")).toBe("循环示意图");
    expect(firstForm.get("sortOrder")).toBe("0");
    expect(wrapper.text()).toContain("配图 2 / 2 上传成功");
  });

  it("keeps the created question visible when some images fail and supports retry", async () => {
    const fetchMock = mockFetch({ imageFailsFor: "all" });
    const wrapper = await mountCreate();
    await fillBaseFields(wrapper);
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    await attachImages(wrapper, [
      new File(["a"], "a.png", { type: "image/png" }),
    ]);

    expect(wrapper.text()).toContain("题目已创建");
    expect(wrapper.text()).toContain("配图 0 / 1 上传成功");
    expect(wrapper.text()).toContain("图片格式不支持");

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/images")) {
        return jsonResponse(
          {
            id: "photo-2",
            caption: "",
            mimeType: "image/png",
            size: 10,
            width: 10,
            height: 10,
            url: "/img/photo-2",
          },
          201,
        );
      }
      return jsonResponse({ message: "not found" }, 404);
    });
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("重试"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("配图 1 / 1 上传成功");
  });

  it("detaches an image only after confirmation", async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountCreate();
    await fillBaseFields(wrapper);
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    await attachImages(wrapper, [
      new File(["a"], "a.png", { type: "image/png" }),
    ]);
    expect(wrapper.findAll(".image-entry")).toHaveLength(1);

    confirmMock.mockResolvedValueOnce(false);
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("解绑"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".image-entry")).toHaveLength(1);

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("解绑"))!
      .trigger("click");
    await flushPromises();
    const deleteCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes("/images/photo-1") && init?.method === "DELETE",
    );
    expect(deleteCall).toBeDefined();
    expect(wrapper.findAll(".image-entry")).toHaveLength(0);
  });

});
