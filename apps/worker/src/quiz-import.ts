import {
  CosMediaStore,
  compressImage,
  createMediaObjectKey,
  inspectImage,
  readMediaCosConfig,
  type SupportedImageFormat,
} from "@bmc3/media-core";
import {
  QuizValidationError,
  importedChapterSlug,
  prepareQuestion,
  type PreparedQuestion,
} from "@bmc3/quiz-core";
import {
  Prisma,
  PrismaClient,
  ImportSourceCleanupStatus,
  QuizImportAssetStatus,
  QuizImportFileType,
  QuizImportIssueSeverity,
  QuizImportMode,
  QuizImportStatus,
  QuizQuestionOrigin,
  QuizQuestionReviewStatus,
  type QuizImportJob,
} from "@prisma/client";
import { parse } from "csv-parse/sync";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  localObjectPath,
  removeLocalObject,
  uploadsRoot,
} from "./local-storage";
import {
  MAX_CSV_BYTES,
  MAX_IMAGE_BYTES,
  QuizImportArchiveError,
  forEachZipImage,
  hashFileSha256,
  inspectQuizZip,
  readZipEntry,
} from "./quiz-import-zip";

const MAX_QUESTIONS = 5_000;
const MAX_IMAGES_PER_QUESTION = 5;
const MAX_ISSUES_PER_BATCH = 1_000;
const IMPORT_LEASE_MS = readLeaseMs();
const IMPORT_HEARTBEAT_MS = Math.max(
  10_000,
  Math.min(60_000, Math.floor(IMPORT_LEASE_MS / 3)),
);
const ALLOWED_HEADERS = new Set([
  "gradingType",
  "type",
  "typeLabel",
  "subject",
  "chapters",
  "chapter",
  "category",
  "prompt",
  "options",
  "correctAnswer",
  "gradingRubric",
  "explanation",
  "images",
  "paperOrder",
]);
const IMAGE_EXTENSION_FORMAT: Record<string, SupportedImageFormat> = {
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
  ".webp": "webp",
};

type IssueInput = Omit<Prisma.QuizImportIssueCreateManyInput, "importId">;

interface ImageReference {
  rowNumber: number;
  filePath: string;
  caption: string;
  sortOrder: number;
}

interface ParsedRow {
  rowNumber: number;
  subjectName: string;
  chapterNames: string[];
  gradingType: unknown;
  typeLabel?: unknown;
  category?: unknown;
  prompt: unknown;
  options: unknown;
  correctAnswer: unknown;
  gradingRubric?: unknown;
  explanation: unknown;
  paperOrder?: number;
  images: ImageReference[];
}

interface ResolvedRow extends ParsedRow {
  question: PreparedQuestion;
}

interface ImportAnalysis {
  rows: ParsedRow[];
  resolvedRows: ResolvedRow[];
  issues: IssueInput[];
  imageReferences: ImageReference[];
  imagePaths: string[];
  summary: Prisma.InputJsonObject;
}

export class ConfirmedImportValidationError extends Error {
  constructor() {
    super("确认后的题目包不再满足导入条件");
    this.name = "ConfirmedImportValidationError";
  }
}

function issue(
  severity: QuizImportIssueSeverity,
  code: string,
  message: string,
  detail: Partial<Pick<IssueInput, "rowNumber" | "filePath" | "field">> = {},
): IssueInput {
  return { severity, code, message: message.slice(0, 500), ...detail };
}

function parseJsonColumn(
  value: string | undefined,
  fallback: string,
  rowNumber: number,
  field: string,
  issues: IssueInput[],
) {
  try {
    return JSON.parse(value || fallback) as unknown;
  } catch {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_INVALID_JSON",
        `第 ${rowNumber} 行的 ${field} 不是有效 JSON`,
        { rowNumber, field },
      ),
    );
    return undefined;
  }
}

function decodeUtf8(buffer: Buffer, issues: IssueInput[]) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_NOT_UTF8",
        "questions.csv 必须使用 UTF-8 编码",
        { filePath: "questions.csv" },
      ),
    );
    return null;
  }
}

function parseCsvRows(buffer: Buffer, issues: IssueInput[]) {
  const text = decodeUtf8(buffer, issues);
  if (text === null)
    return { rows: [] as Record<string, string>[], headers: [] as string[] };
  let headers: string[] = [];
  let rows: Record<string, string>[];
  try {
    rows = parse(text, {
      bom: true,
      columns(input: string[]) {
        headers = input.map((header) => header.trim());
        return headers;
      },
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
    }) as Record<string, string>[];
  } catch {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_INVALID_FORMAT",
        "questions.csv 格式无效或行列数量不一致",
        { filePath: "questions.csv" },
      ),
    );
    return { rows: [], headers };
  }
  const duplicates = headers.filter(
    (header, index) => headers.indexOf(header) !== index,
  );
  for (const header of [...new Set(duplicates)]) {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_DUPLICATE_HEADER",
        `CSV 表头重复：${header}`,
        {
          filePath: "questions.csv",
          field: header,
        },
      ),
    );
  }
  for (const header of headers) {
    if (!ALLOWED_HEADERS.has(header)) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "CSV_UNKNOWN_HEADER",
          `CSV 包含未知列：${header}`,
          {
            filePath: "questions.csv",
            field: header,
          },
        ),
      );
    }
  }
  for (const required of ["subject", "prompt", "options", "correctAnswer"]) {
    if (!headers.includes(required)) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "CSV_MISSING_HEADER",
          `CSV 缺少必需列：${required}`,
          {
            filePath: "questions.csv",
            field: required,
          },
        ),
      );
    }
  }
  if (!headers.includes("gradingType") && !headers.includes("type")) {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_MISSING_HEADER",
        "CSV 缺少 gradingType 列",
      ),
    );
  }
  if (!headers.includes("chapters") && !headers.includes("chapter")) {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_MISSING_HEADER",
        "CSV 缺少 chapters 列",
      ),
    );
  }
  if (!rows.length) {
    issues.push(
      issue(QuizImportIssueSeverity.ERROR, "CSV_EMPTY", "CSV 文件中没有题目"),
    );
  } else if (rows.length > MAX_QUESTIONS) {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_ROW_LIMIT",
        "单次最多导入 5000 道题目",
      ),
    );
  }
  return { rows: rows.slice(0, MAX_QUESTIONS), headers };
}

function parseImages(
  value: string | undefined,
  rowNumber: number,
  fileType: QuizImportFileType,
  issues: IssueInput[],
) {
  if (!value?.trim()) return [];
  if (fileType === QuizImportFileType.CSV) {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_IMAGES_REQUIRE_ZIP",
        "纯 CSV 不能引用图片，请上传 ZIP 题目包",
        {
          rowNumber,
          field: "images",
        },
      ),
    );
    return [];
  }
  const input = parseJsonColumn(value, "[]", rowNumber, "images", issues);
  if (!Array.isArray(input)) {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_INVALID_IMAGES",
        `第 ${rowNumber} 行的 images 必须是数组`,
        {
          rowNumber,
          field: "images",
        },
      ),
    );
    return [];
  }
  if (input.length > MAX_IMAGES_PER_QUESTION) {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_IMAGE_LIMIT",
        `第 ${rowNumber} 行最多引用 5 张图片`,
        {
          rowNumber,
          field: "images",
        },
      ),
    );
  }
  const result: ImageReference[] = [];
  input.slice(0, MAX_IMAGES_PER_QUESTION).forEach((item, sortOrder) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "CSV_INVALID_IMAGE",
          `第 ${rowNumber} 行第 ${sortOrder + 1} 个图片引用格式无效`,
          {
            rowNumber,
            field: "images",
          },
        ),
      );
      return;
    }
    const record = item as Record<string, unknown>;
    const unknown = Object.keys(record).filter(
      (key) => !["file", "caption"].includes(key),
    );
    if (unknown.length) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "CSV_UNKNOWN_IMAGE_FIELD",
          `图片引用包含未知字段：${unknown.join(", ")}`,
          {
            rowNumber,
            field: "images",
          },
        ),
      );
    }
    const filePath =
      typeof record.file === "string"
        ? record.file.normalize("NFC").trim()
        : "";
    const caption =
      record.caption === undefined
        ? ""
        : typeof record.caption === "string"
          ? record.caption.trim()
          : "";
    if (
      !/^images\/[^/]+$/.test(filePath) ||
      !IMAGE_EXTENSION_FORMAT[extname(filePath).toLowerCase()]
    ) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "CSV_INVALID_IMAGE_PATH",
          `第 ${rowNumber} 行的图片路径无效`,
          {
            rowNumber,
            filePath: filePath || undefined,
            field: "images",
          },
        ),
      );
      return;
    }
    if (record.caption !== undefined && typeof record.caption !== "string") {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "CSV_INVALID_CAPTION",
          "图片说明必须是字符串",
          { rowNumber, filePath, field: "images" },
        ),
      );
      return;
    }
    if (caption.length > 300) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "CSV_CAPTION_TOO_LONG",
          "图片说明不能超过 300 字",
          { rowNumber, filePath, field: "images" },
        ),
      );
      return;
    }
    result.push({ rowNumber, filePath, caption, sortOrder });
  });
  return result;
}

