import { Prisma, PrismaClient } from '@prisma/client';

interface CountRow {
  count: bigint;
}

interface LegacyLabelRow {
  source: string;
  id: string;
  subject: string | null;
  chapter: string | null;
}

interface SubjectNameRow {
  name: string;
}

interface ChapterNameRow {
  subject: string;
  chapter: string;
}

const prisma = new PrismaClient();

async function count(query: Prisma.Sql) {
  const [row] = await prisma.$queryRaw<CountRow[]>(query);
  return Number(row?.count ?? 0n);
}

async function hasColumn(tableName: string, columnName: string) {
  return (
    (await count(Prisma.sql`
      SELECT COUNT(*) AS count
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${tableName}
        AND COLUMN_NAME = ${columnName}
    `)) === 1
  );
}

async function hasTable(tableName: string) {
  return (
    (await count(Prisma.sql`
      SELECT COUNT(*) AS count
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${tableName}
    `)) === 1
  );
}

function ambiguousGroups(values: Array<{ scope: string; value: string }>) {
  const groups = new Map<string, Set<string>>();
  for (const { scope, value } of values) {
    const key = `${scope}\u0000${value.trim().toLocaleLowerCase('zh-CN')}`;
    const variants = groups.get(key) ?? new Set<string>();
    variants.add(value);
    groups.set(key, variants);
  }
  return [...groups.entries()]
    .filter(([, variants]) => variants.size > 1)
    .map(([key, variants]) => ({
      scope: key.split('\u0000', 1)[0],
      variants: [...variants].sort(),
    }));
}

async function main() {
  const [hasQuestionSubjectId, hasPaperSubjectId, hasChapterLinks] =
    await Promise.all([
      hasColumn('QuizQuestion', 'subjectId'),
      hasColumn('QuizPaper', 'subjectId'),
      hasTable('QuizQuestionChapter'),
    ]);
  const [
    questionCount,
    paperCount,
    invalidLegacyLabels,
    legacyPaperQuestionMismatches,
    subjectNames,
    chapterNames,
  ] = await Promise.all([
    count(Prisma.sql`SELECT COUNT(*) AS count FROM QuizQuestion`),
    count(Prisma.sql`SELECT COUNT(*) AS count FROM QuizPaper`),
    prisma.$queryRaw<LegacyLabelRow[]>(Prisma.sql`
      SELECT 'question' AS source, id, subject, chapter
      FROM QuizQuestion
      WHERE (subject IS NOT NULL AND (TRIM(subject) = '' OR CHAR_LENGTH(subject) > 100 OR BINARY subject <> BINARY TRIM(subject)))
         OR (chapter IS NOT NULL AND (TRIM(chapter) = '' OR CHAR_LENGTH(chapter) > 100 OR BINARY chapter <> BINARY TRIM(chapter)))
      UNION ALL
      SELECT 'paper' AS source, id, subject, NULL AS chapter
      FROM QuizPaper
      WHERE subject IS NOT NULL AND (TRIM(subject) = '' OR CHAR_LENGTH(subject) > 100 OR BINARY subject <> BINARY TRIM(subject))
      LIMIT 200
    `),
    count(Prisma.sql`
      SELECT COUNT(*) AS count
      FROM QuizQuestion AS question
      INNER JOIN QuizPaper AS paper ON paper.id = question.pastPaperId
      WHERE question.subject IS NOT NULL
        AND paper.subject IS NOT NULL
        AND BINARY question.subject <> BINARY paper.subject
    `),
    prisma.$queryRaw<SubjectNameRow[]>(Prisma.sql`
      SELECT name FROM KnowledgeSubject
      UNION
      SELECT subject AS name FROM QuizQuestion WHERE subject IS NOT NULL
      UNION
      SELECT subject AS name FROM QuizPaper WHERE subject IS NOT NULL
    `),
    prisma.$queryRaw<ChapterNameRow[]>(Prisma.sql`
      SELECT DISTINCT subject, chapter
      FROM QuizQuestion
      WHERE subject IS NOT NULL AND chapter IS NOT NULL
    `),
  ]);

  const phase1SchemaPresent =
    hasQuestionSubjectId && hasPaperSubjectId && hasChapterLinks;
  const [
    chapterLinkCount,
    questionsWithoutSubjects,
    papersWithoutSubjects,
    questionsWithoutChapters,
    crossSubjectChapterLinks,
    paperQuestionSubjectMismatches,
  ] = phase1SchemaPresent
    ? await Promise.all([
        count(Prisma.sql`SELECT COUNT(*) AS count FROM QuizQuestionChapter`),
        count(Prisma.sql`SELECT COUNT(*) AS count FROM QuizQuestion WHERE subjectId IS NULL`),
        count(Prisma.sql`SELECT COUNT(*) AS count FROM QuizPaper WHERE subjectId IS NULL`),
        count(Prisma.sql`
          SELECT COUNT(*) AS count
          FROM QuizQuestion AS question
          LEFT JOIN QuizQuestionChapter AS link ON link.questionId = question.id
          WHERE link.questionId IS NULL
        `),
        count(Prisma.sql`
          SELECT COUNT(*) AS count
          FROM QuizQuestionChapter AS link
          INNER JOIN QuizQuestion AS question ON question.id = link.questionId
          INNER JOIN SubjectChapter AS chapter ON chapter.id = link.chapterId
          WHERE question.subjectId <> chapter.subjectId
        `),
        count(Prisma.sql`
          SELECT COUNT(*) AS count
          FROM QuizQuestion AS question
          INNER JOIN QuizPaper AS paper ON paper.id = question.pastPaperId
          WHERE question.subjectId <> paper.subjectId
        `),
      ])
    : [null, null, null, null, null, null];
  const invariants = phase1SchemaPresent
    ? {
        questionsWithoutSubjects,
        papersWithoutSubjects,
        questionsWithoutChapters,
        crossSubjectChapterLinks,
        paperQuestionSubjectMismatches,
      }
    : null;
  const ambiguousSubjects = ambiguousGroups(
    subjectNames.map(({ name }) => ({ scope: 'subject', value: name })),
  );
  const ambiguousChapters = ambiguousGroups(
    chapterNames.map(({ subject, chapter }) => ({
      scope: subject,
      value: chapter,
    })),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    phase1SchemaPresent,
    totals: { questionCount, paperCount, chapterLinkCount },
    legacy: {
      invalidLabels: invalidLegacyLabels,
      paperQuestionSubjectMismatches: legacyPaperQuestionMismatches,
      ambiguousSubjects,
      ambiguousChapters,
    },
    invariants,
    passed:
      invalidLegacyLabels.length === 0 &&
      legacyPaperQuestionMismatches === 0 &&
      ambiguousSubjects.length === 0 &&
      ambiguousChapters.length === 0 &&
      (!invariants || Object.values(invariants).every((value) => value === 0)),
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
