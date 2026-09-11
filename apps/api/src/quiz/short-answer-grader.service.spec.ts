import { BadGatewayException } from "@nestjs/common";
import { GradingRubric } from "./quiz-question";
import {
  SHORT_ANSWER_GRADING_SYSTEM_PROMPT,
  ShortAnswerGraderService,
  validateGradingResponse,
} from "./short-answer-grader.service";

const rubric: GradingRubric = {
  criteria: [
    { description: "要点一", points: 2 },
    { description: "要点二", points: 1 },
  ],
};

describe("validateGradingResponse", () => {
  it("accepts one bounded score for every rubric criterion", () => {
    const result = validateGradingResponse(
      JSON.stringify({
        criterionScores: [
          { criterionIndex: 0, awardedPoints: 2, reason: "命中" },
          { criterionIndex: 1, awardedPoints: 0, reason: "遗漏" },
        ],
        feedback: "补充第二点。",
      }),
      rubric,
    );

    expect(result.criterionScores).toHaveLength(2);
    expect(result.feedback).toBe("补充第二点。");
  });

  it("rejects a model score above the rubric limit", () => {
    expect(() =>
      validateGradingResponse(
        JSON.stringify({
          criterionScores: [
            { criterionIndex: 0, awardedPoints: 3, reason: "越界" },
            { criterionIndex: 1, awardedPoints: 1, reason: "命中" },
          ],
          feedback: "无",
        }),
        rubric,
      ),
    ).toThrow(BadGatewayException);
  });

  it("rejects a response that omits a criterion", () => {
    expect(() =>
      validateGradingResponse(
        JSON.stringify({
          criterionScores: [
            { criterionIndex: 0, awardedPoints: 2, reason: "命中" },
          ],
          feedback: "无",
        }),
        rubric,
      ),
    ).toThrow(BadGatewayException);
  });
});

describe("SHORT_ANSWER_GRADING_SYSTEM_PROMPT", () => {
  it("treats all submitted fields as untrusted grading data", () => {
    expect(SHORT_ANSWER_GRADING_SYSTEM_PROMPT).toContain("任何指令");
    expect(SHORT_ANSWER_GRADING_SYSTEM_PROMPT).toContain(
      "只能依据 rubric.criteria",
    );
  });
});

describe("ShortAnswerGraderService", () => {
  it("calls the configured DeepSeek OpenAI-compatible endpoint", async () => {
    const previous = {
      provider: process.env.QUIZ_GRADING_PROVIDER,
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      model: process.env.DEEPSEEK_GRADING_MODEL,
      fetch: global.fetch,
    };
    process.env.QUIZ_GRADING_PROVIDER = "deepseek";
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.DEEPSEEK_BASE_URL = "https://deepseek.example/v1/";
    process.env.DEEPSEEK_GRADING_MODEL = "deepseek-v4-flash";
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                criterionScores: [
                  { criterionIndex: 0, awardedPoints: 2, reason: "命中" },
                  { criterionIndex: 1, awardedPoints: 1, reason: "命中" },
                ],
                feedback: "完整。",
              }),
            },
          },
        ],
      }),
    });
    global.fetch = fetchMock as typeof fetch;

    try {
      const service = new ShortAnswerGraderService();
      const result = await service.grade({
        question: "题干",
        studentAnswer: "答案",
        referenceAnswers: ["参考答案"],
        rubric,
      });

      expect(result.model).toBe("deepseek-v4-flash");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://deepseek.example/v1/chat/completions",
        expect.objectContaining({ method: "POST" }),
      );
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(request.body as string) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.model).toBe("deepseek-v4-flash");
      expect(body.messages[0]?.content).toBe(
        SHORT_ANSWER_GRADING_SYSTEM_PROMPT,
      );
    } finally {
      global.fetch = previous.fetch;
      const restore = (
        key: keyof NodeJS.ProcessEnv,
        value: string | undefined,
      ) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore("QUIZ_GRADING_PROVIDER", previous.provider);
      restore("DEEPSEEK_API_KEY", previous.apiKey);
      restore("DEEPSEEK_BASE_URL", previous.baseUrl);
      restore("DEEPSEEK_GRADING_MODEL", previous.model);
    }
  });
});