function parseRows(
  records: Record<string, string>[],
  fileType: QuizImportFileType,
  mode: QuizImportMode,
  issues: IssueInput[],
) {
  const rows: ParsedRow[] = [];
  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const rowIssuesBefore = issues.length;
    if (record.chapter?.trim() && record.chapters?.trim()) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "CSV_CHAPTER_COLUMNS_CONFLICT",
          `第 ${rowNumber} 行不能同时提供 chapter 和 chapters`,
          { rowNumber, field: "chapters" },
        ),
      );
    }
    const chaptersValue = record.chapters?.trim()
      ? parseJsonColumn(record.chapters, "[]", rowNumber, "chapters", issues)
      : [record.chapter];
    let chapterNames: string[] = [];
    if (!Array.isArray(chaptersValue)) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "CSV_INVALID_CHAPTERS",
          `第 ${rowNumber} 行的 chapters 必须是数组`,
          { rowNumber, field: "chapters" },
        ),
      );
    } else {
      chapterNames = chaptersValue.map((value) =>
        typeof value === "string" ? value.trim() : "",
      );
      if (
        chapterNames.length < 1 ||
        chapterNames.length > 20 ||
        chapterNames.some((name) => !name || name.length > 100)
      ) {
        issues.push(
          issue(
            QuizImportIssueSeverity.ERROR,
            "CSV_INVALID_CHAPTERS",
            `第 ${rowNumber} 行必须包含 1-20 个有效章节名称`,
            { rowNumber, field: "chapters" },
          ),
        );
      }
      if (new Set(chapterNames).size !== chapterNames.length) {
        issues.push(
          issue(
            QuizImportIssueSeverity.ERROR,
            "CSV_DUPLICATE_CHAPTER",
            `第 ${rowNumber} 行的 chapters 不能重复`,
            { rowNumber, field: "chapters" },
          ),
        );
      }
    }
    const subjectName = record.subject?.trim() ?? "";
    if (!subjectName || subjectName.length > 100) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "CSV_INVALID_SUBJECT",
          `第 ${rowNumber} 行的 subject 长度必须在 1-100 个字符之间`,
          { rowNumber, field: "subject" },
        ),
      );
    }
    const options = parseJsonColumn(
      record.options,
      "[]",
      rowNumber,
      "options",
      issues,
    );
    const correctAnswer = parseJsonColumn(
      record.correctAnswer,
      "[]",
      rowNumber,
      "correctAnswer",
      issues,
    );
    const gradingRubric = record.gradingRubric?.trim()
      ? parseJsonColumn(
          record.gradingRubric,
          "{}",
          rowNumber,
          "gradingRubric",
          issues,
        )
      : undefined;
    let paperOrder: number | undefined;
    if (record.paperOrder?.trim()) {
      paperOrder = Number(record.paperOrder);
      if (
        !Number.isInteger(paperOrder) ||
        paperOrder < 1 ||
        paperOrder > 10_000
      ) {
        issues.push(
          issue(
            QuizImportIssueSeverity.ERROR,
            "CSV_INVALID_PAPER_ORDER",
            `第 ${rowNumber} 行的 paperOrder 必须是 1-10000 的整数`,
            { rowNumber, field: "paperOrder" },
          ),
        );
        paperOrder = undefined;
      }
      if (mode === QuizImportMode.BANK) {
        issues.push(
          issue(
            QuizImportIssueSeverity.ERROR,
            "CSV_PAPER_ORDER_WITHOUT_PAPER",
            "paperOrder 只能用于往年真题导入",
            { rowNumber, field: "paperOrder" },
          ),
        );
      }
    }
    const images = parseImages(record.images, rowNumber, fileType, issues);
    if (
      issues.length !== rowIssuesBefore &&
      (options === undefined || correctAnswer === undefined)
    )
      return;
    rows.push({
      rowNumber,
      subjectName,
      chapterNames,
      gradingType: record.gradingType || record.type,
      typeLabel: record.typeLabel || undefined,
      category: record.category || undefined,
      prompt: record.prompt ?? "",
      options,
      correctAnswer,
      gradingRubric,
      explanation: record.explanation ?? "",
      paperOrder,
      images,
    });
  });
  const specifiedOrders = rows.filter((row) => row.paperOrder !== undefined);
  if (specifiedOrders.length && specifiedOrders.length !== rows.length) {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_PARTIAL_PAPER_ORDER",
        "paperOrder 必须全部填写或全部省略",
      ),
    );
  }
  const orderValues = specifiedOrders.map((row) => row.paperOrder!);
  if (new Set(orderValues).size !== orderValues.length) {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "CSV_DUPLICATE_PAPER_ORDER",
        "CSV 中的 paperOrder 不能重复",
      ),
    );
  }
  return rows;
}

async function validateTaxonomyAndQuestions(
  prisma: PrismaClient,
  job: QuizImportJob,
  rows: ParsedRow[],
  issues: IssueInput[],
) {
  const subjectNames = [
    ...new Set(rows.map((row) => row.subjectName).filter(Boolean)),
  ];
  const subjects = await prisma.subject.findMany({
    where: { name: { in: subjectNames } },
    select: { id: true, name: true, active: true },
  });
  const subjectByName = new Map(
    subjects.map((subject) => [subject.name, subject]),
  );
  const chapterNames = [...new Set(rows.flatMap((row) => row.chapterNames))];
  const chapters = await prisma.subjectChapter.findMany({
    where: {
      subjectId: { in: subjects.map((subject) => subject.id) },
      name: { in: chapterNames },
    },
    select: { id: true, subjectId: true, name: true, active: true },
  });
  const chapterByKey = new Map(
    chapters.map((chapter) => [
      `${chapter.subjectId}\u0000${chapter.name}`,
      chapter,
    ]),
  );
  const resolvedRows: ResolvedRow[] = [];
  for (const row of rows) {
    const before = issues.length;
    const subject = subjectByName.get(row.subjectName);
    if (!subject?.active) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "SUBJECT_NOT_ACTIVE",
          `第 ${row.rowNumber} 行的学科“${row.subjectName}”不存在或已停用`,
          { rowNumber: row.rowNumber, field: "subject" },
        ),
      );
      continue;
    }
    const chapterIds: string[] = [];
    for (const name of row.chapterNames) {
      const chapter = chapterByKey.get(`${subject.id}\u0000${name}`);
      if (chapter?.active === false) {
        issues.push(
          issue(
            QuizImportIssueSeverity.ERROR,
            "CHAPTER_INACTIVE",
            `第 ${row.rowNumber} 行的章节“${name}”已停用`,
            { rowNumber: row.rowNumber, field: "chapters" },
          ),
        );
      } else if (!chapter && !job.createMissingChapters) {
        issues.push(
          issue(
            QuizImportIssueSeverity.ERROR,
            "CHAPTER_NOT_FOUND",
            `第 ${row.rowNumber} 行的章节“${name}”不存在或不属于“${subject.name}”`,
            { rowNumber: row.rowNumber, field: "chapters" },
          ),
        );
      } else {
        chapterIds.push(
          chapter?.id ?? `planned-${importedChapterSlug(subject.id, name)}`,
        );
      }
    }
    if (issues.length !== before) continue;
    try {
      const question = prepareQuestion(
        {
          gradingType: row.gradingType,
          typeLabel: row.typeLabel,
          subjectId: subject.id,
          chapterIds,
          category: row.category,
          prompt: row.prompt,
          options: row.options,
          correctAnswer: row.correctAnswer,
          gradingRubric: row.gradingRubric,
          explanation: row.explanation,
        },
        `第 ${row.rowNumber} 行`,
      );
      resolvedRows.push({ ...row, question });
    } catch (error) {
      const message =
        error instanceof QuizValidationError ? error.message : "题目格式无效";
      issues.push(
        issue(QuizImportIssueSeverity.ERROR, "QUESTION_INVALID", message, {
          rowNumber: row.rowNumber,
        }),
      );
    }
  }
  await validatePaper(prisma, job, resolvedRows, issues);
  return resolvedRows;
}

