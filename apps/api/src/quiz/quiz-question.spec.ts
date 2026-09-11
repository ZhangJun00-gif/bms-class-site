import { BadRequestException } from '@nestjs/common';
import { QuestionType } from '@prisma/client';
import { prepareQuestion } from './quiz-question';

const base = {
  type: QuestionType.SHORT_ANSWER,
  subjectId: 'subject-1',
  chapterIds: ['chapter-1'],
  prompt: '简述氧解离曲线右移的常见因素。',
  options: [],
  correctAnswer: ['二氧化碳分压升高、pH 降低、温度升高、2,3-DPG 增多。'],
  gradingRubric: {
    criteria: [
      { description: '答出二氧化碳分压升高或 pH 降低', points: 2 },
      { description: '答出温度升高', points: 1 },
      { description: '答出 2,3-DPG 增多', points: 1 },
    ],
  },
  explanation: '右移表示血红蛋白对氧的亲和力下降。',
};

describe('prepareQuestion', () => {
  it('derives a short-answer max score from its rubric', () => {
    expect(prepareQuestion(base)).toMatchObject({
      type: QuestionType.SHORT_ANSWER,
      maxScore: 4,
    });
  });

  it('requires a rubric for short-answer questions', () => {
    expect(() =>
      prepareQuestion({ ...base, gradingRubric: undefined }),
    ).toThrow(BadRequestException);
  });

  it('keeps the grading type separate from a custom display label', () => {
    expect(
      prepareQuestion({
        ...base,
        gradingType: QuestionType.SHORT_ANSWER,
        type: undefined,
        typeLabel: '病例分析题',
      }),
    ).toMatchObject({
      type: QuestionType.SHORT_ANSWER,
      typeLabel: '病例分析题',
    });
  });

  it('uses a stable display label when none is supplied', () => {
    expect(prepareQuestion(base)).toMatchObject({ typeLabel: '简答题' });
  });

  it('rejects conflicting grading type fields', () => {
    expect(() =>
      prepareQuestion({
        ...base,
        gradingType: QuestionType.SINGLE,
      }),
    ).toThrow('gradingType 与兼容字段 type 不一致');
  });

  it('reserves the past-paper marker for actual paper membership', () => {
    expect(() =>
      prepareQuestion({
        ...base,
        typeLabel: '往年真题',
      }),
    ).toThrow('typeLabel 不能使用保留标签');
  });

  it('rejects objective answers that do not reference an option', () => {
    expect(() =>
      prepareQuestion({
        ...base,
        type: QuestionType.SINGLE,
        options: [
          { id: 'a', text: '选项 A' },
          { id: 'b', text: '选项 B' },
        ],
        correctAnswer: ['c'],
        gradingRubric: undefined,
      }),
    ).toThrow(BadRequestException);
  });
});
