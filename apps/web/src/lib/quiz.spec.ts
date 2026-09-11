import { describe, expect, it } from "vitest";
import { answeredCount, setShortAnswer, toggleAnswer } from "./quiz";

describe("quiz answer helpers", () => {
  it("stores a short answer as one text value", () => {
    expect(setShortAnswer({}, "q1", "肺泡通气量")).toEqual({
      q1: ["肺泡通气量"],
    });
  });

  it("does not count whitespace-only short answers as answered", () => {
    expect(answeredCount([{ id: "q1" }], { q1: ["   "] })).toBe(0);
  });

  it("keeps multiple-choice selection behavior", () => {
    const selected = toggleAnswer({}, "q1", "MULTIPLE", "a");
    expect(toggleAnswer(selected, "q1", "MULTIPLE", "c")).toEqual({
      q1: ["a", "c"],
    });
  });
});