async function validatePaper(
  prisma: PrismaClient,
  job: QuizImportJob,
  rows: ResolvedRow[],
  issues: IssueInput[],
) {
  if (job.mode === QuizImportMode.BANK) return;
  let subjectId: string | null = null;
  if (job.mode === QuizImportMode.NEW_PAPER) {
    const subject = job.targetSubjectId
      ? await prisma.subject.findFirst({
          where: { id: job.targetSubjectId, active: true },
          select: { id: true },
        })
      : null;
    if (!subject || !job.pastPaperTitle?.trim()) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "PAST_PAPER_INVALID",
          "新建往年真题必须指定有效学科和标题",
        ),
      );
      return;
    }
    subjectId = subject.id;
  } else {
    const paper = job.targetPastPaperId
      ? await prisma.quizPaper.findUnique({
          where: { id: job.targetPastPaperId },
          select: { id: true, subjectId: true },
        })
      : null;
    if (!paper) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "PAST_PAPER_NOT_FOUND",
          "目标往年真题试卷不存在",
        ),
      );
      return;
    }
    subjectId = paper.subjectId;
    const explicitOrders = rows
      .map((row) => row.paperOrder)
      .filter((value): value is number => value !== undefined);
    if (explicitOrders.length) {
      const conflicts = await prisma.quizQuestion.count({
        where: { pastPaperId: paper.id, paperOrder: { in: explicitOrders } },
      });
      if (conflicts)
        issues.push(
          issue(
            QuizImportIssueSeverity.ERROR,
            "PAST_PAPER_ORDER_CONFLICT",
            "paperOrder 与目标试卷现有题序重复",
          ),
        );
    }
  }
  for (const row of rows) {
    if (row.question.subjectId !== subjectId) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "PAST_PAPER_SUBJECT_MISMATCH",
          `第 ${row.rowNumber} 行的学科与往年真题试卷不一致`,
          { rowNumber: row.rowNumber, field: "subject" },
        ),
      );
    }
  }
}

function validateImageReferences(
  references: ImageReference[],
  archiveImagePaths: string[],
  issues: IssueInput[],
) {
  const byPath = new Map<string, ImageReference>();
  for (const reference of references) {
    const key = reference.filePath.toLocaleLowerCase("en-US");
    if (byPath.has(key)) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "IMAGE_REFERENCED_MORE_THAN_ONCE",
          "每个图片文件只能被一道题引用一次",
          {
            rowNumber: reference.rowNumber,
            filePath: reference.filePath,
            field: "images",
          },
        ),
      );
    } else {
      byPath.set(key, reference);
    }
  }
  const archiveSet = new Set(
    archiveImagePaths.map((path) => path.toLocaleLowerCase("en-US")),
  );
  for (const reference of references) {
    if (!archiveSet.has(reference.filePath.toLocaleLowerCase("en-US"))) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "IMAGE_MISSING",
          "CSV 引用的图片不在 ZIP 中",
          {
            rowNumber: reference.rowNumber,
            filePath: reference.filePath,
            field: "images",
          },
        ),
      );
    }
  }
  for (const path of archiveImagePaths) {
    if (!byPath.has(path.toLocaleLowerCase("en-US"))) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "IMAGE_UNREFERENCED",
          "ZIP 图片未被任何题目引用",
          { filePath: path },
        ),
      );
    }
  }
}

async function validateImageFiles(
  zipPath: string,
  references: ImageReference[],
  issues: IssueInput[],
  onProgress?: (current: number, total: number) => Promise<void>,
) {
  const referenceByPath = new Map(
    references.map((reference) => [
      reference.filePath.toLocaleLowerCase("en-US"),
      reference,
    ]),
  );
  let current = 0;
  await forEachZipImage(zipPath, async (filePath, data) => {
    current += 1;
    const reference = referenceByPath.get(filePath.toLocaleLowerCase("en-US"));
    try {
      const metadata = await inspectImage(data);
      const expected = IMAGE_EXTENSION_FORMAT[extname(filePath).toLowerCase()];
      if (metadata.format !== expected) {
        issues.push(
          issue(
            QuizImportIssueSeverity.ERROR,
            "IMAGE_TYPE_MISMATCH",
            "图片内容与扩展名不一致",
            { rowNumber: reference?.rowNumber, filePath },
          ),
        );
      }
    } catch (error) {
      const message =
        error instanceof Error && /pixel|limitInputPixels/i.test(error.message)
          ? "图片像素超过 3200 万限制"
          : "图片无法读取或格式不受支持";
      issues.push(
        issue(QuizImportIssueSeverity.ERROR, "IMAGE_INVALID", message, {
          rowNumber: reference?.rowNumber,
          filePath,
        }),
      );
    }
    await onProgress?.(current, referenceByPath.size);
  });
}

export async function analyzeQuizImport(
  prisma: PrismaClient,
  job: QuizImportJob,
  onProgress?: (stage: string, current: number, total: number) => Promise<void>,
): Promise<ImportAnalysis> {
  const issues: IssueInput[] = [];
  const sourcePath = localObjectPath(job.sourceObjectKey);
  try {
    const actualHash = await hashFileSha256(sourcePath);
    if (actualHash !== job.sourceSha256) {
      issues.push(
        issue(
          QuizImportIssueSeverity.ERROR,
          "SOURCE_HASH_MISMATCH",
          "上传文件校验失败，请重新上传",
        ),
      );
    }
  } catch {
    issues.push(
      issue(
        QuizImportIssueSeverity.ERROR,
        "SOURCE_MISSING",
        "上传文件不存在或无法读取",
      ),
    );
  }

  let csvBuffer: Buffer | null = null;
  let imagePaths: string[] = [];
  if (!issues.length) {
    try {
      if (job.fileType === QuizImportFileType.ZIP) {
        const entries = await inspectQuizZip(sourcePath);
        imagePaths = entries
          .filter((entry) => entry.path.startsWith("images/"))
          .map((entry) => entry.path);
        csvBuffer = await readZipEntry(
          sourcePath,
          "questions.csv",
          MAX_CSV_BYTES,
        );
      } else {
        const stats = await fs.stat(sourcePath);
        if (stats.size > MAX_CSV_BYTES)
          throw new QuizImportArchiveError(
            "CSV_TOO_LARGE",
            "CSV 文件超过 2MB 限制",
          );
        csvBuffer = await fs.readFile(sourcePath);
      }
    } catch (error) {
      if (error instanceof QuizImportArchiveError) {
        issues.push(
          issue(QuizImportIssueSeverity.ERROR, error.code, error.message, {
            filePath: error.filePath,
          }),
        );
      } else {
        issues.push(
          issue(
            QuizImportIssueSeverity.ERROR,
            "SOURCE_INVALID",
            "无法读取题目包",
          ),
        );
      }
    }
  }

  const parsed = csvBuffer
    ? parseCsvRows(csvBuffer, issues)
    : { rows: [], headers: [] };
  const rows = parseRows(parsed.rows, job.fileType, job.mode, issues);
  const imageReferences = rows.flatMap((row) => row.images);
  if (job.fileType === QuizImportFileType.ZIP) {
    validateImageReferences(imageReferences, imagePaths, issues);
    if (csvBuffer) {
      await validateImageFiles(
        sourcePath,
        imageReferences,
        issues,
        async (current, total) => {
          await onProgress?.("VALIDATING_IMAGES", current, total);
        },
      );
    }
  }
  const resolvedRows = await validateTaxonomyAndQuestions(
    prisma,
    job,
    rows,
    issues,
  );
  const subjectCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  for (const row of resolvedRows) {
    subjectCounts.set(
      row.subjectName,
      (subjectCounts.get(row.subjectName) ?? 0) + 1,
    );
    typeCounts.set(
      row.question.typeLabel,
      (typeCounts.get(row.question.typeLabel) ?? 0) + 1,
    );
  }
  const summary: Prisma.InputJsonObject = {
    questionCount: parsed.rows.length,
    imageCount: imagePaths.length,
    subjects: [...subjectCounts].map(([name, count]) => ({ name, count })),
    typeLabels: [...typeCounts].map(([name, count]) => ({ name, count })),
    plannedChapterCount: new Set(
      rows.flatMap((row) =>
        row.chapterNames.map((name) => `${row.subjectName}\u0000${name}`),
      ),
    ).size,
  };
  return { rows, resolvedRows, issues, imageReferences, imagePaths, summary };
}

