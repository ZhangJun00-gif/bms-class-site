import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKnowledgeMarkdown } from '@bmc3/knowledge-core';

describe('knowledge import worker', () => {
  let root: string;
  let worker: typeof import('./knowledge-import');

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'bmc3-knowledge-worker-'));
    process.env.LOCAL_UPLOAD_DIR = root;
    jest.resetModules();
    worker = await import('./knowledge-import');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    delete process.env.LOCAL_UPLOAD_DIR;
  });

  it('rejects a private library before any model or Qdrant work when AI is disabled', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: 'library-1',
      scope: 'PRIVATE',
      active: true,
      deletedAt: null,
      aiEnabled: false,
    });

    await expect(
      worker.knowledgeImportInternals.assertLibraryAiAccess(
        { knowledgeLibrary: { findUnique } } as never,
        'library-1',
      ),
    ).rejects.toThrow('LIBRARY_AI_ACCESS_REVOKED');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('stops an active import as soon as cancellation is observed', async () => {
    await expect(
      worker.knowledgeImportInternals.assertImportContinuing(
        {
          knowledgeImportJob: {
            findUnique: jest.fn().mockResolvedValue({
              status: 'PROCESSING',
              cancelRequestedAt: new Date(),
            }),
          },
        } as never,
        'import-cancelled',
      ),
    ).rejects.toThrow('IMPORT_CANCELLED');
  });

  it('moves a valid Markdown preflight to AWAITING_CONFIRMATION', async () => {
    const key = 'knowledge-imports/preflight.md';
    const path = join(root, ...key.split('/'));
    const markdown = '# 组织学\n\n## 肝脏\n\n肝小叶是肝脏的基本结构单位。';
    await fs.mkdir(join(root, 'knowledge-imports'), { recursive: true });
    await fs.writeFile(path, markdown, 'utf8');
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      knowledgeImportIssue: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      knowledgeImportAsset: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      knowledgeImportJob: { updateMany },
    };
    const prisma = {
      knowledgeDocument: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      knowledgeImportJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(
        async (action: (tx: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const source = Buffer.from(markdown, 'utf8');

    await worker.runKnowledgeImportPreflight(prisma as never, {
      id: 'import-1',
      fileType: 'MARKDOWN',
      sourceObjectKey: key,
      sourceSize: source.length,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      leaseOwnerToken: 'owner-1',
    } as never);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'import-1',
          leaseOwnerToken: 'owner-1',
        }),
        data: expect.objectContaining({
          status: 'AWAITING_CONFIRMATION',
          stage: 'READY_FOR_CONFIRMATION',
          imageCount: 0,
        }),
      }),
    );
  });

  it('selects one logical document for whole-file H2 replacement', async () => {
    const parse = parseKnowledgeMarkdown(
      '# 新版本\n\n## 肝脏\n\n替换后的完整内容。',
      { allowImages: false },
    );
    const result = await worker.knowledgeImportInternals.resolveH2Replacement(
      {
        knowledgeDocument: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'document-1',
              title: '旧版本',
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              activeVersionId: 'version-1',
              activeVersion: { nodes: [{ title: '肝脏' }] },
            },
          ]),
        },
      } as never,
      { libraryId: 'library-1', targetDocumentId: null },
      parse,
    );

    expect(result.issue).toBeUndefined();
    expect(result.preview).toMatchObject({
      mode: 'REPLACE',
      targetDocumentId: 'document-1',
      activeVersionId: 'version-1',
      matchedH2Titles: ['肝脏'],
    });
  });

  it('rejects an upload whose H2 titles belong to multiple documents', async () => {
    const parse = parseKnowledgeMarkdown(
      '# 新版本\n\n## 肝脏\n\n内容。\n\n## 肾脏\n\n内容。',
      { allowImages: false },
    );
    const result = await worker.knowledgeImportInternals.resolveH2Replacement(
      {
        knowledgeDocument: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'document-1',
              title: '文档一',
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              activeVersionId: 'version-1',
              activeVersion: { nodes: [{ title: '肝脏' }] },
            },
            {
              id: 'document-2',
              title: '文档二',
              createdAt: new Date('2026-02-01T00:00:00.000Z'),
              activeVersionId: 'version-2',
              activeVersion: { nodes: [{ title: '肾脏' }] },
            },
          ]),
        },
      } as never,
      { libraryId: 'library-1', targetDocumentId: null },
      parse,
    );

    expect(result.issue).toMatchObject({
      severity: 'ERROR',
      code: 'H2_REPLACEMENT_AMBIGUOUS',
    });
  });

  it('recovers an expired preflight lease with a compare-and-set claim', async () => {
    const stale = new Date(Date.now() - 60_000);
    let claimedOwner = '';
    const updateMany = jest.fn().mockImplementation(async (args) => {
      claimedOwner = args.data.leaseOwnerToken;
      return { count: 1 };
    });
    const job = {
      id: 'import-lease',
      status: 'PREFLIGHTING',
      leasedUntil: stale,
      createdAt: stale,
    };
    const result = await worker.acquireKnowledgeImportJob({
      knowledgeImportJob: {
        findFirst: jest.fn().mockResolvedValue(job),
        updateMany,
        findUnique: jest.fn().mockImplementation(async () => ({
          ...job,
          leaseOwnerToken: claimedOwner,
        })),
      },
    } as never);

    expect(result?.phase).toBe('preflight');
    expect(result?.job.leaseOwnerToken).toBe(claimedOwner);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'import-lease' }),
        data: expect.objectContaining({ status: 'PREFLIGHTING' }),
      }),
    );
  });

  it('leaves the source key as an orphan after the fifth cleanup failure', async () => {
    const key = 'knowledge-imports/orphan-source';
    const path = join(root, ...key.split('/'));
    await fs.mkdir(path, { recursive: true });
    await fs.writeFile(join(path, 'keep.txt'), 'still present', 'utf8');
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const now = new Date('2026-08-10T00:00:00.000Z');
    const errorLog = jest.spyOn(console, 'error').mockImplementation();

    await expect(
      worker.processKnowledgeImportSourceCleanup(
        {
          knowledgeImportJob: {
            updateMany,
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue({
              id: 'import-orphan',
              sourceObjectKey: key,
              sourceCleanupStatus: 'FAILED',
              sourceCleanupAttempts: 4,
              sourceCleanupNextAttemptAt: now,
              createdAt: now,
            }),
          },
        } as never,
        now,
      ),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'import-orphan',
          sourceCleanupAttempts: 5,
        }),
        data: expect.objectContaining({
          sourceCleanupStatus: 'FAILED',
          sourceCleanupNextAttemptAt: null,
        }),
      }),
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('knowledge.orphan-object'),
    );
    errorLog.mockRestore();
  });

  it('promotes at most one retained terminal source per cleanup call', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z');
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findMany = jest.fn().mockResolvedValue([{ id: 'retained-import' }]);

    await expect(
      worker.processKnowledgeImportSourceCleanup(
        {
          knowledgeImportJob: {
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

});
