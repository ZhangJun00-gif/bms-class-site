import {
  DailyPersonalizationValidationError,
  parseDailyPersonalizationOutput,
  validateDailyPersonalizationOutput,
  type DailyPersonalizationOutput,
} from './output';
import { buildTestPayload } from './test-fixture';

function validOutput(): DailyPersonalizationOutput {
  return {
    schemaVersion: 'daily-personalization-v1',
    learningSummary: {
      headline: '近期学习状态仍可提升',
      overview: '近期基础题表现较稳定，但跨膜转运和静息电位仍需要按计划复习。',
      dataQuality: 'SUFFICIENT',
      strengths: [
        {
          knowledgeAlias: 'K001',
          text: '细胞膜基础概念已有稳定表现。',
          evidenceRefs: ['S001'],
        },
      ],
      priorities: [
        {
          knowledgeAlias: 'K002',
          text: '跨膜转运已经逾期，需要优先复习。',
          evidenceRefs: ['S002'],
        },
      ],
    },
    selectedKnowledge: [
      {
        knowledgeAlias: 'K002',
        reason: '该知识点已经逾期，需要优先复习。',
        evidenceRefs: ['S002'],
      },
      {
        knowledgeAlias: 'K003',
        reason: '该知识点已到复习时间。',
        evidenceRefs: ['S003'],
      },
      {
        knowledgeAlias: 'K001',
        reason: '通过练习维持当前稳定表现。',
        evidenceRefs: ['S001'],
      },
    ],
    selectedQuestions: [
      {
        questionAlias: 'Q002',
        reason: '该题属于近期错误，需要优先复习。',
        evidenceRefs: ['S201'],
      },
      {
        questionAlias: 'Q001',
        reason: '该题用于巩固细胞膜基础概念。',
        evidenceRefs: ['S001'],
      },
      {
        questionAlias: 'Q004',
        reason: '该题用于复习跨膜转运。',
        evidenceRefs: ['S002'],
      },
      {
        questionAlias: 'Q005',
        reason: '该题用于复习静息电位。',
        evidenceRefs: ['S003'],
      },
    ],
    suggestionEvaluation: {
      status: 'NONE',
      message: '今日没有待处理的学习建议。',
    },
  };
}

describe('strict daily personalization output', () => {
  it('accepts one complete output within all aliases and dynamic ranges', () => {
    const payload = buildTestPayload();
    expect(
      parseDailyPersonalizationOutput(JSON.stringify(validOutput()), payload),
    ).toEqual(validOutput());
  });

  it('rejects code fences, invalid JSON, and additional properties', () => {
    const payload = buildTestPayload();
    expect(() =>
      parseDailyPersonalizationOutput(
        `\`\`\`json\n${JSON.stringify(validOutput())}\n\`\`\``,
        payload,
      ),
    ).toThrow(DailyPersonalizationValidationError);
    expect(() => parseDailyPersonalizationOutput('{', payload)).toThrow(
      'model output must be one JSON object',
    );
    expect(() =>
      validateDailyPersonalizationOutput(
        { ...validOutput(), extra: true },
        payload,
      ),
    ).toThrow('strict response schema');
  });

  it('rejects missing mandatory questions and duplicate aliases', () => {
    const payload = buildTestPayload();
    const missing = validOutput();
    missing.selectedQuestions[1] = {
      questionAlias: 'Q003',
      reason: '该题用于补充复习。',
      evidenceRefs: ['S003'],
    };
    expect(() => validateDailyPersonalizationOutput(missing, payload)).toThrow(
      'omitted a mandatory question',
    );

    const duplicate = validOutput();
    duplicate.selectedQuestions[3] = { ...duplicate.selectedQuestions[2]! };
    expect(() => validateDailyPersonalizationOutput(duplicate, payload)).toThrow(
      'aliases must be unique',
    );
  });

  it('rejects more than one personalized short-answer question', () => {
    const payload = buildTestPayload();
    const output = validOutput();
    output.selectedQuestions[3] = {
      questionAlias: 'Q003',
      reason: '该题用于复习静息电位。',
      evidenceRefs: ['S003'],
    };
    expect(() => validateDailyPersonalizationOutput(output, payload)).toThrow(
      'too many short-answer questions',
    );
  });

  it('rejects fixed aliases, unknown current aliases, and old evidence aliases', () => {
    const payload = buildTestPayload();
    const fixed = validOutput();
    fixed.selectedQuestions[0]!.reason = '返回 F001 固定题。';
    expect(() => validateDailyPersonalizationOutput(fixed, payload)).toThrow(
      'fixed question aliases',
    );

    const unknownQuestion = validOutput();
    unknownQuestion.selectedQuestions[3]!.questionAlias = 'Q999';
    expect(() =>
      validateDailyPersonalizationOutput(unknownQuestion, payload),
    ).toThrow('outside the whitelist');

    const oldEvidence = validOutput();
    oldEvidence.learningSummary.priorities[0]!.evidenceRefs = ['S999'];
    expect(() => validateDailyPersonalizationOutput(oldEvidence, payload)).toThrow(
      'current signal aliases',
    );
  });

  it('rejects unsafe text, non-Chinese narration, and NONE strengths', () => {
    const payload = buildTestPayload();
    const markdown = validOutput();
    markdown.learningSummary.headline = '[状态](https://example.invalid)';
    expect(() => validateDailyPersonalizationOutput(markdown, payload)).toThrow(
      'Markdown links',
    );

    const english = validOutput();
    english.suggestionEvaluation.message = 'No suggestion.';
    expect(() => validateDailyPersonalizationOutput(english, payload)).toThrow(
      'Simplified Chinese context',
    );

    const none = validOutput();
    none.learningSummary.dataQuality = 'NONE';
    expect(() => validateDailyPersonalizationOutput(none, payload)).toThrow(
      'strengths must be empty',
    );
  });

  it('requires Chinese context while allowing bounded medical terminology', () => {
    const payload = buildTestPayload();
    const disguisedEnglish = validOutput();
    disguisedEnglish.suggestionEvaluation.message =
      '中 This is otherwise a complete English response with no Chinese context.';
    expect(() =>
      validateDailyPersonalizationOutput(disguisedEnglish, payload),
    ).toThrow('Simplified Chinese context');

    const terminology = validOutput();
    terminology.learningSummary.overview =
      'Na+/K+-ATPase 与 ATP 水解相关，当前仍需结合膜电位继续复习。';
    expect(validateDailyPersonalizationOutput(terminology, payload)).toEqual(
      terminology,
    );
  });
});
