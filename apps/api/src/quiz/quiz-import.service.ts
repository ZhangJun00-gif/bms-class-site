import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ImportSourceCleanupStatus,
  Prisma,
  QuizImportFileType,
  QuizImportMode,
  QuizImportStatus,
  Role,
  type QuizImportJob,
  type User,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { AuditService } from "../common/audit.service";
import { PrismaService } from "../database/prisma.service";
import { StorageService } from "../storage/storage.service";

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const CONFIRM_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_QUIZ_TOTAL_QUESTION_LIMIT = 100_000;
const ACTIVE_STATUSES: QuizImportStatus[] = [
  QuizImportStatus.PREFLIGHT_PENDING,
  QuizImportStatus.PREFLIGHTING,
  QuizImportStatus.AWAITING_CONFIRMATION,
  QuizImportStatus.IMPORT_PENDING,
  QuizImportStatus.IMPORTING,
];

export interface CreateQuizImportInput {
  mode: QuizImportMode;
  createMissingChapters?: boolean;
  subjectId?: string;
  pastPaperId?: string;
  pastPaperTitle?: string;
  pastPaperYear?: number;
}

@Injectable()
export class QuizImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async create(
    user: User,
    file: Express.Multer.File | undefined,
    input: CreateQuizImportInput,
  ) {
    if (!file?.path) throw new BadRequestException("请选择 CSV 或 ZIP 文件");
    let stored: Awaited<ReturnType<StorageService["save"]>> | null = null;
    try {
      const fileType = await this.validateFile(file);
      await this.validateMode(input);
      const [userActive, totalActive] = await Promise.all([
        this.prisma.quizImportJob.count({
          where: { createdById: user.id, status: { in: ACTIVE_STATUSES } },
        }),
        this.prisma.quizImportJob.count({
          where: { status: { in: ACTIVE_STATUSES } },
        }),
      ]);
      if (userActive >= 2) {
        throw new BadRequestException("每人最多同时保留 2 个未完成导入任务");
      }
      if (totalActive >= 10) {
        throw new BadRequestException("当前导入队列已满，请稍后重试");
      }
      const sourceSha256 = await hashFile(file.path);
      stored = await this.storage.save(file, "quiz-imports");
      const job = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.quizImportJob.create({
          data: {
            createdById: user.id,
            fileType,
            mode: input.mode,
            sourceObjectKey: stored!.key,
            sourceName: file.originalname.normalize("NFC").slice(0, 255),
            sourceSize: stored!.size,
            sourceSha256,
            createMissingChapters: input.createMissingChapters ?? false,
            targetSubjectId:
              input.mode === QuizImportMode.NEW_PAPER ? input.subjectId : null,
            targetPastPaperId:
              input.mode === QuizImportMode.APPEND_PAPER
                ? input.pastPaperId
                : null,
            pastPaperTitle:
              input.mode === QuizImportMode.NEW_PAPER
                ? input.pastPaperTitle?.trim()
                : null,
            pastPaperYear:
              input.mode === QuizImportMode.NEW_PAPER
                ? input.pastPaperYear
                : null,
            expiresAt: new Date(Date.now() + CONFIRM_TTL_MS),
          },
        });
        await this.audit.record(
          user.id,
          "quiz.import.create",
          "QuizImportJob",
          created.id,
          {
            fileType,
            mode: input.mode,
            sourceSize: stored!.size,
          },
          transaction,
        );
        return created;
      });
      return this.serialize(job);
    } catch (error) {
      if (stored) await this.storage.remove(stored.key).catch(() => undefined);
      else await this.storage.discardUpload(file);
      throw error;
    }
  }

  async list(user: User, page: number, pageSize: number) {
    const where: Prisma.QuizImportJobWhereInput =
      user.role === Role.ADMIN ? {} : { createdById: user.id };
    const [items, total] = await Promise.all([
      this.prisma.quizImportJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.quizImportJob.count({ where }),
    ]);
    return {
      items: items.map((item) => this.serialize(item)),
      total,
      page,
      pageSize,
    };
  }

  async get(user: User, id: string) {
    const job = await this.findAccessible(user, id);
    const [issues, resultPastPaper] = await Promise.all([
      this.prisma.quizImportIssue.findMany({
        where: { importId: id },
        orderBy: { id: "asc" },
        take: 100,
      }),
      job.resultPastPaperId
        ? this.prisma.quizPaper.findUnique({
            where: { id: job.resultPastPaperId },
            select: {
              id: true,
              title: true,
              subjectId: true,
              subject: { select: { name: true } },
              year: true,
            },
          })
        : null,
    ]);
    return {
      ...this.serialize(job),
      issues,
      issuesTruncated: job.errorCount + job.warningCount > issues.length,
      resultPastPaper: resultPastPaper
        ? { ...resultPastPaper, subject: resultPastPaper.subject.name }
        : null,
    };
  }

  async confirm(user: User, id: string) {
    const job = await this.findAccessible(user, id);
    if (
      job.status === QuizImportStatus.IMPORT_PENDING ||
      job.status === QuizImportStatus.IMPORTING ||
      job.status === QuizImportStatus.COMPLETED
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: "QUIZ_IMPORT_STATUS_CHANGED",
        message: "任务状态已变化，请刷新后重试",
      });
    }
    if (job.status !== QuizImportStatus.AWAITING_CONFIRMATION) {
      throw new BadRequestException("当前任务状态不能确认导入");
    }
    if (job.expiresAt <= new Date()) {
      await this.prisma.quizImportJob.updateMany({
        where: {
          id,
          status: QuizImportStatus.AWAITING_CONFIRMATION,
          expiresAt: { lte: new Date() },
        },
        data: {
          status: QuizImportStatus.EXPIRED,
          stage: "EXPIRED",
          completedAt: new Date(),
          sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
          sourceCleanupNextAttemptAt: new Date(),
        },
      });
      throw new BadRequestException("预检结果已过期，请重新上传");
    }
    await this.prisma.$transaction(
      async (transaction) => {
        await transaction.quizCapacityCounter.upsert({
          where: { singletonId: 1 },
          create: { singletonId: 1 },
          update: {},
        });
        await transaction.$queryRaw(
          Prisma.sql`SELECT singletonId FROM QuizCapacityCounter WHERE singletonId = 1 FOR UPDATE`,
        );
        const [current, activeQuestions] = await Promise.all([
          transaction.quizCapacityCounter.findUniqueOrThrow({
            where: { singletonId: 1 },
          }),
          transaction.quizQuestion.count(),
        ]);
        const limit = quizTotalQuestionLimit();
        if (
          activeQuestions + current.reservedQuestions + job.questionCount >
          limit
        ) {
          throw new ConflictException({
            statusCode: 409,
            code: "QUIZ_CAPACITY_EXCEEDED",
            message: `题库总容量不足，当前及已预留 ${activeQuestions + current.reservedQuestions} 题，上限 ${limit} 题`,
          });
        }
        const changed = await transaction.quizImportJob.updateMany({
          where: {
            id,
            status: QuizImportStatus.AWAITING_CONFIRMATION,
            expiresAt: { gt: new Date() },
          },
          data: {
            status: QuizImportStatus.IMPORT_PENDING,
            stage: "QUEUED_FOR_IMPORT",
            confirmedById: user.id,
            confirmedAt: new Date(),
            attempts: 0,
            reservedQuestionCount: job.questionCount,
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException({
            statusCode: 409,
            code: "QUIZ_IMPORT_STATUS_CHANGED",
            message: "任务状态已变化，请刷新后重试",
          });
        }
        await transaction.quizCapacityCounter.update({
          where: { singletonId: 1 },
          data: {
            activeQuestions,
            reservedQuestions: { increment: job.questionCount },
          },
        });
        await this.audit.record(
          user.id,
          "quiz.import.confirm",
          "QuizImportJob",
          id,
          undefined,
          transaction,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return this.get(user, id);
  }

  async cancel(user: User, id: string) {
    const job = await this.findAccessible(user, id);
    if (
      ([
        QuizImportStatus.COMPLETED,
        QuizImportStatus.INVALID,
        QuizImportStatus.FAILED,
        QuizImportStatus.COMPENSATION_FAILED,
        QuizImportStatus.EXPIRED,
      ] as QuizImportStatus[]).includes(job.status)
    ) {
      return this.get(user, id);
    }
    if (job.cancelRequestedAt) return this.get(user, id);

    const now = new Date();
    const stopImmediately = (
      [
        QuizImportStatus.PREFLIGHT_PENDING,
        QuizImportStatus.PREFLIGHTING,
        QuizImportStatus.AWAITING_CONFIRMATION,
      ] as QuizImportStatus[]
    ).includes(job.status);
    await this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.quizImportJob.updateMany({
        where: {
          id,
          status: job.status,
          cancelRequestedAt: null,
        },
        data: stopImmediately
          ? {
              status: QuizImportStatus.EXPIRED,
              stage: "CANCELLED",
              cancelRequestedAt: now,
              leaseOwnerToken: null,
              leasedUntil: null,
              completedAt: now,
              sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
              sourceCleanupNextAttemptAt: now,
            }
          : { cancelRequestedAt: now },
      });
      if (changed.count !== 1) {
        throw new ConflictException({
          statusCode: 409,
          code: "QUIZ_IMPORT_STATUS_CHANGED",
          message: "任务状态已变化，请刷新后重试",
        });
      }
      await this.audit.record(
        user.id,
        "quiz.import.cancel",
        "QuizImportJob",
        id,
        { immediate: stopImmediately },
        transaction,
      );
    });
    return this.get(user, id);
  }

  async issueCsv(user: User, id: string) {
    await this.findAccessible(user, id);
    const issues = await this.prisma.quizImportIssue.findMany({
      where: { importId: id },
      orderBy: { id: "asc" },
    });
    const rows = [
      ["severity", "code", "rowNumber", "filePath", "field", "message"],
      ...issues.map((item) => [
        item.severity,
        item.code,
        item.rowNumber?.toString() ?? "",
        item.filePath ?? "",
        item.field ?? "",
        item.message,
      ]),
    ];
    return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  }

  async orphanReport() {
    const items = await this.prisma.quizImportAsset.findMany({
      where: { status: "ORPHANED" },
      select: {
        id: true,
        importId: true,
        filePath: true,
        objectKey: true,
        cleanupError: true,
        updatedAt: true,
        importJob: {
          select: { status: true, sourceName: true, createdAt: true },
        },
      },
      orderBy: { updatedAt: "asc" },
    });
    return {
      generatedAt: new Date().toISOString(),
      total: items.length,
      items,
    };
  }

  private async validateFile(file: Express.Multer.File) {
    const extension = extname(file.originalname).toLowerCase();
    if (extension !== ".csv" && extension !== ".zip") {
      throw new BadRequestException("仅支持 CSV 或 ZIP 题目包");
    }
    if (extension === ".csv" && file.size > MAX_CSV_BYTES) {
      throw new BadRequestException("CSV 文件超过 2MB 限制");
    }
    if (file.size > MAX_ZIP_BYTES) {
      throw new BadRequestException("ZIP 文件超过 200MB 限制");
    }
    if (extension === ".zip") {
      const handle = await fs.open(file.path, "r");
      try {
        const signature = Buffer.alloc(4);
        await handle.read(signature, 0, 4, 0);
        if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
          throw new BadRequestException("ZIP 文件签名无效");
        }
      } finally {
        await handle.close();
      }
    }
    return extension === ".csv"
      ? QuizImportFileType.CSV
      : QuizImportFileType.ZIP;
  }

  private async validateMode(input: CreateQuizImportInput) {
    if (input.mode === QuizImportMode.BANK) {
      if (
        input.subjectId ||
        input.pastPaperId ||
        input.pastPaperTitle ||
        input.pastPaperYear
      ) {
        throw new BadRequestException("普通题库导入不能指定往年真题信息");
      }
      return;
    }
    if (input.mode === QuizImportMode.NEW_PAPER) {
      const title = input.pastPaperTitle?.trim() ?? "";
      if (
        !input.subjectId ||
        !title ||
        title.length > 160 ||
        input.pastPaperId
      ) {
        throw new BadRequestException("新建往年真题必须指定有效标题和学科");
      }
      if (
        input.pastPaperYear !== undefined &&
        (!Number.isInteger(input.pastPaperYear) ||
          input.pastPaperYear < 1900 ||
          input.pastPaperYear > 2200)
      ) {
        throw new BadRequestException("往年真题年份必须是 1900-2200 的整数");
      }
      const subject = await this.prisma.subject.findFirst({
        where: { id: input.subjectId, active: true },
        select: { id: true },
      });
      if (!subject) throw new BadRequestException("往年真题学科不存在或已停用");
      return;
    }
    if (
      !input.pastPaperId ||
      input.subjectId ||
      input.pastPaperTitle ||
      input.pastPaperYear
    ) {
      throw new BadRequestException("追加往年真题必须且只能指定目标试卷");
    }
    const paper = await this.prisma.quizPaper.findUnique({
      where: { id: input.pastPaperId },
      select: { id: true },
    });
    if (!paper) throw new BadRequestException("目标往年真题试卷不存在");
  }

  private async findAccessible(user: User, id: string) {
    const job = await this.prisma.quizImportJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException("导入任务不存在");
    if (user.role !== Role.ADMIN && job.createdById !== user.id) {
      throw new ForbiddenException("无权访问该导入任务");
    }
    return job;
  }

  private serialize(job: QuizImportJob) {
    return {
      id: job.id,
      fileType: job.fileType,
      mode: job.mode,
      sourceName: job.sourceName,
      sourceSize: job.sourceSize,
      status: job.status,
      stage: job.stage,
      progressCurrent: job.progressCurrent,
      progressTotal: job.progressTotal,
      questionCount: job.questionCount,
      imageCount: job.imageCount,
      warningCount: job.warningCount,
      errorCount: job.errorCount,
      summary: job.summary,
      importedCount: job.importedCount,
      createdChapterCount: job.createdChapterCount,
      resultPastPaperId: job.resultPastPaperId,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
      sourceCleanupStatus: job.sourceCleanupStatus,
      sourceCleanupAttempts: job.sourceCleanupAttempts,
      sourceCleanupNextAttemptAt:
        job.sourceCleanupNextAttemptAt?.toISOString() ?? null,
      sourceCleanupError: job.sourceCleanupError,
      sourceCleanedAt: job.sourceCleanedAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      expiresAt: job.expiresAt.toISOString(),
      confirmedAt: job.confirmedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }
}

function quizTotalQuestionLimit() {
  const parsed = Number(
    process.env.QUIZ_TOTAL_QUESTION_LIMIT ?? DEFAULT_QUIZ_TOTAL_QUESTION_LIMIT,
  );
  return Number.isInteger(parsed) && parsed >= 5_000
    ? parsed
    : DEFAULT_QUIZ_TOTAL_QUESTION_LIMIT;
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function csvCell(value: string) {
  const protectedValue = /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${protectedValue.replace(/"/g, '""')}"`;
}
