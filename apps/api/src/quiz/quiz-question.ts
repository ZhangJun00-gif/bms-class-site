import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_QUESTION_TYPE_LABELS,
  QuizValidationError,
  parseGradingRubric as parseCoreGradingRubric,
  prepareQuestion as prepareCoreQuestion,
  type GradingCriterion,
  type GradingRubric,
  type PreparedQuestion,
  type QuestionInput,
  type QuizOption,
} from '@bmc3/quiz-core';

export {
  DEFAULT_QUESTION_TYPE_LABELS,
  type GradingCriterion,
  type GradingRubric,
  type PreparedQuestion,
  type QuestionInput,
  type QuizOption,
};

function mapValidationError(error: unknown): never {
  if (error instanceof QuizValidationError) {
    throw new BadRequestException(error.message);
  }
  throw error;
}

export function parseGradingRubric(
  value: unknown,
  context = '题目',
): GradingRubric {
  try {
    return parseCoreGradingRubric(value, context);
  } catch (error) {
    return mapValidationError(error);
  }
}

export function prepareQuestion(
  input: QuestionInput,
  context = '题目',
): PreparedQuestion {
  try {
    return prepareCoreQuestion(input, context);
  } catch (error) {
    return mapValidationError(error);
  }
}
