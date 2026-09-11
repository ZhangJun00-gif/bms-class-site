import { QuestionType, QuizQuestionCategory } from "@prisma/client";
import { createHash } from "node:crypto";

export class QuizValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuizValidationError";
  }
}

export interface QuizOption {
  id: string;
  text: string;
}

export interface GradingCriterion {
  description: string;
  points: number;
}

export interface GradingRubric {
  criteria: GradingCriterion[];
  notes?: string;
}

export interface QuestionInput {
  type?: unknown;
  gradingType?: unknown;
  typeLabel?: unknown;
  subjectId: unknown;
  chapterIds: unknown;
  category?: unknown;
  prompt: unknown;
  options: unknown;
  correctAnswer: unknown;
  gradingRubric?: unknown;
  explanation: unknown;
}

export interface PreparedQuestion {
  type: QuestionType;
  typeLabel: string;
  subjectId: string;
  chapterIds: string[];
  category: QuizQuestionCategory;
  prompt: string;
  options: QuizOption[];
  correctAnswer: string[];
  gradingRubric?: GradingRubric;
  maxScore: number;
  explanation: string;
}

export const DEFAULT_QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  [QuestionType.SINGLE]: "单选题",
  [QuestionType.MULTIPLE]: "多选题",
  [QuestionType.TRUE_FALSE]: "判断题",
  [QuestionType.SHORT_ANSWER]: "简答题",
};

export function importedChapterSlug(subjectId: string, name: string) {
  const digest = createHash("sha256")
    .update(`${subjectId}\u0000${name}`, "utf8")
    .digest("hex")
    .slice(0, 48);
  return `csv-${digest}`;
}

function fail(message: string): never {
  throw new QuizValidationError(message);
}

function text(
  value: unknown,
  field: string,
  min: number,
  max: number,
  context: string,
): string {
  if (typeof value !== "string") fail(`${context}的 ${field} 必须是字符串`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    fail(`${context}的 ${field} 长度必须在 ${min}-${max} 个字符之间`);
  }
  return normalized;
}

function stringArray(value: unknown, field: string, context: string): string[] {
  if (!Array.isArray(value)) fail(`${context}的 ${field} 必须是字符串数组`);
  const values = value.map((item, index) =>
    text(item, `${field}[${index}]`, 1, 10_000, context),
  );
  if (new Set(values).size !== values.length) {
    fail(`${context}的 ${field} 不能包含重复值`);
  }
  return values;
}

function idArray(value: unknown, field: string, context: string): string[] {
  const values = stringArray(value, field, context);
  if (values.length < 1 || values.length > 20) {
    fail(`${context}的 ${field} 必须包含 1-20 个章节 ID`);
  }
  if (values.some((value) => value.length > 191)) {
    fail(`${context}的 ${field} 包含过长的章节 ID`);
  }
  return values;
}

function options(value: unknown, context: string): QuizOption[] {
  if (!Array.isArray(value)) fail(`${context}的 options 必须是数组`);
  const parsed = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail(`${context}的 options[${index}] 格式无效`);
    }
    const option = item as Record<string, unknown>;
    return {
      id: text(option.id, `options[${index}].id`, 1, 80, context),
      text: text(option.text, `options[${index}].text`, 1, 2_000, context),
    };
  });
  if (new Set(parsed.map((option) => option.id)).size !== parsed.length) {
    fail(`${context}的选项 id 不能重复`);
  }
  return parsed;
}

