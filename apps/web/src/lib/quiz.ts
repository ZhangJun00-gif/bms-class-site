import type { QuestionType, QuizQuestion } from "../types";

export type AnswerMap = Record<string, string[]>;

/** 切换某题选项，返回新的答案表（不修改原对象，便于测试与响应式更新） */
export function toggleAnswer(
  answers: AnswerMap,
  questionId: string,
  type: QuestionType,
  optionId: string,
): AnswerMap {
  if (type === "MULTIPLE") {
    const current = answers[questionId] ?? [];
    const next = current.includes(optionId)
      ? current.filter((value) => value !== optionId)
      : [...current, optionId];
    return { ...answers, [questionId]: next };
  }
  return { ...answers, [questionId]: [optionId] };
}

export function setShortAnswer(
  answers: AnswerMap,
  questionId: string,
  value: string,
): AnswerMap {
  return { ...answers, [questionId]: value ? [value] : [] };
}

export function answeredCount(
  questions: Array<Pick<QuizQuestion, "id">>,
  answers: AnswerMap,
): number {
  return questions.filter((question) =>
    answers[question.id]?.some((answer) => answer.trim().length > 0),
  ).length;
}

/** 将 correctAnswer 的选项 id 映射为可读文本 */
export function optionTexts(
  question: Pick<QuizQuestion, "options">,
  optionIds: string[],
): string[] {
  return optionIds.map(
    (id) => question.options.find((option) => option.id === id)?.text ?? id,
  );
}
