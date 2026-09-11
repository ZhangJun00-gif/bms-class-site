import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { KnowledgeVersionsService } from './knowledge-versions.service';

function serviceWith(prisma: Record<string, unknown>, vectors = {}) {
  return new KnowledgeVersionsService(
    prisma as never,
    { assertManage: jest.fn().mockResolvedValue({}) } as never,
    vectors as never,
    { record: jest.fn() } as never,
    { remove: jest.fn() } as never,
  );
}

describe('KnowledgeVersionsService', () => {
  it('publishes only a READY candidate', async () => {
    const vectors = { setVersionActive: jest.fn() };
    const findVersion = jest.fn().mockResolvedValue(null);
    const service = serviceWith(
      {
        knowledgeDocument: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'document-1',
            libraryId: 'library-1',
            activeVersionId: null,
            library: { scope: 'SHARED' },
          }),
        },
        knowledgeDocumentVersion: { findFirst: findVersion },
      },
      vectors,
    );

    await expect(
      service.publish({ id: 'editor-1' } as never, 'document-1', 'version-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          indexStatus: 'READY',
          renderStatus: 'READY',
        }),
      }),
    );
    expect(vectors.setVersionActive).not.toHaveBeenCalled();
  });

  it('queues Qdrant activity reconciliation when the MySQL publish transaction fails', async () => {
    const vectors = {
      setVersionActive: jest.fn().mockResolvedValue(undefined),
    };
    const service = serviceWith(
      {
        knowledgeDocument: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'document-1',
            libraryId: 'library-1',
            activeVersionId: 'version-old',
            library: { scope: 'SHARED' },
          }),
          findUnique: jest.fn().mockResolvedValue({
            activeVersionId: 'version-old',
          }),
        },
        knowledgeDocumentVersion: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'version-new',
            title: '新版本',
            indexStatus: 'READY',
          }),
        },
        indexJob: { upsert: jest.fn().mockResolvedValue({}) },
        $transaction: jest.fn().mockRejectedValue(new Error('database failed')),
      },
      vectors,
    );

    await expect(
      service.publish({ id: 'editor-1' } as never, 'document-1', 'version-new'),
    ).rejects.toThrow('database failed');
    expect(vectors.setVersionActive).toHaveBeenCalledWith('version-new', true);
  });

  it('does not enqueue deletion for the active version', async () => {
    const versionFind = jest.fn();
    const service = serviceWith({
      knowledgeDocument: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'document-1',
          libraryId: 'library-1',
          activeVersionId: 'version-active',
          library: { scope: 'SHARED' },
        }),
      },
      knowledgeDocumentVersion: { findFirst: versionFind },
    });

    await expect(
      service.removeVersion(
        { id: 'editor-1' } as never,
        'document-1',
        'version-active',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(versionFind).not.toHaveBeenCalled();
  });

  it('uses a stable idempotency key for document cleanup', async () => {
    const transaction = {
      knowledgeDocument: { update: jest.fn().mockResolvedValue({}) },
      knowledgeImportJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      indexJob: { upsert: jest.fn().mockResolvedValue({}) },
      quizQuestionKnowledgeSource: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      quizQuestion: { updateMany: jest.fn() },
    };
    const prisma = {
      knowledgeDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'document-1',
          libraryId: 'library-1',
          activeVersionId: null,
          library: { scope: 'SHARED' },
        }),
      },
      $transaction: jest.fn(
        async (action: (tx: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const service = new KnowledgeVersionsService(
      prisma as never,
      { assertManage: jest.fn().mockResolvedValue({}) } as never,
      {} as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      { remove: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await service.removeDocument({ id: 'editor-1' } as never, 'document-1');

    expect(transaction.indexJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: 'delete-document:document-1' },
      }),
    );
  });

  it('does not let an administrator retry another member private cleanup', async () => {
    const service = serviceWith({
      indexJob: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cleanup-1',
          status: 'FAILED',
          operation: 'DELETE_DOCUMENT_VECTORS',
          document: {
            library: { scope: 'PRIVATE', ownerId: 'owner-1' },
          },
        }),
      },
    });

    await expect(
      service.retryCleanup(
        { id: 'admin-1', role: 'ADMIN' } as never,
        'cleanup-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