export function parseGradingRubric(
  value: unknown,
  context = "题目",
): GradingRubric {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context}的 gradingRubric 必须是对象`);
  }
  const input = value as Record<string, unknown>;
  if (
    !Array.isArray(input.criteria) ||
    input.criteria.length < 1 ||
    input.criteria.length > 20
  ) {
    fail(`${context}的 gradingRubric.criteria 必须包含 1-20 个评分点`);
  }
  const criteria = input.criteria.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail(`${context}的评分点 ${index + 1} 格式无效`);
    }
    const criterion = item as Record<string, unknown>;
    const points = criterion.points;
    if (
      !Number.isInteger(points) ||
      (points as number) < 1 ||
      (points as number) > 100
    ) {
      fail(`${context}的评分点 ${index + 1} 分值必须是 1-100 的整数`);
    }
    return {
      description: text(
        criterion.description,
        `评分点 ${index + 1} 描述`,
        2,
        1_000,
        context,
      ),
      points: points as number,
    };
  });
  const maxScore = criteria.reduce(
    (sum, criterion) => sum + criterion.points,
    0,
  );
  if (maxScore > 100) fail(`${context}的简答题总分不能超过 100 分`);
  const notes =
    input.notes === undefined
      ? undefined
      : text(input.notes, "gradingRubric.notes", 1, 2_000, context);
  return { criteria, ...(notes ? { notes } : {}) };
}

export function prepareQuestion(
  input: QuestionInput,
  context = "题目",
): PreparedQuestion {
  if (
    input.gradingType !== undefined &&
    input.type !== undefined &&
    input.gradingType !== input.type
  ) {
    fail(`${context}的 gradingType 与兼容字段 type 不一致`);
  }
  const rawGradingType = input.gradingType ?? input.type;
  if (!Object.values(QuestionType).includes(rawGradingType as QuestionType)) {
    fail(`${context}的 gradingType 不是受支持的判分类型`);
  }
  const type = rawGradingType as QuestionType;
  const typeLabel =
    input.typeLabel === undefined || input.typeLabel === null
      ? DEFAULT_QUESTION_TYPE_LABELS[type]
      : text(input.typeLabel, "typeLabel", 1, 100, context);
  if (typeLabel === "往年真题") {
    fail(
      `${context}的 typeLabel 不能使用保留标签“往年真题”，请改用往年真题试卷归属`,
    );
  }
  const category = input.category ?? QuizQuestionCategory.STANDARD;
  if (
    !Object.values(QuizQuestionCategory).includes(
      category as QuizQuestionCategory,
    )
  ) {
    fail(`${context}的 category 不是受支持的分类`);
  }
  const parsedOptions = options(input.options, context);
  const correctAnswer = stringArray(
    input.correctAnswer,
    "correctAnswer",
    context,
  );
  let gradingRubric: GradingRubric | undefined;
  let maxScore = 1;

  if (type === QuestionType.SHORT_ANSWER) {
    if (parsedOptions.length) fail(`${context}的简答题 options 必须为空数组`);
    if (!correctAnswer.length) fail(`${context}的简答题至少需要一个参考答案`);
    gradingRubric = parseGradingRubric(input.gradingRubric, context);
    maxScore = gradingRubric.criteria.reduce(
      (sum, criterion) => sum + criterion.points,
      0,
    );
  } else {
    if (parsedOptions.length < 2) fail(`${context}至少需要两个选项`);
    if (!correctAnswer.length) fail(`${context}至少需要一个正确答案`);
    const optionIds = new Set(parsedOptions.map((option) => option.id));
    if (correctAnswer.some((answer) => !optionIds.has(answer))) {
      fail(`${context}的 correctAnswer 必须引用已有选项 id`);
    }
    if (type !== QuestionType.MULTIPLE && correctAnswer.length !== 1) {
      fail(`${context}的单选题或判断题只能有一个正确答案`);
    }
    if (input.gradingRubric !== undefined && input.gradingRubric !== null) {
      fail(`${context}只有简答题可以设置 gradingRubric`);
    }
  }

  return {
    type,
    typeLabel,
    subjectId: text(input.subjectId, "subjectId", 1, 191, context),
    chapterIds: idArray(input.chapterIds, "chapterIds", context),
    category: category as QuizQuestionCategory,
    prompt: text(input.prompt, "prompt", 2, 10_000, context),
    options: parsedOptions,
    correctAnswer,
    ...(gradingRubric ? { gradingRubric } : {}),
    maxScore,
    explanation: text(input.explanation, "explanation", 0, 10_000, context),
  };
}

export function normalizeQuestionText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

export function questionFingerprint(
  question: Pick<PreparedQuestion, "prompt" | "options" | "type">,
) {
  const normalized = JSON.stringify({
    type: question.type,
    prompt: normalizeQuestionText(question.prompt),
    options: question.options.map((option) =>
      normalizeQuestionText(option.text),
    ),
  });
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function questionTextSimilarity(left: string, right: string) {
  const normalizedLeft = normalizeQuestionText(left);
  const normalizedRight = normalizeQuestionText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  const gramSize = Math.min(normalizedLeft.length, normalizedRight.length) < 20
    ? 2
    : 3;
  const leftGrams = ngrams(normalizedLeft, gramSize);
  const rightGrams = ngrams(normalizedRight, gramSize);
  let intersection = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) intersection += 1;
  }
  const union = leftGrams.size + rightGrams.size - intersection;
  return union ? intersection / union : 0;
}

export function isNearDuplicateQuestion(left: string, right: string) {
  const shortest = Math.min(
    normalizeQuestionText(left).length,
    normalizeQuestionText(right).length,
  );
  return questionTextSimilarity(left, right) >= (shortest < 20 ? 0.9 : 0.82);
}

function ngrams(value: string, size: number) {
  if (value.length <= size) return new Set([value]);
  const result = new Set<string>();
  for (let index = 0; index <= value.length - size; index += 1) {
    result.add(value.slice(index, index + size));
  }
  return result;
}