async function replaceIssues(
  prisma: Pick<PrismaClient, "quizImportIssue">,
  importId: string,
  issues: IssueInput[],
) {
  await prisma.quizImportIssue.deleteMany({ where: { importId } });
  for (let index = 0; index < issues.length; index += MAX_ISSUES_PER_BATCH) {
    await prisma.quizImportIssue.createMany({
      data: issues
        .slice(index, index + MAX_ISSUES_PER_BATCH)
        .map((item) => ({ ...item, importId })),
    });
  }
}

export async function runQuizImportPreflight(
  prisma: PrismaClient,
  job: QuizImportJob,
) {
  const analysis = await withQuizLeaseHeartbeat(
    prisma,
    job.id,
    requiredQuizImportOwner(job),
    () => analyzeQuizImport(prisma, job, async (stage, current, total) => {
      const progressed = await prisma.quizImportJob.updateMany({
        where: {
          id: job.id,
          status: QuizImportStatus.PREFLIGHTING,
          leaseOwnerToken: requiredQuizImportOwner(job),
        },
        data: {
          stage,
          progressCurrent: current,
          progressTotal: total,
          leasedUntil: leaseUntil(),
        },
      });
      if (progressed.count !== 1) throw new Error("QUIZ_IMPORT_LEASE_LOST");
    }),
  );
  const errorCount = analysis.issues.filter(
    (item) => item.severity === QuizImportIssueSeverity.ERROR,
  ).length;
  const warningCount = analysis.issues.length - errorCount;
  const nextStatus = errorCount
    ? QuizImportStatus.INVALID
    : QuizImportStatus.AWAITING_CONFIRMATION;
  await prisma.$transaction(async (transaction) => {
    await replaceIssues(transaction, job.id, analysis.issues);
    await transaction.quizImportAsset.deleteMany({
      where: { importId: job.id },
    });
    if (!errorCount && analysis.imageReferences.length) {
      await transaction.quizImportAsset.createMany({
        data: analysis.imageReferences.map((reference) => {
          const objectId = randomUUID();
          return {
            importId: job.id,
            rowNumber: reference.rowNumber,
            filePath: reference.filePath,
            caption: reference.caption,
            sortOrder: reference.sortOrder,
            plannedPhotoId: randomUUID(),
            objectKey:
              (process.env.MEDIA_STORAGE_PROVIDER ?? "database") === "cos"
                ? createMediaObjectKey(new Date(), objectId)
                : null,
          };
        }),
      });
    }
    const completed = await transaction.quizImportJob.updateMany({
      where: {
        id: job.id,
        status: QuizImportStatus.PREFLIGHTING,
        leaseOwnerToken: requiredQuizImportOwner(job),
      },
      data: {
        status: nextStatus,
        stage: errorCount ? "INVALID" : "READY_FOR_CONFIRMATION",
        progressCurrent: 0,
        progressTotal: 0,
        questionCount: analysis.rows.length,
        imageCount: analysis.imagePaths.length,
        errorCount,
        warningCount,
        summary: analysis.summary,
        leaseOwnerToken: null,
        leasedUntil: null,
        attempts: 0,
        errorCode: null,
        errorMessage: null,
        completedAt: errorCount ? new Date() : null,
        ...(errorCount
          ? {
              sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
              sourceCleanupNextAttemptAt: new Date(),
            }
          : {}),
      },
    });
    if (completed.count !== 1) throw new Error("QUIZ_IMPORT_LEASE_LOST");
  });
}

function readLeaseMs() {
  const value = Number(process.env.WORKER_QUIZ_IMPORT_LEASE_MS ?? 60 * 60_000);
  return Number.isInteger(value) && value >= 60_000 ? value : 60 * 60_000;
}

function leaseUntil() {
  return new Date(Date.now() + IMPORT_LEASE_MS);
}

function requiredQuizImportOwner(job: QuizImportJob) {
  if (!job.leaseOwnerToken) throw new Error("QUIZ_IMPORT_OWNER_TOKEN_MISSING");
  return job.leaseOwnerToken;
}

async function assertQuizImportContinuing(
  prisma: PrismaClient,
  jobId: string,
  ownerToken: string,
) {
  const owned = await prisma.quizImportJob.updateMany({
    where: {
      id: jobId,
      status: QuizImportStatus.IMPORTING,
      leaseOwnerToken: ownerToken,
      cancelRequestedAt: null,
    },
    data: { leasedUntil: leaseUntil() },
  });
  if (owned.count !== 1) throw new Error("QUIZ_IMPORT_LEASE_LOST");
}

async function assertQuizImportOwned(
  prisma: PrismaClient,
  jobId: string,
  ownerToken: string,
) {
  const owned = await prisma.quizImportJob.updateMany({
    where: {
      id: jobId,
      status: QuizImportStatus.IMPORTING,
      leaseOwnerToken: ownerToken,
    },
    data: { leasedUntil: leaseUntil() },
  });
  if (owned.count !== 1) throw new Error("QUIZ_IMPORT_LEASE_LOST");
}

async function withQuizLeaseHeartbeat<T>(
  prisma: PrismaClient,
  jobId: string,
  ownerToken: string,
  action: () => Promise<T>,
) {
  let leaseLost = false;
  const timer = setInterval(() => {
    void prisma.quizImportJob.updateMany({
      where: {
        id: jobId,
        leaseOwnerToken: ownerToken,
        status: {
          in: [QuizImportStatus.PREFLIGHTING, QuizImportStatus.IMPORTING],
        },
        cancelRequestedAt: null,
      },
      data: { leasedUntil: leaseUntil() },
    }).then((result) => {
      if (result.count !== 1) leaseLost = true;
    }).catch(() => {
      leaseLost = true;
    });
  }, IMPORT_HEARTBEAT_MS);
  timer.unref();
  try {
    const result = await action();
    if (leaseLost) throw new Error("QUIZ_IMPORT_LEASE_LOST");
    return result;
  } finally {
    clearInterval(timer);
  }
}

export const quizImportLeaseUntil = leaseUntil;

interface PersistedRow extends ParsedRow {
  question: PreparedQuestion;
  questionId: string;
}

