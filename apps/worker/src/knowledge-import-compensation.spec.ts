import { type KnowledgeImportJob } from '@prisma/client';
import { knowledgeImportInternals } from './knowledge-import';

function fixture() {
  const job = {
    id: 'import-1', libraryId: 'library-1', status: 'PROCESSING', stage: 'INDEXING',
    leaseOwnerToken: 'owner-1', cancelRequestedAt: null,
    confirmedVersionId: 'version-1', reservedChunks: 2, reservedPoints: 2,
    reservedImages: 0, reservedMediaBytes: 0n,
  } as KnowledgeImportJob;
  const state = { version: true, points: 1, reserved: 2 };
  const updateMany = jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if (where.status !== job.status || where.leaseOwnerToken !== job.leaseOwnerToken) return { count: 0 };
    Object.assign(job, data);
    return { count: 1 };
  });
  const transaction = {
    knowledgeImportJob: { findUnique: jest.fn(async () => ({ ...job })), updateMany },
    knowledgeCapacityCounter: { updateMany: jest.fn(async ({ data }: { data: { reservedPoints: { decrement: number } } }) => {
      state.reserved -= data.reservedPoints.decrement;
      return { count: 1 };
    }) },
    $queryRaw: jest.fn(async () => [{ id: job.id }]),
  };
  const prisma = {
    ...transaction,
    knowledgeImportAsset: { findMany: jest.fn(async () => []) },
    knowledgeLibrary: { findUnique: jest.fn(async () => ({ scope: 'PUBLIC', ownerId: null })) },
    knowledgeDocumentVersion: {
      findUnique: jest.fn(async () => state.version ? { id: 'version-1', version: 2 } : null),
      deleteMany: jest.fn(async () => {
        state.version = false;
        job.confirmedVersionId = null;
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(async (action: (tx: typeof transaction) => Promise<unknown>) => {
      const before = structuredClone({ job, state });
      try { return await action(transaction); }
      catch (error) { Object.assign(job, before.job); Object.assign(state, before.state); throw error; }
    }),
  };
  const remove = jest.fn(async () => { state.points = 0; return { status: 'completed' }; });
  const deleteVersionVectors = (versionId: string) => knowledgeImportInternals.deleteKnowledgeVersionVectors(versionId, {
    collection: 'test-collection', client: { delete: remove },
  } as never);
  const compensate = (captured = { ...job }) => knowledgeImportInternals.compensate(prisma as never, captured, 'INDEX_FAILED', { deleteVersionVectors });
  return { job, state, prisma, transaction, remove, compensate };
}

describe('knowledge import vector compensation', () => {
  it.each(['exception', 'acknowledged'])('retains the exact version and reservations when deletion returns %s', async (failure) => {
    const test = fixture();
    if (failure === 'exception') test.remove.mockRejectedValueOnce(new Error('Qdrant unavailable'));
    else test.remove.mockResolvedValueOnce({ status: 'acknowledged' });
    await test.compensate();
    expect(test.state).toEqual({ version: true, points: 1, reserved: 2 });
    expect(test.job).toMatchObject({ status: 'COMPENSATION_FAILED', confirmedVersionId: 'version-1', reservedPoints: 2 });
    expect(test.prisma.knowledgeDocumentVersion.deleteMany).not.toHaveBeenCalled();
    test.job.status = 'PROCESSING';
    test.job.leaseOwnerToken = 'recovery-owner';
    await test.compensate();
    expect(test.remove).toHaveBeenLastCalledWith('test-collection', {
      wait: true, filter: { must: [{ key: 'documentVersionId', match: { value: 'version-1' } }] },
    });
    expect(test.state).toEqual({ version: false, points: 0, reserved: 0 });
    expect(test.job.status).toBe('FAILED');
  });

  it('keeps COMPENSATING durable before deletion and resumes an interrupted final settlement without double release', async () => {
    const test = fixture();
    const captured = { ...test.job };
    const update = test.transaction.knowledgeImportJob.updateMany.getMockImplementation()!;
    test.transaction.knowledgeImportJob.updateMany.mockImplementation(async (args) => {
      if (args.data.status === 'FAILED') throw new Error('settlement interrupted');
      return update(args);
    });
    test.remove.mockImplementation(async () => {
      expect(test.job.stage).toBe('COMPENSATING');
      test.state.points = 0;
      return { status: 'completed' };
    });
    await expect(test.compensate(captured)).rejects.toThrow('settlement interrupted');
    expect(test.state.reserved).toBe(0);
    expect(test.job.stage).toBe('COMPENSATING');
    test.transaction.knowledgeImportJob.updateMany.mockImplementation(update);
    await test.compensate(captured);
    expect(test.state.reserved).toBe(0);
    expect(test.job.status).toBe('FAILED');
  });

  it('allows cancellation cleanup while refusing stale ownership', async () => {
    const test = fixture();
    test.job.cancelRequestedAt = new Date();
    await expect(test.compensate({ ...test.job, leaseOwnerToken: 'old-owner' })).rejects.toThrow('IMPORT_CANCELLED');
    expect(test.remove).not.toHaveBeenCalled();
    await test.compensate();
    expect(test.state).toEqual({ version: false, points: 0, reserved: 0 });
  });

  it('preserves the reservation when ownership changes during vector deletion', async () => {
    const test = fixture();
    test.remove.mockImplementationOnce(async () => {
      test.job.leaseOwnerToken = 'new-owner';
      test.state.points = 0;
      return { status: 'completed' };
    });
    await test.compensate();
    expect(test.job.leaseOwnerToken).toBe('new-owner');
    expect(test.state).toEqual({ version: true, points: 0, reserved: 2 });
  });
});
