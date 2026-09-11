import {
  AccountStatus,
  QuizImportFileType,
  QuizImportMode,
  QuizImportStatus,
  Role,
  type User,
} from "@prisma/client";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { QuizImportService } from "./quiz-import.service";

const owner = {
  id: "editor-1",
  displayName: "测试编辑",
  studentNumberHash: "hash",
  studentNumberEncrypted: "encrypted",
  passwordHash: "password-hash",
  role: Role.EDITOR,
  status: AccountStatus.ACTIVE,
  createdAt: new Date(),
  updatedAt: new Date(),
  approvedAt: new Date(),
} satisfies User;

function importJob(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-25T00:00:00.000Z");
  return {
    id: "import-1",
    createdById: owner.id,
    confirmedById: null,
    fileType: QuizImportFileType.CSV,
    mode: QuizImportMode.BANK,
    sourceObjectKey: "quiz-imports/source.csv",
    sourceName: "questions.csv",
    sourceSize: 100,
    sourceSha256: "a".repeat(64),
    createMissingChapters: false,
    targetSubjectId: null,
    targetPastPaperId: null,
    pastPaperTitle: null,
    pastPaperYear: null,
    status: QuizImportStatus.AWAITING_CONFIRMATION,
    stage: "READY_FOR_CONFIRMATION",
    progressCurrent: 0,
    progressTotal: 0,
    questionCount: 1,
    imageCount: 0,
    warningCount: 0,
    errorCount: 0,
    summary: null,
    attempts: 0,
    reservedQuestionCount: 0,
    leaseOwnerToken: null,
    leasedUntil: null,
    sourceCleanupStatus: "RETAINED",
    sourceCleanupAttempts: 0,
    sourceCleanupNextAttemptAt: null,
    sourceCleanupError: null,
    sourceCleanedAt: null,
    errorCode: null,
    errorMessage: null,
    importedCount: 0,
    createdChapterCount: 0,
    resultPastPaperId: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    confirmedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function serviceWith(job = importJob()) {
  const transaction = {
    quizImportJob: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    quizCapacityCounter: {
      upsert: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        activeQuestions: 0,
        reservedQuestions: 0,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    quizQuestion: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn().mockResolvedValue([{ singletonId: 1 }]),
  };
  const prisma = {
    quizImportJob: {
      findUnique: jest.fn().mockResolvedValue(job),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    quizImportIssue: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    quizPaper: { findUnique: jest.fn() },
    $transaction: jest.fn(
      async (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
    ),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const storage = {};
  return {
    service: new QuizImportService(
      prisma as never,
      storage as never,
      audit as never,
    ),
    prisma,
    transaction,
    audit,
  };
}

describe("QuizImportService access and confirmation", () => {
  it("allows the owner and an administrator, but rejects another editor", async () => {
    const { service } = serviceWith();
    const visible = await service.get(owner, "import-1");
    expect(visible).toMatchObject({ id: "import-1" });
    expect(visible).not.toHaveProperty("sourceObjectKey");
    expect(visible).not.toHaveProperty("sourceSha256");
    expect(visible).not.toHaveProperty("leasedUntil");
    await expect(
      service.get({ ...owner, id: "editor-2" }, "import-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.get({ ...owner, id: "admin-1", role: Role.ADMIN }, "import-1"),
    ).resolves.toMatchObject({ id: "import-1" });
  });

  it("confirms an awaiting task once and rejects a repeated state transition", async () => {
    const first = serviceWith();
    await first.service.confirm(owner, "import-1");
    expect(first.transaction.quizImportJob.updateMany).toHaveBeenCalledTimes(1);
    expect(first.audit.record).toHaveBeenCalledWith(
      owner.id,
      "quiz.import.confirm",
      "QuizImportJob",
      "import-1",
      undefined,
      first.transaction,
    );

    const queued = serviceWith(
      importJob({ status: QuizImportStatus.IMPORT_PENDING }),
    );
    await expect(
      queued.service.confirm(owner, "import-1"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(queued.transaction.quizImportJob.updateMany).not.toHaveBeenCalled();
    expect(queued.audit.record).not.toHaveBeenCalled();
  });

  it("rolls back the capacity reservation when the status CAS loses", async () => {
    const setup = serviceWith();
    setup.transaction.quizImportJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      setup.service.confirm(owner, "import-1"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(setup.transaction.quizCapacityCounter.update).not.toHaveBeenCalled();
    expect(setup.audit.record).not.toHaveBeenCalled();
  });

  it("immediately cancels preflight work and queues source cleanup", async () => {
    const setup = serviceWith(
      importJob({ status: QuizImportStatus.PREFLIGHTING }),
    );

    await setup.service.cancel(owner, "import-1");

    expect(setup.transaction.quizImportJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "import-1",
          status: QuizImportStatus.PREFLIGHTING,
          cancelRequestedAt: null,
        }),
        data: expect.objectContaining({
          status: QuizImportStatus.EXPIRED,
          stage: "CANCELLED",
          sourceCleanupStatus: "PENDING",
        }),
      }),
    );
    expect(setup.audit.record).toHaveBeenCalledWith(
      owner.id,
      "quiz.import.cancel",
      "QuizImportJob",
      "import-1",
      { immediate: true },
      setup.transaction,
    );
  });

  it("exports UTF-8 issue CSV with spreadsheet formula prefixes neutralized", async () => {
    const setup = serviceWith();
    setup.prisma.quizImportIssue.findMany.mockResolvedValue([
      {
        severity: "ERROR",
        code: "TEST",
        rowNumber: 2,
        filePath: "+SUM(A1:A2)",
        field: "prompt",
        message: "  =cmd|' /C calc'!A0",
      },
    ]);

    const csv = await setup.service.issueCsv(owner, "import-1");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"\'+SUM(A1:A2)"');
    expect(csv).toContain("\"'  =cmd|' /C calc'!A0\"");
  });
});