function stagedAssetPath(jobId: string, assetId: string) {
  return join(
    uploadsRoot,
    "quiz-imports",
    jobId,
    "processed",
    `${assetId}.webp`,
  );
}

async function processImportAssets(prisma: PrismaClient, job: QuizImportJob) {
  const assets = await prisma.quizImportAsset.findMany({
    where: { importId: job.id },
    orderBy: [{ rowNumber: "asc" }, { sortOrder: "asc" }],
  });
  if (!assets.length) return;
  const assetByPath = new Map(
    assets.map((asset) => [asset.filePath.toLocaleLowerCase("en-US"), asset]),
  );
  const provider = process.env.MEDIA_STORAGE_PROVIDER ?? "database";
  const store =
    provider === "cos"
      ? new CosMediaStore(readMediaCosConfig(process.env))
      : null;
  const sourcePath = localObjectPath(job.sourceObjectKey);
  const active = new Set<Promise<void>>();
  let completed = 0;

  const processOne = async (filePath: string, data: Buffer) => {
    const asset = assetByPath.get(filePath.toLocaleLowerCase("en-US"));
    if (!asset) return;
    await assertQuizImportContinuing(
      prisma,
      job.id,
      requiredQuizImportOwner(job),
    );
    const compressed = await compressImage(data);
    if (store) {
      if (!asset.objectKey) throw new Error("导入图片缺少预分配对象键");
      const alreadyExists =
        asset.status === QuizImportAssetStatus.UPLOADED &&
        (await store.exists(asset.objectKey));
      if (!alreadyExists) {
        await store.upload(
          compressed.data,
          asset.objectKey,
          compressed.mimeType,
        );
      }
    } else {
      const staged = stagedAssetPath(job.id, asset.id);
      await fs.mkdir(dirname(staged), { recursive: true });
      await fs.writeFile(staged, compressed.data);
    }
    await assertQuizImportContinuing(
      prisma,
      job.id,
      requiredQuizImportOwner(job),
    );
    completed += 1;
    await prisma.$transaction(async (transaction) => {
      const progressed = await transaction.quizImportJob.updateMany({
        where: {
          id: job.id,
          status: QuizImportStatus.IMPORTING,
          leaseOwnerToken: requiredQuizImportOwner(job),
          cancelRequestedAt: null,
        },
        data: {
          stage: "PROCESSING_IMAGES",
          progressCurrent: completed,
          progressTotal: assets.length,
          leasedUntil: leaseUntil(),
        },
      });
      if (progressed.count !== 1) throw new Error("QUIZ_IMPORT_LEASE_LOST");
      await transaction.quizImportAsset.update({
        where: { id: asset.id },
        data: {
          mimeType: compressed.mimeType,
          size: compressed.size,
          width: compressed.width,
          height: compressed.height,
          status: QuizImportAssetStatus.UPLOADED,
          cleanupError: null,
        },
      });
    });
  };

  await forEachZipImage(sourcePath, async (filePath, data) => {
    const task = processOne(filePath, data).finally(() => active.delete(task));
    active.add(task);
    if (active.size >= 2) await Promise.race(active);
  });
  await Promise.all(active);
  if (completed !== assets.length) {
    throw new Error("题目包中的图片与预检资产数量不一致");
  }
}

async function resolveRowsForPersistence(
  transaction: Prisma.TransactionClient,
  job: QuizImportJob,
  rows: ParsedRow[],
) {
  const subjects = await transaction.subject.findMany({
    where: {
      name: { in: [...new Set(rows.map((row) => row.subjectName))] },
      active: true,
    },
    select: { id: true, name: true },
  });
  const subjectByName = new Map(
    subjects.map((subject) => [subject.name, subject]),
  );
  if (subjectByName.size !== new Set(rows.map((row) => row.subjectName)).size) {
    throw new ConfirmedImportValidationError();
  }
  const chapterNames = [...new Set(rows.flatMap((row) => row.chapterNames))];
  let chapters = await transaction.subjectChapter.findMany({
    where: {
      subjectId: { in: subjects.map((subject) => subject.id) },
      name: { in: chapterNames },
    },
    select: { id: true, subjectId: true, name: true, active: true },
  });
  if (chapters.some((chapter) => !chapter.active)) {
    throw new ConfirmedImportValidationError();
  }
  const chapterByKey = new Map(
    chapters.map((chapter) => [
      `${chapter.subjectId}\u0000${chapter.name}`,
      chapter,
    ]),
  );
  const missing: Array<{
    id: string;
    subjectId: string;
    name: string;
    slug: string;
  }> = [];
  for (const row of rows) {
    const subject = subjectByName.get(row.subjectName)!;
    for (const name of row.chapterNames) {
      const key = `${subject.id}\u0000${name}`;
      if (
        chapterByKey.has(key) ||
        missing.some(
          (chapter) => `${chapter.subjectId}\u0000${chapter.name}` === key,
        )
      )
        continue;
      if (!job.createMissingChapters)
        throw new ConfirmedImportValidationError();
      missing.push({
        id: randomUUID(),
        subjectId: subject.id,
        name,
        slug: importedChapterSlug(subject.id, name),
      });
    }
  }
  if (missing.length) {
    await transaction.subjectChapter.createMany({
      data: missing,
      skipDuplicates: true,
    });
    chapters = await transaction.subjectChapter.findMany({
      where: {
        subjectId: { in: subjects.map((subject) => subject.id) },
        name: { in: chapterNames },
      },
      select: { id: true, subjectId: true, name: true, active: true },
    });
    chapterByKey.clear();
    for (const chapter of chapters) {
      chapterByKey.set(`${chapter.subjectId}\u0000${chapter.name}`, chapter);
    }
  }
  const persistedRows: PersistedRow[] = rows.map((row) => {
    const subject = subjectByName.get(row.subjectName)!;
    const chapterIds = row.chapterNames.map((name) => {
      const chapter = chapterByKey.get(`${subject.id}\u0000${name}`);
      if (!chapter?.active) throw new ConfirmedImportValidationError();
      return chapter.id;
    });
    const question = prepareQuestion(
      {
        gradingType: row.gradingType,
        typeLabel: row.typeLabel,
        subjectId: subject.id,
        chapterIds,
        category: row.category,
        prompt: row.prompt,
        options: row.options,
        correctAnswer: row.correctAnswer,
        gradingRubric: row.gradingRubric,
        explanation: row.explanation,
      },
      `第 ${row.rowNumber} 行`,
    );
    return { ...row, question, questionId: randomUUID() };
  });
  const createdChapterCount = chapters.filter((chapter) =>
    missing.some(
      (candidate) =>
        candidate.subjectId === chapter.subjectId &&
        candidate.name === chapter.name,
    ),
  ).length;
  return { persistedRows, createdChapterCount };
}

async function resolvePaperForPersistence(
  transaction: Prisma.TransactionClient,
  job: QuizImportJob,
  rows: PersistedRow[],
) {
  if (job.mode === QuizImportMode.BANK) return null;
  if (job.mode === QuizImportMode.NEW_PAPER) {
    const subject = job.targetSubjectId
      ? await transaction.subject.findFirst({
          where: { id: job.targetSubjectId, active: true },
          select: { id: true },
        })
      : null;
    const title = job.pastPaperTitle?.trim() ?? "";
    if (
      !subject ||
      !title ||
      rows.some((row) => row.question.subjectId !== subject.id)
    ) {
      throw new ConfirmedImportValidationError();
    }
    const paper = await transaction.quizPaper.create({
      data: {
        title,
        subjectId: subject.id,
        year: job.pastPaperYear,
        authorId: job.createdById,
      },
      select: { id: true },
    });
    return { id: paper.id, startOrder: 1 };
  }
  const paper = job.targetPastPaperId
    ? await transaction.quizPaper.findUnique({
        where: { id: job.targetPastPaperId },
        select: { id: true, subjectId: true },
      })
    : null;
  if (
    !paper ||
    rows.some((row) => row.question.subjectId !== paper.subjectId)
  ) {
    throw new ConfirmedImportValidationError();
  }
  const last = await transaction.quizQuestion.findFirst({
    where: { pastPaperId: paper.id },
    select: { paperOrder: true },
    orderBy: { paperOrder: "desc" },
  });
  return { id: paper.id, startOrder: (last?.paperOrder ?? 0) + 1 };
}

