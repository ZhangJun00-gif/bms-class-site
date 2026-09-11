import { QUESTION_GENERATION_PROMPT_VERSION } from '@bmc3/ai-core';
import { AiInvocationStatus } from '@prisma/client';
import {
  assertGeneratedQuestionLanguage,
  detectQuestionGenerationLanguage,
  parseGenerationPayload,
  QUESTION_GENERATION_ENGLISH_SYSTEM_PROMPT,
  QUESTION_GENERATION_SYSTEM_PROMPT,
  questionGenerationSystemPromptFor,
  recoverExpiredQuestionInvocations,
  settleCompletionBeforeValidation,
} from './ai-question-generation';

const validQuestion = {
  chapterIds: ['chapter-1'],
  knowledgeNodeIds: ['node-1'],
  prompt: '心动周期的定义是什么？',
  options: [
    { id: 'A', text: '一次心搏的完整机械活动周期' },
    { id: 'B', text: '一分钟内的心搏次数' },
  ],
  correctAnswer: ['A'],
  gradingRubric: null,
  explanation: '依据教材中心动周期的定义。',
};

describe('AI question generation output contract', () => {
  it('accepts one strict question object', () => {
    expect(parseGenerationPayload(JSON.stringify({
      schemaVersion: QUESTION_GENERATION_PROMPT_VERSION,
      questions: [validQuestion],
    }), 1).questions).toHaveLength(1);
  });

  it.each([
    ['Markdown 代码围栏', '```json\n{}\n```'],
    ['额外顶层字段', JSON.stringify({ schemaVersion: QUESTION_GENERATION_PROMPT_VERSION, questions: [validQuestion], extra: true })],
    ['额外题目字段', JSON.stringify({ schemaVersion: QUESTION_GENERATION_PROMPT_VERSION, questions: [{ ...validQuestion, reviewStatus: 'APPROVED' }] })],
  ])('rejects %s', (_name, content) => {
    expect(() => parseGenerationPayload(content, 1)).toThrow();
  });

  it('rejects an output count different from the requested count', () => {
    expect(() => parseGenerationPayload(JSON.stringify({
      schemaVersion: QUESTION_GENERATION_PROMPT_VERSION,
      questions: [validQuestion],
    }), 2)).toThrow('与请求的 2 题不一致');
  });

  it('fills a missing server-owned schemaVersion but rejects a wrong version', () => {
    const withoutVersion = parseGenerationPayload(
      JSON.stringify({ questions: [validQuestion] }),
      1,
    );
    expect(withoutVersion.schemaVersion).toBe(QUESTION_GENERATION_PROMPT_VERSION);
    expect(() =>
      parseGenerationPayload(
        JSON.stringify({ schemaVersion: 'wrong-version', questions: [validQuestion] }),
        1,
      ),
    ).toThrow('预期');
  });

  it('settles provider usage before rejecting malformed output', async () => {
    const settle = jest.fn().mockResolvedValue(undefined);
    const completion = {
      content: '{}',
      provider: 'deepseek' as const,
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 10, outputTokens: 2, source: 'PROVIDER' as const },
      latencyMs: 100,
    };

    await expect(
      settleCompletionBeforeValidation(completion, settle, (content) =>
        parseGenerationPayload(content, 1),
      ),
    ).rejects.toThrow();
    expect(settle).toHaveBeenCalledWith(completion);
  });

  it('makes the no-thinking contract explicit in the system prompt', () => {
    expect(QUESTION_GENERATION_SYSTEM_PROMPT).toContain(
      '顶层恰好包含 schemaVersion 和 questions',
    );
    expect(QUESTION_GENERATION_SYSTEM_PROMPT).toContain(
      'questions 数量与 requestedCount 完全一致',
    );
    expect(QUESTION_GENERATION_SYSTEM_PROMPT).toContain('不得使用 Markdown');
  });

  it('uses an English prompt contract when English evidence is the majority', () => {
    const language = detectQuestionGenerationLanguage([
      {
        title: 'Amino acids and proteins',
        breadcrumb: 'Biochemistry > Amino acids and proteins',
        evidence:
          'Proteins are polymers of amino acids. A residue is an amino acid unit after incorporation into a polypeptide chain.',
      },
      {
        title: '肽键',
        breadcrumb: '生物化学 > 肽键',
        evidence: '肽键是由一个氨基酸的羧基与另一个氨基酸的氨基缩合形成的共价键。',
      },
      {
        title: 'Zwitterions and isoelectric point',
        breadcrumb: 'Biochemistry > Zwitterions and isoelectric point',
        evidence:
          'At the isoelectric point, the average net charge of the amino acid population is zero. Amino acids can exist as zwitterions.',
      },
    ]);

    expect(language).toBe('en');
    expect(
      questionGenerationSystemPromptFor(
        QUESTION_GENERATION_PROMPT_VERSION,
        language,
      ),
    ).toBe(QUESTION_GENERATION_ENGLISH_SYSTEM_PROMPT);
    expect(QUESTION_GENERATION_ENGLISH_SYSTEM_PROMPT).toContain(
      'every human-facing field must be in English',
    );
    expect(QUESTION_GENERATION_ENGLISH_SYSTEM_PROMPT).toContain(
      'questions count exactly matches requestedCount',
    );
    expect(QUESTION_GENERATION_ENGLISH_SYSTEM_PROMPT).toContain(
      'no Markdown',
    );
  });

  it('defaults mixed or Chinese evidence to the Chinese prompt contract', () => {
    const language = detectQuestionGenerationLanguage([
      {
        title: '基因表达调控',
        breadcrumb: '医学遗传学 > 基因表达调控',
        evidence:
          'DNA 上的 promoter 和 enhancer 可通过结合转录因子调控基因表达。',
      },
      {
        title: 'PCR 的基本原理',
        breadcrumb: '分子生物学 > PCR 的基本原理',
        evidence: 'PCR 通过变性、退火和延伸三个步骤循环扩增目标 DNA 片段。',
      },
    ]);

    expect(language).toBe('zh-CN');
    expect(
      questionGenerationSystemPromptFor(
        QUESTION_GENERATION_PROMPT_VERSION,
        language,
      ),
    ).toBe(QUESTION_GENERATION_SYSTEM_PROMPT);
  });

  it('rejects Chinese human-facing text for an English textbook task', () => {
    expect(() =>
      assertGeneratedQuestionLanguage([validQuestion], 'en'),
    ).toThrow('must use English');
    expect(() =>
      assertGeneratedQuestionLanguage(
        [
          {
            ...validQuestion,
            prompt: 'What is an amino acid residue?',
            options: [
              { id: 'A', text: 'A free amino acid molecule' },
              { id: 'B', text: 'An amino acid unit in a peptide chain' },
            ],
            explanation: 'The evidence defines a residue after chain incorporation.',
          },
        ],
        'en',
      ),
    ).not.toThrow();
  });

  it('reclaims expired generation invocations and their concurrency slot', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const executeRaw = jest.fn().mockResolvedValue(1);
    const transaction = {
      aiInvocation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'invocation-1',
            reservedTokens: 8000,
            createdAt: new Date('2026-07-28T00:00:00.000Z'),
          },
        ]),
        updateMany,
      },
      $executeRaw: executeRaw,
    };

    await recoverExpiredQuestionInvocations(
      transaction as never,
      new Date('2026-07-28T00:10:00.000Z'),
    );

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AiInvocationStatus.EXPIRED,
          reservedTokens: 0,
        }),
      }),
    );
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});
