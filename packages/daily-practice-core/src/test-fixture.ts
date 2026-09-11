import {
  buildDailyPersonalizationPayload,
  type BuildDailyPersonalizationPayloadInput,
  type DailyPersonalizationPayload,
} from './prompt';

export function buildTestPayload(
  mutate?: (input: BuildDailyPersonalizationPayloadInput) => void,
): DailyPersonalizationPayload {
  const input: BuildDailyPersonalizationPayloadInput = {
    practiceDate: '2026-07-28',
    inputPolicy: {
      knowledgeCount: { minimum: 3, maximum: 3 },
      questionCount: { minimum: 4, maximum: 4 },
      mandatoryQuestionAliases: ['Q002', 'Q001'],
      fixedQuestionCount: 1,
      fixedQuestionAliases: ['F001'],
      allowedKnowledgeAliases: ['K001', 'K002', 'K003'],
      allowedQuestionAliases: ['Q001', 'Q002', 'Q003', 'Q004', 'Q005'],
      allowedSignalAliases: ['S001', 'S002', 'S003', 'S201'],
    },
    profile: {
      dataQuality: 'SUFFICIENT',
      overall: {
        submittedAttempts30d: 6,
        answeredQuestions30d: 30,
        accuracyBps30d: 7_500,
        activeDays30d: 5,
        overdueKnowledgeCount: 1,
        overdueChapterCount: 1,
      },
      knowledgeSignals: [
        {
          signalAlias: 'S001',
          knowledgeAlias: 'K001',
          masteryBps: 9_000,
          attemptCount: 5,
          wrongCount: 1,
          correctStreak: 3,
          lastScoreBps: 10_000,
          daysSincePractice: 2,
          reviewDue: 'NOT_DUE',
          missingRubricPoints: [],
        },
        {
          signalAlias: 'S002',
          knowledgeAlias: 'K002',
          masteryBps: 5_000,
          attemptCount: 3,
          wrongCount: 2,
          correctStreak: 0,
          lastScoreBps: 4_000,
          daysSincePractice: 5,
          reviewDue: 'OVERDUE',
          missingRubricPoints: ['说明关键机制'],
        },
        {
          signalAlias: 'S003',
          knowledgeAlias: 'K003',
          masteryBps: 7_000,
          attemptCount: 2,
          wrongCount: 1,
          correctStreak: 0,
          lastScoreBps: 7_000,
          daysSincePractice: 3,
          reviewDue: 'DUE',
          missingRubricPoints: [],
        },
      ],
      chapterSignals: [],
      recentWrongSignals: [
        {
          signalAlias: 'S201',
          questionAlias: 'Q002',
          chapterAliases: ['C001'],
          gradingType: 'SHORT_ANSWER',
          wrongCount: 2,
          lastScoreBps: 4_000,
          daysSinceWrong: 1,
          missingRubricPoints: ['说明关键机制'],
        },
      ],
    },
    previousLearningSummary: null,
    candidateKnowledge: [
      {
        knowledgeAlias: 'K001',
        subjectName: '生理学',
        chapterAliases: ['C001'],
        title: '细胞膜',
        breadcrumb: '生理学 > 细胞膜',
        firstTaughtDate: '2026-07-01',
        reviewPriority: 40,
        eligibleQuestionCount: 2,
      },
      {
        knowledgeAlias: 'K002',
        subjectName: '生理学',
        chapterAliases: ['C001'],
        title: '跨膜转运',
        breadcrumb: '生理学 > 跨膜转运',
        firstTaughtDate: '2026-07-02',
        reviewPriority: 90,
        eligibleQuestionCount: 2,
      },
      {
        knowledgeAlias: 'K003',
        subjectName: '生理学',
        chapterAliases: ['C002'],
        title: '静息电位',
        breadcrumb: '生理学 > 静息电位',
        firstTaughtDate: '2026-07-03',
        reviewPriority: 70,
        eligibleQuestionCount: 1,
      },
    ],
    candidateQuestions: [
      question('Q001', ['K001'], 'SINGLE', 80),
      question('Q002', ['K002'], 'SHORT_ANSWER', 100),
      question('Q003', ['K003'], 'SHORT_ANSWER', 70),
      question('Q004', ['K002'], 'MULTIPLE', 90),
      question('Q005', ['K003'], 'TRUE_FALSE', 60),
    ],
    fixedQuestions: [
      {
        fixedQuestionAlias: 'F001',
        chapterAliases: ['C001'],
        subjectName: '生理学',
        gradingType: 'SINGLE',
        typeLabel: '单选题',
        promptExcerpt: '固定附加题题干',
        adminOrder: 1,
      },
    ],
    suggestion: {
      userSuggestion: null,
      adminSuggestion: null,
    },
  };
  mutate?.(input);
  return buildDailyPersonalizationPayload(input);
}

function question(
  questionAlias: string,
  knowledgeAliases: string[],
  gradingType: 'SINGLE' | 'MULTIPLE' | 'TRUE_FALSE' | 'SHORT_ANSWER',
  priorityScore: number,
) {
  return {
    questionAlias,
    knowledgeAliases,
    chapterAliases: ['C001'],
    gradingType,
    typeLabel: gradingType === 'SHORT_ANSWER' ? '简答题' : '选择题',
    promptExcerpt: `${questionAlias} 的课程题干`,
    priorityScore,
    daysSinceLastSeen: null,
  };
}
