import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuizImportJob } from "../../types";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  uploadForm: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  ApiClientError: class ApiClientError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
  api: mocks.api,
  apiUrl: (path: string) => `/api/v1${path}`,
  formatError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
  isAbortError: (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError",
  uploadForm: mocks.uploadForm,
}));
vi.mock("../../composables/useToast", () => ({
  useToast: () => ({ error: mocks.toastError, success: mocks.toastSuccess }),
}));

import AdminQuizImport from "./AdminQuizImport.vue";

function job(overrides: Partial<QuizImportJob> = {}): QuizImportJob {
  return {
    id: "import-1",
    fileType: "ZIP",
    mode: "BANK",
    sourceName: "questions.zip",
    sourceSize: 1_024,
    status: "PREFLIGHT_PENDING",
    stage: "QUEUED",
    progressCurrent: 0,
    progressTotal: 0,
    questionCount: 0,
    imageCount: 0,
    warningCount: 0,
    errorCount: 0,
    summary: null,
    importedCount: 0,
    createdChapterCount: 0,
    resultPastPaperId: null,
    errorCode: null,
    errorMessage: null,
    expiresAt: "2026-07-26T00:00:00.000Z",
    confirmedAt: null,
    completedAt: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

const subjects = [
  {
    id: "subject-1",
    name: "生理学",
    slug: "physiology",
    sortOrder: 10,
    active: true,
  },
];
const papers = [
  {
    id: "paper-1",
    title: "2024 生理学真题",
    subjectId: "subject-1",
    subject: "生理学",
    year: 2024,
    questionCount: 20,
    typeLabels: ["单选题"],
  },
];

async function mountImporter() {
  const wrapper = mount(AdminQuizImport, { props: { subjects, papers } });
  await flushPromises();
  return wrapper;
}

async function selectFile(
  wrapper: ReturnType<typeof mount>,
  name = "questions.zip",
) {
  const selected = new File(["package"], name, {
    type: name.endsWith(".zip") ? "application/zip" : "text/csv",
  });
  const input = wrapper.get("#quiz-import-file");
  Object.defineProperty(input.element, "files", {
    value: [selected],
    configurable: true,
  });
  await input.trigger("change");
  return selected;
}

describe("AdminQuizImport", () => {
  beforeEach(() => {
    mocks.api.mockReset();
    mocks.uploadForm.mockReset();
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.api.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uploads a ZIP with real progress metadata and supports cancellation", async () => {
    let rejectUpload!: (error: unknown) => void;
    mocks.uploadForm.mockImplementation(
      (
        _path: string,
        _form: FormData,
        options: { signal: AbortSignal; onProgress: (value: unknown) => void },
      ) => {
        options.onProgress({ loaded: 40, total: 100, percent: 40 });
        options.signal.addEventListener("abort", () => {
          rejectUpload(new DOMException("上传已取消", "AbortError"));
        });
        return new Promise((_resolve, reject) => {
          rejectUpload = reject;
        });
      },
    );
    const wrapper = await mountImporter();
    const selected = await selectFile(wrapper);
    await wrapper.get("#import-create-chapters").setValue(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    const [path, form] = mocks.uploadForm.mock.calls[0]!;
    expect(path).toBe("/quizzes/imports");
    expect((form as FormData).get("file")).toBe(selected);
    expect((form as FormData).get("mode")).toBe("BANK");
    expect((form as FormData).get("createMissingChapters")).toBe("true");
    expect(wrapper.text()).toContain("上传 40%");

    await wrapper.get('button[title="取消上传"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已取消上传");
  });

  it("resumes preflight, confirms once, polls to completion, and emits refresh", async () => {
    vi.useFakeTimers();
    const awaiting = job({
      status: "AWAITING_CONFIRMATION",
      stage: "READY_FOR_CONFIRMATION",
      questionCount: 12,
      imageCount: 3,
      summary: {
        questionCount: 12,
        imageCount: 3,
        plannedChapterCount: 2,
        subjects: [{ name: "生理学", count: 12 }],
        typeLabels: [{ name: "单选题", count: 12 }],
      },
    });
    const importing = job({
      status: "IMPORTING",
      stage: "PROCESSING_IMAGES",
      progressCurrent: 1,
      progressTotal: 3,
    });
    const completed = job({
      status: "COMPLETED",
      stage: "COMPLETED",
      questionCount: 12,
      imageCount: 3,
      importedCount: 12,
      completedAt: "2026-07-25T01:00:00.000Z",
    });
    let detailReads = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path.includes("?")) {
        return Promise.resolve({
          items: [awaiting],
          total: 1,
          page: 1,
          pageSize: 10,
        });
      }
      if (path.endsWith("/confirm") && options?.method === "POST") {
        return Promise.resolve(
          job({ status: "IMPORT_PENDING", stage: "QUEUED_FOR_IMPORT" }),
        );
      }
      detailReads += 1;
      return Promise.resolve(
        detailReads === 1
          ? importing
          : completed,
      );
    });

    const wrapper = await mountImporter();
    expect(wrapper.text()).toContain("等待确认");
    expect(wrapper.text()).toContain("生理学 12");

    await wrapper.get(".job-actions button").trigger("click");
    await flushPromises();
    expect(mocks.api).toHaveBeenCalledWith(
      "/quizzes/imports/import-1/confirm",
      {
        method: "POST",
      },
    );
    expect(wrapper.text()).toContain("正在处理图片");

    await vi.advanceTimersByTimeAsync(1_500);
    await flushPromises();
    expect(wrapper.text()).toContain("导入完成");
    expect(wrapper.emitted("completed")).toHaveLength(1);
  });

  it("does not overlap polling requests and clears cancel busy after failure", async () => {
    vi.useFakeTimers();
    const pending = job();
    let resolveDetail!: (value: QuizImportJob) => void;
    let detailReads = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path.includes("?"))
        return Promise.resolve({ items: [pending], total: 1, page: 1, pageSize: 10 });
      if (path.endsWith("/cancel") && options?.method === "POST")
        return Promise.reject(new Error("取消失败"));
      detailReads += 1;
      return new Promise<QuizImportJob>((resolve) => { resolveDetail = resolve; });
    });
    const wrapper = await mountImporter();
    expect(detailReads).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(detailReads).toBe(1);
    resolveDetail(pending);
    await flushPromises();

    const cancelButton = wrapper.findAll(".job-actions button").find((button) => button.text().includes("取消任务"))!;
    await cancelButton.trigger("click");
    await flushPromises();
    expect(mocks.toastError).toHaveBeenCalledWith("取消失败");
    expect(cancelButton.attributes("disabled")).toBeUndefined();
  });

  it("locks task switching during confirmation and updates the captured recent job", async () => {
    const awaiting = job({ id: "import-a", status: "AWAITING_CONFIRMATION", stage: "READY_FOR_CONFIRMATION" });
    const other = job({ id: "import-b", sourceName: "other.zip", status: "IMPORTING", stage: "WRITING_DATABASE" });
    let resolveConfirm!: (value: QuizImportJob) => void;
    const confirmPromise = new Promise<QuizImportJob>((resolve) => { resolveConfirm = resolve; });
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path.includes("?"))
        return Promise.resolve({ items: [awaiting, other], total: 2, page: 1, pageSize: 10 });
      if (path.endsWith("/import-a/confirm") && options?.method === "POST") return confirmPromise;
      if (path.endsWith("/import-a")) return new Promise(() => {});
      return Promise.resolve(other);
    });
    const wrapper = await mountImporter();
    const jobActionButtons = wrapper.findAll(".job-actions button");
    const confirmButton = jobActionButtons.find((button) => button.text().includes("确认导入"))!;
    await confirmButton.trigger("click");
    await flushPromises();

    expect(wrapper.findAll(".job-actions button").every(
      (button) => button.attributes("disabled") !== undefined,
    )).toBe(true);
    const recentButtons = wrapper.findAll(".recent-jobs button");
    expect(recentButtons.every((button) => button.attributes("disabled") !== undefined)).toBe(true);
    await recentButtons[1]!.trigger("click");
    expect(wrapper.text()).toContain("questions.zip");

    resolveConfirm(job({ id: "import-a", status: "IMPORT_PENDING", stage: "QUEUED_FOR_IMPORT" }));
    await flushPromises();
    expect(wrapper.findAll(".recent-jobs button")[0]!.text()).toContain("等待导入");
    expect(wrapper.findAll(".recent-jobs button")[0]!.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("retries a transient polling failure after the previous request settles", async () => {
    vi.useFakeTimers();
    const pending = job({ status: "IMPORTING", stage: "PROCESSING_IMAGES" });
    const completed = job({
      status: "COMPLETED",
      stage: "COMPLETED",
      importedCount: 12,
      completedAt: "2026-07-25T01:00:00.000Z",
    });
    let detailReads = 0;
    mocks.api.mockImplementation((path: string) => {
      if (path.includes("?")) {
        return Promise.resolve({ items: [pending], total: 1, page: 1, pageSize: 10 });
      }
      detailReads += 1;
      if (detailReads === 1) return Promise.reject(new Error("临时读取失败"));
      return Promise.resolve(completed);
    });

    const wrapper = await mountImporter();
    expect(detailReads).toBe(1);
    expect(wrapper.text()).toContain("临时读取失败");

    await vi.advanceTimersByTimeAsync(1_500);
    await flushPromises();

    expect(detailReads).toBe(2);
    expect(wrapper.text()).toContain("导入完成");
    expect(wrapper.text()).not.toContain("临时读取失败");
    wrapper.unmount();
  });

  it("rebuilds polling when a manual refresh observes a resumed task", async () => {
    vi.useFakeTimers();
    const awaiting = job({
      status: "AWAITING_CONFIRMATION",
      stage: "READY_FOR_CONFIRMATION",
    });
    const importing = job({ status: "IMPORTING", stage: "WRITING_DATABASE" });
    const completed = job({
      status: "COMPLETED",
      stage: "COMPLETED",
      importedCount: 12,
      completedAt: "2026-07-25T01:00:00.000Z",
    });
    let recentReads = 0;
    let detailReads = 0;
    mocks.api.mockImplementation((path: string) => {
      if (path.includes("?")) {
        recentReads += 1;
        return Promise.resolve({
          items: [recentReads === 1 ? awaiting : importing],
          total: 1,
          page: 1,
          pageSize: 10,
        });
      }
      detailReads += 1;
      return Promise.resolve(completed);
    });

    const wrapper = await mountImporter();
    expect(wrapper.text()).toContain("等待确认");
    expect(detailReads).toBe(0);

    await wrapper.get('button[title="刷新任务"]').trigger("click");
    await flushPromises();

    expect(recentReads).toBe(2);
    expect(detailReads).toBe(1);
    expect(wrapper.text()).toContain("导入完成");
    wrapper.unmount();
  });

  it("submits new-paper metadata and rejects unsupported files locally", async () => {
    mocks.uploadForm.mockResolvedValue(job());
    const wrapper = await mountImporter();
    await wrapper.get('input[value="newPaper"]').trigger("change");
    await wrapper.get("#import-paper-title").setValue("2025 生理学真题");
    await wrapper.get("#import-paper-subject").setValue("subject-1");
    await wrapper.get("#import-paper-year").setValue("2025");
    await selectFile(wrapper, "questions.csv");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    const form = mocks.uploadForm.mock.calls[0]![1] as FormData;
    expect(form.get("mode")).toBe("NEW_PAPER");
    expect(form.get("pastPaperTitle")).toBe("2025 生理学真题");
    expect(form.get("subjectId")).toBe("subject-1");
    expect(form.get("pastPaperYear")).toBe("2025");

    const invalid = new File(["bad"], "questions.txt", { type: "text/plain" });
    const input = wrapper.get("#quiz-import-file");
    Object.defineProperty(input.element, "files", {
      value: [invalid],
      configurable: true,
    });
    await input.trigger("change");
    expect(wrapper.text()).toContain("仅支持 CSV 或 ZIP 题目包");
  });

  it("does not read while hidden and refreshes once when restored", async () => {
    const wrapper = mount(AdminQuizImport, {
      props: { subjects, papers, active: false },
    });
    await flushPromises();
    expect(mocks.api).not.toHaveBeenCalled();

    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(mocks.api).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ active: false });
    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(mocks.api).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});
