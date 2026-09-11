import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizImportStatus } from '@prisma/client';

describe('quiz import worker lifecycle', () => {
  let root: string;
  let worker: typeof import('./quiz-import');

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'bmc3-quiz-import-worker-'));
    process.env.LOCAL_UPLOAD_DIR = root;
    process.env.MEDIA_STORAGE_PROVIDER = 'database';
    jest.resetModules();
    worker = await import('./quiz-import');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    delete process.env.LOCAL_UPLOAD_DIR;
    delete process.env.MEDIA_STORAGE_PROVIDER;
  });

  it('reclaims an expired import lease with a new verified owner token', async () => {
    const stale = new Date(Date.now() - 60_000);
    let claimedOwner = '';
    const candidate = {
      id: 'quiz-import-lease',
      status: QuizImportStatus.IMPORTING,
      leasedUntil: stale,
      createdAt: stale,
    };
    const updateMany = jest.fn().mockImplementation(async (args) => {
      claimedOwner = args.data.leaseOwnerToken;
      return { count: 1 };
    });

    const result = await worker.acquireQuizImportJob({
      quizImportJob: {
        findFirst: jest.fn().mockResolvedValue(candidate),
        updateMany,
        findUnique: jest.fn().mockImplementation(async () => ({
          ...candidate,
          leaseOwnerToken: claimedOwner,
        })),
      },
    } as never);

    expect(result?.phase).toBe('import');
    expect(result?.job.leaseOwnerToken).toBe(claimedOwner);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'quiz-import-lease' }),
        data: expect.objectContaining({
          status: QuizImportStatus.IMPORTING,
          leaseOwnerToken: claimedOwner,
        }),
      }),
    );
  });

  it('promotes at most one retained terminal source per cleanup call', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z');
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findMany = jest.fn().mockResolvedValue([{ id: 'retained-import' }]);

    await expect(
      worker.processQuizImportSourceCleanup(
        {
          quizImportJob: {
            findMany,
            findFirst: jest.fn().mockResolvedValue(null),
            updateMany,
          },
        } as never,
        now,
      ),
    ).resolves.toBe(false);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1, select: { id: true } }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'retained-import' }),
        data: {
          sourceCleanupStatus: 'PENDING',
          sourceCleanupNextAttemptAt: now,
        },
      }),
    );
  });

  it('cancels a confirmed import and releases its reserved capacity', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z');
    const candidate = {
      id: 'quiz-import-cancel',
      status: QuizImportStatus.IMPORT_PENDING,
      attempts: 0,
      createdAt: now,
      cancelRequestedAt: now,
      createdById: 'editor-1',
      confirmedById: 'editor-1',
      sourceObjectKey: 'quiz-imports/cancel.csv',
    };
    let claimedOwner = '';
    const jobUpdateMany = jest.fn().mockImplementation(async (args) => {
      if (args.data?.leaseOwnerToken) {
        claimedOwner = args.data.leaseOwnerToken;
      }
      return { count: 1 };
    });
    const transaction = {
      quizImportJob: {
        findUnique: jest.fn().mockResolvedValue({ reservedQuestionCount: 3 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quizCapacityCounter: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      quizImportJob: {
        updateMany: jobUpdateMany,
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(candidate),
        findUnique: jest.fn().mockImplementation(async () => ({
          ...candidate,
          status: QuizImportStatus.IMPORTING,
          leaseOwnerToken: claimedOwner,
        })),
      },
      quizImportAsset: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(
        async (action: (tx: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };

    await expect(worker.processNextQuizImport(prisma as never)).resolves.toBe(
      true,
    );

    expect(transaction.quizImportJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: candidate.id,
          status: QuizImportStatus.IMPORTING,
          leaseOwnerToken: claimedOwner,
        }),
        data: expect.objectContaining({
          status: QuizImportStatus.EXPIRED,
          stage: 'CANCELLED',
          reservedQuestionCount: 0,
          sourceCleanupStatus: 'PENDING',
        }),
      }),
    );
    expect(transaction.quizCapacityCounter.updateMany).toHaveBeenCalledWith({
      where: { singletonId: 1 },
      data: { reservedQuestions: { decrement: 3 } },
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'quiz.import.cancelled',
          metadata: { compensationFailed: false },
        }),
      }),
    );
  });

  it('retains the source and reports compensation failure when an asset cannot be removed', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z');
    const jobId = 'quiz-import-compensation-failed';
    const assetId = 'asset-1';
    const staged = join(
      root,
      'quiz-imports',
      jobId,
      'processed',
      `${assetId}.webp`,
    );
    await fs.mkdir(staged, { recursive: true });
    await fs.writeFile(join(staged, 'keep.txt'), 'not removable as a file');
    const candidate = {
      id: jobId,
      status: QuizImportStatus.IMPORT_PENDING,
      attempts: 0,
      createdAt: now,
      cancelRequestedAt: now,
      createdById: 'editor-1',
      confirmedById: 'editor-1',
      sourceObjectKey: 'quiz-imports/source.zip',
    };
    let claimedOwner = '';
    const jobUpdateMany = jest.fn().mockImplementation(async (args) => {
      if (args.data?.leaseOwnerToken) claimedOwner = args.data.leaseOwnerToken;
      return { count: 1 };
    });
    const transaction = {
      quizImportJob: {
        findUnique: jest.fn().mockResolvedValue({ reservedQuestionCount: 2 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quizCapacityCounter: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const assetUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      quizImportJob: {
        updateMany: jobUpdateMany,
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(candidate),
        findUnique: jest.fn().mockImplementation(async () => ({
          ...candidate,
          status: QuizImportStatus.IMPORTING,
          leaseOwnerToken: claimedOwner,
        })),
      },
      quizImportAsset: {
        findMany: jest.fn().mockResolvedValue([
          { id: assetId, objectKey: null },
        ]),
        update: assetUpdate,
      },
      $transaction: jest.fn(
        async (action: (tx: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const errorLog = jest.spyOn(console, 'error').mockImplementation();

    await expect(worker.processNextQuizImport(prisma as never)).resolves.toBe(
      true,
    );

    expect(assetUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: assetId },
        data: expect.objectContaining({ status: 'ORPHANED' }),
      }),
    );
    expect(transaction.quizImportJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: QuizImportStatus.COMPENSATION_FAILED,
          stage: 'COMPENSATION_FAILED',
          reservedQuestionCount: 0,
        }),
      }),
    );
    expect(transaction.quizCapacityCounter.updateMany).toHaveBeenCalledWith({
      where: { singletonId: 1 },
      data: { reservedQuestions: { decrement: 2 } },
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('quiz.import.orphan-object'),
    );
    errorLog.mockRestore();
  });
});
