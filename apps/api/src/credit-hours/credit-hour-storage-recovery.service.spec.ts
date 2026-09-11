import { ConflictException, Logger } from '@nestjs/common';
import { CreditHourStorageRecoveryService } from './credit-hour-storage-recovery.service';

const originalKey = 'credit-hours/original/2026/09/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png';
const displayKey = 'credit-hours/display/2026/09/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.webp';

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return expected.some((condition: Row) => matches(row, condition));
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every((condition: Row) => matches(row, condition));
    const value = row[key];
    if (expected === null) return value == null;
    if (typeof expected !== 'object' || expected instanceof Date) return value === expected;
    if ('in' in expected) return expected.in.includes(value);
    if ('not' in expected) return expected.not === null ? value != null : value !== expected.not;
    if ('gt' in expected) return value != null && value > expected.gt;
    if ('lte' in expected) return value != null && value <= expected.lte;
    return value != null && matches(value, expected);
  });
}

function fixture() {
  const uploads: Row[] = [];
  const cleanups: Row[] = [];
  const evidence: Row[] = [];
  function model(rows: Row[], defaults: Row = {}) {
    return {
      create: jest.fn(async ({ data }: Row) => {
        const row = { id: `fixture-${rows.length}`, createdAt: new Date(), ...defaults, ...data };
        rows.push(row);
        return structuredClone(row);
      }),
      updateMany: jest.fn(async ({ where, data }: Row) => {
        const found = rows.filter((row) => matches(row, where));
        for (const row of found) {
          for (const [key, value] of Object.entries(data)) {
            row[key] = value && typeof value === 'object' && 'increment' in value
              ? (row[key] ?? 0) + (value as { increment: number }).increment
              : structuredClone(value);
          }
        }
        return { count: found.length };
      }),
      findFirst: jest.fn(async ({ where }: Row) => structuredClone(rows.find((row) => matches(row, where)) ?? null)),
      findUnique: jest.fn(async ({ where }: Row) => structuredClone(rows.find((row) => matches(row, where)) ?? null)),
      findUniqueOrThrow: jest.fn(async ({ where }: Row) => {
        const row = rows.find((entry) => matches(entry, where));
        if (!row) throw new Error('fixture missing row');
        return structuredClone(row);
      }),
      findMany: jest.fn(async ({ where }: Row) => structuredClone(rows.filter((row) => matches(row, where)))),
    };
  }
  const prisma = {
    creditHourUploadOperation: model(uploads, { status: 'UPLOADING', attempts: 0 }),
    creditHourCleanupOperation: model(cleanups),
    creditHourEvidence: model(evidence),
    $transaction: async (run: (tx: any) => unknown) => run(prisma),
  };
  const storage = { usesCos: () => true, delete: jest.fn().mockResolvedValue(undefined) };
  const service = new CreditHourStorageRecoveryService(prisma as never, storage as never);
  const seedCleanup = (status = 'PENDING', leasedUntil: Date | null = null) => {
    cleanups.push({
      id: 'cleanup-fixture', submissionId: 'submission-fixture', status,
      leasedUntil, leaseOwnerToken: 'previous-owner', attempts: 0,
      manifest: [
        { key: originalKey, field: 'original', evidenceId: 'evidence-fixture' },
        { key: displayKey, field: 'display', evidenceId: 'evidence-fixture' },
      ],
      totalObjects: 2, deletedObjects: 0,
    });
    evidence.push({
      id: 'evidence-fixture', originalObjectKey: originalKey, displayObjectKey: displayKey,
      revision: { submissionId: 'submission-fixture', submission: { deletedAt: new Date() } },
    });
  };
  return { service, prisma, storage, uploads, cleanups, evidence, seedCleanup };
}

