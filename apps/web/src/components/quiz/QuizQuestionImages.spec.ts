import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import QuizQuestionImages from "./QuizQuestionImages.vue";
import type { QuizImage } from "../../types";

function makeImage(overrides: Partial<QuizImage> = {}): QuizImage {
  return {
    id: "img-1",
    caption: "",
    mimeType: "image/jpeg",
    size: 1024,
    width: 800,
    height: 600,
    url: "/api/v1/media/images/img-1/content",
    ...overrides,
  };
}

const images: QuizImage[] = [
  makeImage({ id: "img-1", caption: "肾小球结构示意", url: "/img/1" }),
  makeImage({ id: "img-2", caption: "", url: "/img/2" }),
  makeImage({ id: "img-3", caption: "病理切片", url: "/img/3" }),
];

describe("QuizQuestionImages", () => {
  it("renders all images in backend order with captions as alt text", () => {
    const wrapper = mount(QuizQuestionImages, {
      props: { images, altContext: "肾小球滤过的主要动力" },
    });
    const imgs = wrapper.findAll(".quiz-image-button img");
    expect(imgs).toHaveLength(3);
    expect(imgs[0]!.attributes("src")).toBe("/img/1");
    expect(imgs[0]!.attributes("alt")).toBe("肾小球结构示意");
    expect(imgs[1]!.attributes("src")).toBe("/img/2");
    expect(imgs[1]!.attributes("alt")).toContain("肾小球滤过的主要动力");
    expect(imgs[2]!.attributes("alt")).toBe("病理切片");

    const captions = wrapper.findAll(".quiz-image-caption");
    expect(captions).toHaveLength(2);
    expect(captions[0]!.text()).toBe("肾小球结构示意");
  });

  it("uses a safe default alt text when neither caption nor context exists", () => {
    const wrapper = mount(QuizQuestionImages, {
      props: { images: [makeImage()] },
    });
    expect(wrapper.find("img")!.attributes("alt")).toBe("题目配图 1");
  });

  it("shows a local placeholder for a failed image without breaking others", async () => {
    const wrapper = mount(QuizQuestionImages, {
      props: { images, altContext: "题干" },
    });
    const first = wrapper.findAll(".quiz-image-button img")[0]!;
    await first.trigger("error");

    expect(wrapper.find(".quiz-image-fallback").exists()).toBe(true);
    expect(wrapper.find(".quiz-image-fallback").text()).toContain(
      "配图加载失败",
    );
    const remaining = wrapper.findAll(".quiz-image-button img");
    expect(remaining).toHaveLength(2);
    expect(remaining[0]!.attributes("src")).toBe("/img/2");
  });

  it("opens a zoom dialog on click and closes it", async () => {
    const wrapper = mount(QuizQuestionImages, {
      props: { images },
      global: { stubs: { teleport: true } },
    });
    expect(wrapper.find(".quiz-image-zoom").exists()).toBe(false);

    await wrapper.findAll(".quiz-image-button")[0]!.trigger("click");
    await flushPromises();
    const zoom = wrapper.find(".quiz-image-zoom");
    expect(zoom.exists()).toBe(true);
    expect(zoom.find("img")!.attributes("src")).toBe("/img/1");
    expect(zoom.text()).toContain("肾小球结构示意");

    await wrapper
      .findAll("button")
      .find((button) => button.attributes("aria-label") === "关闭对话框")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".quiz-image-zoom").exists()).toBe(false);
  });

});