function questionData(
  row: PersistedRow,
  job: QuizImportJob,
  paper: { id: string; startOrder: number } | null,
  index: number,
): Prisma.QuizQuestionCreateManyInput {
  const question = row.question;
  return {
    id: row.questionId,
    type: question.type,
    typeLabel: question.typeLabel,
    subjectId: question.subjectId,
    category: question.category,
    origin: QuizQuestionOrigin.CSV,
    reviewStatus: QuizQuestionReviewStatus.APPROVED,
    prompt: question.prompt,
    options: question.options as unknown as Prisma.InputJsonValue,
    correctAnswer: question.correctAnswer as Prisma.InputJsonValue,
    gradingRubric: question.gradingRubric
      ? (question.gradingRubric as unknown as Prisma.InputJsonValue)
      : undefined,
    maxScore: question.maxScore,
    explanation: question.explanation,
    authorId: job.createdById,
    importJobId: job.id,
    importRowNumber: row.rowNumber,
    pastPaperId: paper?.id,
    paperOrder: paper
      ? (row.paperOrder ?? paper.startOrder + index)
      : undefined,
  };
}

async function persistImport(
  prisma: PrismaClient,
  job: QuizImportJob,
  rows: ParsedRow[],
) {
  return prisma.$transaction(
    async (transaction) => {
      const locked = await transaction.quizImportJob.findUnique({
        where: { id: job.id },
        select: {
          status: true,
          leaseOwnerToken: true,
          reservedQuestionCount: true,
          cancelRequestedAt: true,
        },
      });
      if (
        locked?.status !== QuizImportStatus.IMPORTING ||
        locked.leaseOwnerToken !== requiredQuizImportOwner(job) ||
        locked.cancelRequestedAt
      ) {
        throw new Error("导入任务状态已变化");
      }
      const { persistedRows, createdChapterCount } =
        await resolveRowsForPersistence(transaction, job, rows);
      const paper = await resolvePaperForPersistence(
        transaction,
        job,
        persistedRows,
      );
      for (let index = 0; index < persistedRows.length; index += 250) {
        await transaction.quizQuestion.createMany({
          data: persistedRows
            .slice(index, index + 250)
            .map((row, offset) =>
              questionData(row, job, paper, index + offset),
            ),
        });
      }
      await transaction.quizQuestionChapter.createMany({
        data: persistedRows.flatMap((row) =>
          row.question.chapterIds.map((chapterId) => ({
            questionId: row.questionId,
            chapterId,
          })),
        ),
      });

      const assets = await transaction.quizImportAsset.findMany({
        where: { importId: job.id },
        orderBy: [{ rowNumber: "asc" }, { sortOrder: "asc" }],
      });
      const usesCos =
        (process.env.MEDIA_STORAGE_PROVIDER ?? "database") === "cos";
      if (usesCos && assets.length) {
        await transaction.photo.createMany({
          data: assets.map((asset) => {
            if (!asset.objectKey || !asset.mimeType || !asset.size) {
              throw new Error("导入图片处理结果不完整");
            }
            return {
              id: asset.plannedPhotoId,
              uploadedById: job.createdById,
              objectKey: asset.objectKey,
              caption: asset.caption,
              mimeType: asset.mimeType,
              size: asset.size,
              width: asset.width,
              height: asset.height,
            };
          }),
        });
      } else {
        for (const asset of assets) {
          if (!asset.mimeType || !asset.size)
            throw new Error("导入图片处理结果不完整");
          const data = await fs.readFile(stagedAssetPath(job.id, asset.id));
          await transaction.photo.create({
            data: {
              id: asset.plannedPhotoId,
              uploadedById: job.createdById,
              data: Uint8Array.from(data),
              caption: asset.caption,
              mimeType: asset.mimeType,
              size: asset.size,
              width: asset.width,
              height: asset.height,
            },
          });
        }
      }
      if (assets.length) {
        const questionIdByRow = new Map(
          persistedRows.map((row) => [row.rowNumber, row.questionId]),
        );
        await transaction.quizQuestionPhoto.createMany({
          data: assets.map((asset) => ({
            questionId: questionIdByRow.get(asset.rowNumber)!,
            photoId: asset.plannedPhotoId,
            sortOrder: asset.sortOrder,
          })),
        });
        await transaction.quizImportAsset.updateMany({
          where: { importId: job.id },
          data: { status: QuizImportAssetStatus.LINKED, cleanupError: null },
        });
      }
      const completedAt = new Date();
      const completed = await transaction.quizImportJob.updateMany({
        where: {
          id: job.id,
          status: QuizImportStatus.IMPORTING,
          leaseOwnerToken: requiredQuizImportOwner(job),
          cancelRequestedAt: null,
        },
        data: {
          status: QuizImportStatus.COMPLETED,
          stage: "COMPLETED",
          progressCurrent: persistedRows.length,
          progressTotal: persistedRows.length,
          importedCount: persistedRows.length,
          createdChapterCount,
          resultPastPaperId: paper?.id,
          reservedQuestionCount: 0,
          leaseOwnerToken: null,
          leasedUntil: null,
          errorCode: null,
          errorMessage: null,
          completedAt,
          sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
          sourceCleanupNextAttemptAt: completedAt,
        },
      });
      if (completed.count !== 1) throw new Error("导入任务完成状态写入失败");
      const activeQuestions = await transaction.quizQuestion.count();
      await transaction.quizCapacityCounter.upsert({
        where: { singletonId: 1 },
        create: {
          singletonId: 1,
          activeQuestions,
        },
        update: {
          activeQuestions,
          reservedQuestions: { decrement: locked.reservedQuestionCount },
        },
      });
      await transaction.auditLog.create({
        data: {
          actorId: job.confirmedById ?? job.createdById,
          action: "quiz.import.complete",
          targetType: "QuizImportJob",
          targetId: job.id,
          metadata: {
            imported: persistedRows.length,
            imageCount: assets.length,
            createdChapterCount,
            pastPaperId: paper?.id ?? null,
          },
        },
      });
      return { imported: persistedRows.length };
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

async function cleanupStagedAssets(prisma: PrismaClient, jobId: string) {
  const assets = await prisma.quizImportAsset.findMany({
    where: { importId: jobId },
    select: { id: true },
  });
  await Promise.all(
    assets.map((asset) =>
      fs.rm(stagedAssetPath(jobId, asset.id), { force: true }),
    ),
  );
}

interface ImportFailure {
  stage: string;
  errorCode: string;
  errorMessage: string;
  errorCount?: number;
  warningCount?: number;
}

async function compensateImportAssets(
  prisma: PrismaClient,
  job: QuizImportJob,
  failure: ImportFailure,
  options: { cancelled?: boolean } = {},
) {
  const ownerToken = requiredQuizImportOwner(job);
  await assertQuizImportOwned(prisma, job.id, ownerToken);
  const assets = await prisma.quizImportAsset.findMany({
    where: { importId: job.id },
  });
  const provider = process.env.MEDIA_STORAGE_PROVIDER ?? "database";
  const store =
    provider === "cos"
      ? new CosMediaStore(readMediaCosConfig(process.env))
      : null;
  let failed = 0;
  for (const asset of assets) {
    await assertQuizImportOwned(prisma, job.id, ownerToken);
    try {
      if (store && asset.objectKey) await store.delete(asset.objectKey);
      if (!store)
        await fs.rm(stagedAssetPath(job.id, asset.id), { force: true });
      await prisma.quizImportAsset.update({
        where: { id: asset.id },
        data: { status: QuizImportAssetStatus.CLEANED, cleanupError: null },
      });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await prisma.quizImportAsset.update({
        where: { id: asset.id },
        data: {
          status: QuizImportAssetStatus.ORPHANED,
          cleanupError: message.slice(0, 2_000),
        },
      });
      console.error(
        JSON.stringify({
          event: "quiz.import.orphan-object",
          importId: job.id,
          assetId: asset.id,
          objectKey: asset.objectKey,
        }),
      );
    }
  }
  await prisma.$transaction(async (transaction) => {
    const current = await transaction.quizImportJob.findUnique({
      where: { id: job.id },
      select: { reservedQuestionCount: true },
    });
    const completed = await transaction.quizImportJob.updateMany({
      where: {
        id: job.id,
        status: QuizImportStatus.IMPORTING,
        leaseOwnerToken: requiredQuizImportOwner(job),
      },
      data: {
        status: failed
          ? QuizImportStatus.COMPENSATION_FAILED
          : options.cancelled
            ? QuizImportStatus.EXPIRED
            : QuizImportStatus.FAILED,
        stage: failed
          ? "COMPENSATION_FAILED"
          : options.cancelled
            ? "CANCELLED"
            : "FAILED",
        ...(failed
          ? {
              errorCode: "COMPENSATION_FAILED",
              errorMessage: `${failure.errorMessage}；部分图片未能清理，请联系管理员处理`,
            }
          : options.cancelled
            ? {
                errorCode: "IMPORT_CANCELLED",
                errorMessage: "题库导入已取消，已释放容量并清理任务对象",
              }
          : {
              stage: failure.stage,
              errorCode: failure.errorCode,
              errorMessage: failure.errorMessage,
            }),
        errorCount: failure.errorCount,
        warningCount: failure.warningCount,
        reservedQuestionCount: 0,
        leaseOwnerToken: null,
        leasedUntil: null,
        completedAt: new Date(),
        ...(failed
          ? {}
          : {
              sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
              sourceCleanupNextAttemptAt: new Date(),
            }),
      },
    });
    if (completed.count !== 1) throw new Error("QUIZ_IMPORT_LEASE_LOST");
    if (current?.reservedQuestionCount) {
      await transaction.quizCapacityCounter.updateMany({
        where: { singletonId: 1 },
        data: {
          reservedQuestions: { decrement: current.reservedQuestionCount },
        },
      });
    }
    if (options.cancelled) {
      await transaction.auditLog.create({
        data: {
          actorId: job.confirmedById ?? job.createdById,
          action: "quiz.import.cancelled",
          targetType: "QuizImportJob",
          targetId: job.id,
          metadata: { compensationFailed: failed > 0 },
        },
      });
    }
  });
}

export async function runQuizImportCommit(
  prisma: PrismaClient,
  job: QuizImportJob,
) {
  const analysis = await withQuizLeaseHeartbeat(
    prisma,
    job.id,
    requiredQuizImportOwner(job),
    () => analyzeQuizImport(prisma, job, async (stage, current, total) => {
      const progressed = await prisma.quizImportJob.updateMany({
        where: {
          id: job.id,
          status: QuizImportStatus.IMPORTING,
          leaseOwnerToken: requiredQuizImportOwner(job),
          cancelRequestedAt: null,
        },
        data: {
          stage,
          progressCurrent: current,
          progressTotal: total,
          leasedUntil: leaseUntil(),
        },
      });
      if (progressed.count !== 1) throw new Error("QUIZ_IMPORT_LEASE_LOST");
    }),
  );
  const errors = analysis.issues.filter(
    (item) => item.severity === QuizImportIssueSeverity.ERROR,
  );
  if (errors.length) {
    await assertQuizImportContinuing(
      prisma,
      job.id,
      requiredQuizImportOwner(job),
    );
    await replaceIssues(prisma, job.id, analysis.issues);
    await compensateImportAssets(prisma, job, {
      stage: "VALIDATION_CHANGED",
      errorCode: "VALIDATION_CHANGED",
      errorMessage: "预检后目录或题目包状态发生变化，请重新上传",
      errorCount: errors.length,
      warningCount: analysis.issues.length - errors.length,
    });
    return;
  }
  await withQuizLeaseHeartbeat(
    prisma,
    job.id,
    requiredQuizImportOwner(job),
    () => processImportAssets(prisma, job),
  );
  const writing = await prisma.quizImportJob.updateMany({
    where: {
      id: job.id,
      status: QuizImportStatus.IMPORTING,
      leaseOwnerToken: requiredQuizImportOwner(job),
      cancelRequestedAt: null,
    },
    data: {
      stage: "WRITING_DATABASE",
      progressCurrent: 0,
      progressTotal: analysis.rows.length,
      leasedUntil: leaseUntil(),
    },
  });
  if (writing.count !== 1) throw new Error("QUIZ_IMPORT_LEASE_LOST");
  await persistImport(prisma, job, analysis.rows);
  await cleanupStagedAssets(prisma, job.id).catch(() => undefined);
}

let activeQuizJob: {
  id: string;
  phase: "preflight" | "import";
  ownerToken: string;
} | null = null;

export async function acquireQuizImportJob(prisma: PrismaClient) {
  const now = new Date();
  const candidate = await prisma.quizImportJob.findFirst({
    where: {
      OR: [
        { status: QuizImportStatus.PREFLIGHT_PENDING },
        { status: QuizImportStatus.PREFLIGHTING, leasedUntil: { lt: now } },
        { status: QuizImportStatus.PREFLIGHTING, leasedUntil: null },
        { status: QuizImportStatus.IMPORT_PENDING },
        { status: QuizImportStatus.IMPORTING, leasedUntil: { lt: now } },
        { status: QuizImportStatus.IMPORTING, leasedUntil: null },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;
  const ownerToken = randomUUID();
  const phase =
    candidate.status === QuizImportStatus.PREFLIGHT_PENDING ||
    candidate.status === QuizImportStatus.PREFLIGHTING
      ? ("preflight" as const)
      : ("import" as const);
  const allowed =
    phase === "preflight"
      ? [QuizImportStatus.PREFLIGHT_PENDING, QuizImportStatus.PREFLIGHTING]
      : [QuizImportStatus.IMPORT_PENDING, QuizImportStatus.IMPORTING];
  const claimed = await prisma.quizImportJob.updateMany({
    where: {
      id: candidate.id,
      status: { in: allowed },
      OR: [
        {
          status:
            phase === "preflight"
              ? QuizImportStatus.PREFLIGHT_PENDING
              : QuizImportStatus.IMPORT_PENDING,
        },
        { leasedUntil: { lt: now } },
        { leasedUntil: null },
      ],
    },
    data: {
      status:
        phase === "preflight"
          ? QuizImportStatus.PREFLIGHTING
          : QuizImportStatus.IMPORTING,
      stage: phase === "preflight" ? "VALIDATING_PACKAGE" : "VALIDATING_AGAIN",
      attempts: { increment: 1 },
      leaseOwnerToken: ownerToken,
      leasedUntil: leaseUntil(),
      errorCode: null,
      errorMessage: null,
    },
  });
  if (claimed.count !== 1) return null;
  const job = await prisma.quizImportJob.findUnique({
    where: { id: candidate.id },
  });
  const expectedStatus =
    phase === "preflight"
      ? QuizImportStatus.PREFLIGHTING
      : QuizImportStatus.IMPORTING;
  return job?.leaseOwnerToken === ownerToken && job.status === expectedStatus
    ? { job, phase }
    : null;
}

export async function expireQuizImports(
  prisma: PrismaClient,
  now = new Date(),
) {
  const expired = await prisma.quizImportJob.findMany({
    where: {
      status: QuizImportStatus.AWAITING_CONFIRMATION,
      expiresAt: { lt: now },
    },
    select: { id: true, sourceObjectKey: true },
    take: 20,
  });
  for (const job of expired) {
    const changed = await prisma.quizImportJob.updateMany({
      where: {
        id: job.id,
        status: QuizImportStatus.AWAITING_CONFIRMATION,
        expiresAt: { lt: now },
      },
      data: {
        status: QuizImportStatus.EXPIRED,
        stage: "EXPIRED",
        completedAt: now,
        sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
        sourceCleanupNextAttemptAt: now,
      },
    });
  }
}

export async function processQuizImportSourceCleanup(
  prisma: PrismaClient,
  now = new Date(),
) {
  const [retained] = await prisma.quizImportJob.findMany({
    where: {
      sourceCleanupStatus: ImportSourceCleanupStatus.RETAINED,
      status: {
        in: [
          QuizImportStatus.INVALID,
          QuizImportStatus.COMPLETED,
          QuizImportStatus.FAILED,
          QuizImportStatus.EXPIRED,
        ],
      },
    },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 1,
  });
  if (retained) {
    await prisma.quizImportJob.updateMany({
      where: {
        id: retained.id,
        sourceCleanupStatus: ImportSourceCleanupStatus.RETAINED,
        status: {
          in: [
            QuizImportStatus.INVALID,
            QuizImportStatus.COMPLETED,
            QuizImportStatus.FAILED,
            QuizImportStatus.EXPIRED,
          ],
        },
      },
      data: {
        sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
        sourceCleanupNextAttemptAt: now,
      },
    });
  }
  const candidate = await prisma.quizImportJob.findFirst({
    where: {
      sourceCleanupAttempts: { lt: 5 },
      OR: [
        { sourceCleanupStatus: ImportSourceCleanupStatus.PENDING },
        {
          sourceCleanupStatus: ImportSourceCleanupStatus.FAILED,
          sourceCleanupNextAttemptAt: { lte: now },
        },
        {
          sourceCleanupStatus: ImportSourceCleanupStatus.IN_PROGRESS,
          sourceCleanupNextAttemptAt: { lte: now },
        },
      ],
    },
    orderBy: [{ sourceCleanupNextAttemptAt: "asc" }, { createdAt: "asc" }],
  });
  if (!candidate) return false;
  const claimed = await prisma.quizImportJob.updateMany({
    where: {
      id: candidate.id,
      sourceCleanupStatus: candidate.sourceCleanupStatus,
      sourceCleanupAttempts: candidate.sourceCleanupAttempts,
    },
    data: {
      sourceCleanupStatus: ImportSourceCleanupStatus.IN_PROGRESS,
      sourceCleanupAttempts: { increment: 1 },
      sourceCleanupNextAttemptAt: new Date(now.getTime() + 5 * 60_000),
      sourceCleanupError: null,
    },
  });
  if (claimed.count !== 1) return false;
  const attempt = candidate.sourceCleanupAttempts + 1;
  try {
    await removeLocalObject(candidate.sourceObjectKey);
    await prisma.quizImportJob.updateMany({
      where: {
        id: candidate.id,
        sourceCleanupStatus: ImportSourceCleanupStatus.IN_PROGRESS,
        sourceCleanupAttempts: attempt,
      },
      data: {
        sourceCleanupStatus: ImportSourceCleanupStatus.CLEANED,
        sourceCleanupNextAttemptAt: null,
        sourceCleanupError: null,
        sourceCleanedAt: new Date(),
      },
    });
  } catch (error) {
    const failed = await prisma.quizImportJob.updateMany({
      where: {
        id: candidate.id,
        sourceCleanupStatus: ImportSourceCleanupStatus.IN_PROGRESS,
        sourceCleanupAttempts: attempt,
      },
      data: {
        sourceCleanupStatus: ImportSourceCleanupStatus.FAILED,
        sourceCleanupNextAttemptAt:
          attempt < 5
            ? new Date(now.getTime() + Math.min(60, 2 ** attempt) * 60_000)
            : null,
        sourceCleanupError: (error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 2_000),
      },
    });
    if (failed.count === 1) console.error(
      JSON.stringify({
        event:
          attempt >= 5
            ? "quiz.import.orphan-object"
            : "quiz.import.source-cleanup-failed",
        importId: candidate.id,
        attempt,
      }),
    );
  }
  return true;
}

export async function processNextQuizImport(prisma: PrismaClient) {
  await processQuizImportSourceCleanup(prisma);
  await expireQuizImports(prisma);
  const acquired = await acquireQuizImportJob(prisma);
  if (!acquired) return false;
  const { job, phase } = acquired;
  const ownerToken = requiredQuizImportOwner(job);
  activeQuizJob = { id: job.id, phase, ownerToken };
  try {
    if (phase === "preflight") await runQuizImportPreflight(prisma, job);
    else if (job.cancelRequestedAt) {
      await compensateImportAssets(
        prisma,
        job,
        {
          stage: "CANCELLED",
          errorCode: "IMPORT_CANCELLED",
          errorMessage: "题库导入已取消",
        },
        { cancelled: true },
      );
    } else await runQuizImportCommit(prisma, job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Quiz import ${phase} ${job.id} failed: ${message}`);
    const current = await prisma.quizImportJob.findUnique({
      where: { id: job.id },
      select: {
        status: true,
        leaseOwnerToken: true,
        cancelRequestedAt: true,
      },
    });
    if (
      phase === "import" &&
      current?.status === QuizImportStatus.IMPORTING &&
      current.leaseOwnerToken === ownerToken &&
      current.cancelRequestedAt
    ) {
      await compensateImportAssets(
        prisma,
        job,
        {
          stage: "CANCELLED",
          errorCode: "IMPORT_CANCELLED",
          errorMessage: "题库导入已取消",
        },
        { cancelled: true },
      );
    } else if (job.attempts < 3) {
      await prisma.quizImportJob.updateMany({
        where: {
          id: job.id,
          status:
            phase === "preflight"
              ? QuizImportStatus.PREFLIGHTING
              : QuizImportStatus.IMPORTING,
          leaseOwnerToken: ownerToken,
          cancelRequestedAt: null,
        },
        data: {
          status:
            phase === "preflight"
              ? QuizImportStatus.PREFLIGHT_PENDING
              : QuizImportStatus.IMPORT_PENDING,
          stage: "RETRY_PENDING",
          leaseOwnerToken: null,
          leasedUntil: null,
          errorCode: "TRANSIENT_FAILURE",
          errorMessage: "任务处理暂时失败，正在自动重试",
        },
      });
    } else if (phase === "preflight") {
      await prisma.quizImportJob.updateMany({
        where: {
          id: job.id,
          status: QuizImportStatus.PREFLIGHTING,
          leaseOwnerToken: ownerToken,
          cancelRequestedAt: null,
        },
        data: {
          status: QuizImportStatus.FAILED,
          stage: "FAILED",
          leaseOwnerToken: null,
          leasedUntil: null,
          errorCode: "PREFLIGHT_FAILED",
          errorMessage: "题目包预检失败，请重新上传",
          completedAt: new Date(),
          sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
          sourceCleanupNextAttemptAt: new Date(),
        },
      });
    } else {
      await compensateImportAssets(prisma, job, {
        stage: "FAILED",
        errorCode: "IMPORT_FAILED",
        errorMessage: "题目导入失败，本任务已上传图片已清理",
      });
    }
  } finally {
    activeQuizJob = null;
  }
  return true;
}

export async function releaseActiveQuizImport(prisma: PrismaClient) {
  const active = activeQuizJob;
  if (!active) return;
  await prisma.quizImportJob.updateMany({
    where: {
      id: active.id,
      leaseOwnerToken: active.ownerToken,
      cancelRequestedAt: null,
      status:
        active.phase === "preflight"
          ? QuizImportStatus.PREFLIGHTING
          : QuizImportStatus.IMPORTING,
    },
    data: {
      status:
        active.phase === "preflight"
          ? QuizImportStatus.PREFLIGHT_PENDING
          : QuizImportStatus.IMPORT_PENDING,
      stage: "RETRY_PENDING",
      leaseOwnerToken: null,
      leasedUntil: null,
    },
  });
}