describe('credit-hour durable object recovery', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(); });
  afterEach(() => warn.mockRestore());

  it('retains exact keys after compensation fails and resumes their deletion', async () => {
    const f = fixture();
    const lease = await f.service.beginUpload('user', 'key', 'hash', [originalKey, displayKey]);
    f.storage.delete.mockRejectedValueOnce(new Error('private COS URL'));
    await f.service.compensateUpload(lease);
    expect(f.uploads[0]).toMatchObject({ status: 'CLEANUP_FAILED', manifest: [{ key: originalKey, status: 'PENDING' }, { key: displayKey, status: 'PENDING' }] });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private COS URL');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(originalKey);
    await f.service.recoverUpload(lease.id, true);
    expect(f.uploads[0]).toMatchObject({ status: 'CLEANED', manifest: [{ key: originalKey, status: 'DELETED' }, { key: displayKey, status: 'DELETED' }] });
  });

  it('protects keys already referenced by committed evidence', async () => {
    const f = fixture();
    const lease = await f.service.beginUpload('user', 'key', 'hash', [originalKey, displayKey]);
    f.evidence.push({ id: 'committed-evidence', originalObjectKey: originalKey, displayObjectKey: displayKey });
    await f.service.compensateUpload(lease);
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.uploads[0]?.manifest.map((entry: Row) => entry.status)).toEqual(['REFERENCED', 'REFERENCED']);
  });

  it('reclaims an interrupted uploader only after expiry and settling, and fences its commit', async () => {
    const f = fixture();
    const lease = await f.service.beginUpload('user', 'key', 'hash', [originalKey]);
    expect(await f.service.recoverUpload(lease.id)).toBe(false);
    f.uploads[0]!.leasedUntil = new Date(Date.now() - 60_000);
    expect(await f.service.recoverUpload(lease.id)).toBe(false);
    f.uploads[0]!.leasedUntil = new Date(Date.now() - 300_000);
    expect(await f.service.recoverUpload(lease.id)).toBe(true);
    await expect(f.service.commitUpload(f.prisma as never, lease)).rejects.toBeInstanceOf(ConflictException);
    expect(f.uploads[0]?.status).toBe('CLEANED');
  });

  it('does not overwrite the new owner when an old cleanup request completes late', async () => {
    const f = fixture();
    const lease = await f.service.beginUpload('user', 'key', 'hash', [originalKey]);
    f.uploads[0]!.status = 'CLEANUP_PENDING';
    f.storage.delete.mockImplementationOnce(async () => { f.uploads[0]!.leaseOwnerToken = 'replacement-owner'; });
    expect(await f.service.recoverUpload(lease.id, true)).toBe(false);
    expect(f.uploads[0]).toMatchObject({ status: 'CLEANING', leaseOwnerToken: 'replacement-owner', manifest: [{ key: originalKey, status: 'PENDING' }] });
  });

  it.each(['PENDING', 'RUNNING'])('recovers a %s deletion after process interruption', async (status) => {
    const f = fixture();
    f.seedCleanup(status, status === 'RUNNING' ? new Date(Date.now() - 1) : null);
    await expect(f.service.executeCleanup('cleanup-fixture')).resolves.toMatchObject({ status: 'COMPLETE', deletedObjects: 2 });
    expect(f.evidence[0]).toMatchObject({ originalObjectKey: null, displayObjectKey: null });
    expect(f.cleanups[0]).toMatchObject({ leaseOwnerToken: null, leasedUntil: null });
  });

  it('refuses to steal a live cleanup lease even on manual retry', async () => {
    const f = fixture();
    f.seedCleanup('RUNNING', new Date(Date.now() + 60_000));
    await expect(f.service.executeCleanup('cleanup-fixture', true)).rejects.toBeInstanceOf(ConflictException);
    expect(f.storage.delete).not.toHaveBeenCalled();
  });

  it('persists partial completion and only retries remaining objects', async () => {
    const f = fixture();
    f.seedCleanup();
    f.storage.delete.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('fixture failure'));
    await expect(f.service.executeCleanup('cleanup-fixture')).resolves.toMatchObject({ status: 'PARTIAL', deletedObjects: 1 });
    await expect(f.service.executeCleanup('cleanup-fixture', true)).resolves.toMatchObject({ status: 'COMPLETE', deletedObjects: 2 });
    expect(f.storage.delete.mock.calls.map(([key]) => key)).toEqual([originalKey, displayKey, displayKey]);
  });

  it('fences stale deletion completion before clearing evidence or final status', async () => {
    const f = fixture();
    f.seedCleanup();
    f.storage.delete.mockImplementationOnce(async () => { f.cleanups[0]!.leaseOwnerToken = 'replacement-owner'; });
    await expect(f.service.executeCleanup('cleanup-fixture')).rejects.toBeInstanceOf(ConflictException);
    expect(f.evidence[0]!.originalObjectKey).toBe(originalKey);
    expect(f.cleanups[0]).toMatchObject({ status: 'RUNNING', leaseOwnerToken: 'replacement-owner' });
  });

  it('refuses a manifest targeting evidence of a live submission', async () => {
    const f = fixture();
    f.seedCleanup();
    f.evidence[0]!.revision.submission.deletedAt = null;
    await expect(f.service.executeCleanup('cleanup-fixture')).resolves.toMatchObject({ status: 'FAILED', deletedObjects: 0 });
    expect(f.storage.delete).not.toHaveBeenCalled();
  });
});
