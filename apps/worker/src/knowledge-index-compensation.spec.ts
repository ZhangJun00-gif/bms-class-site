import { IndexStatus, type IndexJob, type Prisma } from '@prisma/client';
import {
  compensateFailedKnowledgeIndex,
  handleKnowledgeIndexFailure,
  knowledgeImportInternals,
  knowledgeIndexJobEligibility,
  KnowledgeIndexDependencyPendingError,
  processKnowledgeIndexOperation,
} from './knowledge-import';

function fixture() {
  const job = {
    id: 'index-1', operation: 'INDEX_VERSION', documentId: 'document-1',
    documentVersionId: 'version-1', status: IndexStatus.PROCESSING,
    stage: 'CAPACITY_RESERVED', attempts: 3, leaseOwnerToken: 'owner-1',
    leasedUntil: new Date(Date.now() + 60_000), error: null,
  } as IndexJob;
  const version = {
    id: 'version-1', chunkCount: 2, vectorCount: 0,
    indexStatus: IndexStatus.PENDING as IndexStatus,
    document: {
      id: 'document-1', deletedAt: null, activeVersionId: 'old-version',
      subject: { name: 'Subject' }, libraryId: 'library-1',
      library: { id: 'library-1', name: 'Library', scope: 'PRIVATE', ownerId: 'user-1' },
    },
  };
  const counters = Object.fromEntries(['GLOBAL', 'PRIVATE_GLOBAL', 'USER:user-1'].map((key) => [key, 2]));
  const points = new Map<string, string>([['old-point', 'old-version']]);
  type Where = {
    id?: string; operation?: string; leaseOwnerToken?: string | null;
    status?: string | { not?: string; in?: string[] };
    stage?: string | { in: string[] };
    leasedUntil?: null | { lt: Date };
    OR?: Where[];
  };
  const matches = (where: Where): boolean =>
    (!where.id || where.id === job.id) &&
    (!where.operation || where.operation === job.operation) &&
    (!('leaseOwnerToken' in where) || where.leaseOwnerToken === job.leaseOwnerToken) &&
    (!where.status || (typeof where.status === 'string' ? where.status === job.status : where.status.in ? where.status.in.includes(job.status) : where.status.not !== job.status)) &&
    (!where.stage || (typeof where.stage === 'string' ? where.stage === job.stage : where.stage.in.includes(job.stage))) &&
    (!('leasedUntil' in where) || (where.leasedUntil === null ? job.leasedUntil === null : Boolean(job.leasedUntil && job.leasedUntil < where.leasedUntil!.lt))) &&
    (!where.OR || where.OR.some(matches));
  const updateMany = jest.fn(async ({ where, data }: { where: Where; data: Partial<IndexJob> }) => {
    if (!matches(where)) return { count: 0 };
    Object.assign(job, data);
    return { count: 1 };
  });
  const transaction = {
    indexJob: { updateMany, count: jest.fn(async ({ where }: { where: Where }) => matches(where) ? 1 : 0) },
    knowledgeDocumentVersion: {
      findUnique: jest.fn(async () => version),
      updateMany: jest.fn(async ({ data }: { data: Partial<typeof version> }) => {
        Object.assign(version, data);
        return { count: 1 };
      }),
    },
    $executeRaw: jest.fn(async (query: Prisma.Sql) => {
      const key = String(query.values.at(-1));
      counters[key] = Math.max(counters[key]! - Number(query.values[0]), 0);
      return 1;
    }),
  };
  const prisma = {
    ...transaction,
    knowledgeLibrary: { findUnique: jest.fn(async () => ({ active: true, deletedAt: null, scope: 'PRIVATE', aiEnabled: true })) },
    knowledgeChunk: {
      findMany: jest.fn(async () => [0, 1].map((chunkIndex) => ({
        id: `chunk-${chunkIndex}`, contentHash: `hash-${chunkIndex}`, chunkIndex,
        content: `content-${chunkIndex}`, document: version.document,
        documentId: version.document.id, nodeId: `node-${chunkIndex}`,
        node: { libraryChapter: { name: 'Chapter' }, breadcrumb: 'Chapter', libraryChapterId: 'chapter-1' },
      }))),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    $transaction: jest.fn(async (action: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone({ job, version, counters });
      try {
        return await action({ ...transaction, knowledgeChunk: { updateMany: async () => ({ count: 1 }) } });
      } catch (error) {
        Object.assign(job, snapshot.job);
        Object.assign(version, snapshot.version);
        Object.assign(counters, snapshot.counters);
        throw error;
      }
    }),
  };
  const deletePoints = jest.fn(async (_collection: string, request: { wait: boolean; filter: { must: Array<{ key: string; match: { value: string } }> } }) => {
    const target = request.filter.must[0]!.match.value;
    for (const [id, versionId] of points) if (versionId === target) points.delete(id);
    return { status: 'completed' };
  });
  const runtime = { collection: 'test-collection', client: { delete: deletePoints } };
  const deleteVersionVectors = (versionId: string) =>
    knowledgeImportInternals.deleteKnowledgeVersionVectors(versionId, runtime as never);
  return { job, version, counters, points, prisma, transaction, deletePoints, deleteVersionVectors };
}

describe('failed version vector compensation', () => {
  it('honors cleanup retry times and expired ownership in both pending and processing queues', async () => {
    const state = fixture();
    const now = new Date();
    const where = knowledgeIndexJobEligibility(now);
    for (const status of [IndexStatus.PENDING, IndexStatus.PROCESSING]) {
      state.job.status = status;
      state.job.leasedUntil = new Date(now.getTime() + 60_000);
      expect(await state.transaction.indexJob.count({ where: where as never })).toBe(0);
      state.job.leasedUntil = new Date(now.getTime() - 1);
      expect(await state.transaction.indexJob.count({ where: where as never })).toBe(1);
      state.job.leasedUntil = null;
      expect(await state.transaction.indexJob.count({ where: where as never })).toBe(1);
    }
    state.job.status = IndexStatus.FAILED;
    expect(await state.transaction.indexJob.count({ where: where as never })).toBe(0);
  });

  it('deletes a partially indexed version before releasing all reserved counters exactly once', async () => {
    const state = fixture();
    const originalBatchSize = process.env.EMBEDDING_BATCH_SIZE;
    process.env.EMBEDDING_BATCH_SIZE = '1';
    const embed = jest.fn().mockResolvedValueOnce([[0.5]]).mockRejectedValueOnce(new Error('second batch failed'));
    const upsert = jest.fn(async (_collection: string, request: { points: Array<{ id: string; payload: { documentVersionId: string } }> }) => {
      for (const point of request.points) state.points.set(point.id, point.payload.documentVersionId);
      return { status: 'completed' };
    });
    const capturedJob = { ...state.job };
    try {
      await expect(knowledgeImportInternals.indexVectors(state.prisma as never, {
        libraryId: 'library-1', progressIndexJobId: state.job.id,
        progressIndexOwnerToken: state.job.leaseOwnerToken!,
      }, 'version-1', {
        runtime: { collection: 'test-collection', client: { retrieve: async () => [], upsert } } as never,
        provider: { model: 'test-model', embed } as never,
      })).rejects.toThrow('second batch failed');
    } finally {
      if (originalBatchSize === undefined) delete process.env.EMBEDDING_BATCH_SIZE;
      else process.env.EMBEDDING_BATCH_SIZE = originalBatchSize;
    }
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(state.points.size).toBe(2);
    await handleKnowledgeIndexFailure(state.prisma as never, capturedJob, new Error('second batch failed'), state);
    expect(state.deletePoints).toHaveBeenCalledWith('test-collection', {
      wait: true, filter: { must: [{ key: 'documentVersionId', match: { value: 'version-1' } }] },
    });
    expect([...state.points]).toEqual([['old-point', 'old-version']]);
    expect(state.counters).toEqual({ GLOBAL: 0, PRIVATE_GLOBAL: 0, 'USER:user-1': 0 });
    expect(state.job).toMatchObject({ status: 'FAILED', stage: 'CAPACITY_RELEASED', leaseOwnerToken: null });
    expect(state.version.indexStatus).toBe('FAILED');
    await handleKnowledgeIndexFailure(state.prisma as never, capturedJob, new Error('duplicate failure callback'), state);
    expect(state.deletePoints).toHaveBeenCalledTimes(1);
    expect(state.transaction.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it('retains reservations after failed deletion and resumes cleanup instead of indexing', async () => {
    const state = fixture();
    state.points.set('partial-point', 'version-1');
    state.deletePoints.mockRejectedValueOnce(new Error('Qdrant unavailable'));
    await handleKnowledgeIndexFailure(state.prisma as never, { ...state.job }, new Error('index failed'), state);
    expect(state.job).toMatchObject({ status: 'PENDING', stage: 'CAPACITY_CLEANUP_PENDING', leaseOwnerToken: null });
    expect(state.job.leasedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(state.counters.GLOBAL).toBe(2);
    expect(state.transaction.$executeRaw).not.toHaveBeenCalled();
    state.job.status = IndexStatus.PROCESSING;
    state.job.leaseOwnerToken = 'recovered-owner';
    state.job.attempts += 1;
    await processKnowledgeIndexOperation(state.prisma as never, { ...state.job }, state);
    expect(state.counters.GLOBAL).toBe(0);
    expect(state.version.indexStatus).toBe('FAILED');
    expect(state.prisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
    expect(state.points.has('partial-point')).toBe(false);
  });

  it('does not release capacity for an unconfirmed Qdrant deletion acknowledgement', async () => {
    const state = fixture();
    state.deletePoints.mockResolvedValueOnce({ status: 'acknowledged' });
    await compensateFailedKnowledgeIndex(state.prisma as never, { ...state.job }, 'failed', state);
    expect(state.counters.GLOBAL).toBe(2);
    expect(state.job.stage).toBe('CAPACITY_CLEANUP_PENDING');
    expect(state.job.error).toContain('VECTOR_DELETION_NOT_CONFIRMED');
  });

  it('recovers persisted cleanup after settlement and retry scheduling are both interrupted', async () => {
    const state = fixture();
    state.points.set('partial-point', 'version-1');
    state.transaction.$executeRaw.mockRejectedValueOnce(new Error('database interrupted'));
    const update = state.prisma.indexJob.updateMany.getMockImplementation()!;
    state.prisma.indexJob.updateMany.mockImplementation(async (args) => {
      if (args.data.status === IndexStatus.PENDING) throw new Error('retry scheduling interrupted');
      return update(args);
    });
    await expect(compensateFailedKnowledgeIndex(state.prisma as never, { ...state.job }, 'failed', state)).rejects.toThrow('retry scheduling interrupted');
    expect(state.counters.GLOBAL).toBe(2);
    expect(state.points.has('partial-point')).toBe(false);
    expect(state.job).toMatchObject({ stage: 'CAPACITY_CLEANUP_PENDING', status: 'PROCESSING' });
    state.prisma.indexJob.updateMany.mockImplementation(update);
    state.job.status = IndexStatus.PROCESSING;
    state.job.leaseOwnerToken = 'recovered-owner';
    await processKnowledgeIndexOperation(state.prisma as never, { ...state.job }, state);
    expect(state.counters.GLOBAL).toBe(0);
    expect(state.deletePoints).toHaveBeenCalledTimes(2);
  });

  it('does not release or requeue another owner after losing its lease during deletion', async () => {
    const state = fixture();
    const deleteVersionVectors = async () => { state.job.leaseOwnerToken = 'new-owner'; };
    await compensateFailedKnowledgeIndex(state.prisma as never, { ...state.job }, 'failed', { deleteVersionVectors });
    expect(state.counters.GLOBAL).toBe(2);
    expect(state.job).toMatchObject({ status: 'PROCESSING', leaseOwnerToken: 'new-owner', stage: 'CAPACITY_CLEANUP_PENDING' });
  });

  it('blocks destructive compensation against an active version', async () => {
    const state = fixture();
    state.version.document.activeVersionId = 'version-1';
    await expect(compensateFailedKnowledgeIndex(state.prisma as never, { ...state.job }, 'failed', state)).rejects.toThrow('ACTIVE_VERSION_COMPENSATION_BLOCKED');
    expect(state.deletePoints).not.toHaveBeenCalled();
    expect(state.counters.GLOBAL).toBe(2);
    expect(state.job.stage).toBe('CAPACITY_RESERVED');
  });

  it('delays cascading deletion while reservations exist without stealing an active owner', async () => {
    const state = fixture();
    await expect(knowledgeImportInternals.assertNoReservedVersionIndexes(state.prisma as never, { id: 'version-1' })).rejects.toBeInstanceOf(KnowledgeIndexDependencyPendingError);
    expect(state.job).toMatchObject({ status: 'PROCESSING', stage: 'CAPACITY_RESERVED', leaseOwnerToken: 'owner-1' });
    state.job.leasedUntil = new Date(Date.now() - 1);
    await expect(knowledgeImportInternals.assertNoReservedVersionIndexes(state.prisma as never, { id: 'version-1' })).rejects.toBeInstanceOf(KnowledgeIndexDependencyPendingError);
    expect(state.job).toMatchObject({ status: 'PENDING', stage: 'CAPACITY_CLEANUP_PENDING', leaseOwnerToken: null });
    expect(state.counters.GLOBAL).toBe(2);
  });

  it('does not mark a READY version failed while its deletion waits for compensation', async () => {
    const state = fixture();
    const deletionJob = { ...state.job, operation: 'DELETE_VERSION_VECTORS', attempts: 20 } as IndexJob;
    state.version.indexStatus = IndexStatus.READY;
    await handleKnowledgeIndexFailure(state.prisma as never, deletionJob, new KnowledgeIndexDependencyPendingError('waiting'));
    expect(state.version.indexStatus).toBe(IndexStatus.READY);
    expect(state.transaction.knowledgeDocumentVersion.updateMany).not.toHaveBeenCalled();
    expect(state.job.status).toBe(IndexStatus.PENDING);
  });
});
