import { ConflictException, Logger } from '@nestjs/common';
import { MediaObjectRecoveryService } from './media-object-recovery.service';

const displayKey = 'media/2026/09/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.webp';
const originalKey = 'album-originals/2026/09/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png';
type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return expected.some((entry: Row) => matches(row, entry));
    const value = row[key];
    if (expected === null) return value == null;
    if (typeof expected !== 'object' || expected instanceof Date) return value === expected;
    if ('in' in expected) return expected.in.includes(value);
    if ('notIn' in expected) return !expected.notIn.includes(value);
    if ('gt' in expected) return value != null && value > expected.gt;
    if ('lte' in expected) return value != null && value <= expected.lte;
    return value != null && matches(value, expected);
  });
}

function fixture() {
  const rows: Row[] = [];
  const operations = {
    create: jest.fn(async ({ data }: Row) => {
      const row = { id: `operation-${rows.length}`, createdAt: new Date(), attempts: 0, ...structuredClone(data) };
      rows.push(row);
      return structuredClone(row);
    }),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      const found = rows.filter((row) => matches(row, where));
      for (const row of found) for (const [key, value] of Object.entries(data)) {
        row[key] = value && typeof value === 'object' && 'increment' in value
          ? (row[key] ?? 0) + Number(value.increment) : structuredClone(value);
      }
      return { count: found.length };
    }),
    findUnique: jest.fn(async ({ where }: Row) => {
      const filter = where.actorId_albumId_idempotencyKey ?? where;
      return structuredClone(rows.find((row) => matches(row, filter)) ?? null);
    }),
    findUniqueOrThrow: jest.fn(async ({ where }: Row) => {
      const row = rows.find((entry) => matches(entry, where));
      if (!row) throw new Error('Missing fixture row');
      return structuredClone(row);
    }),
    findMany: jest.fn(async ({ where }: Row) => structuredClone(rows.filter((row) => matches(row, where)))),
  };
  const prisma = {
    mediaObjectOperation: operations,
    photo: { findUnique: jest.fn().mockResolvedValue(null) },
    photoOriginal: { findUnique: jest.fn().mockResolvedValue(null) },
    quizImportAsset: { findFirst: jest.fn().mockResolvedValue(null) },
    knowledgeImportAsset: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const storage = { delete: jest.fn().mockResolvedValue(undefined) };
  const service = new MediaObjectRecoveryService(prisma as never, storage as never);
  const begin = () => service.beginUpload({ actorId: 'actor', albumId: 'album', idempotencyKey: 'retry-key', requestHash: 'hash', photoId: 'photo', keys: [originalKey, displayKey] });
  return { rows, prisma, storage, service, begin };
}

describe('durable album object recovery', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(); });
  afterEach(() => { warn.mockRestore(); jest.useRealTimers(); });

  it('persists per-object progress and resumes after the second delete fails', async () => {
    const f = fixture();
    const lease = await f.begin();
    f.storage.delete.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private COS URL'));
    await f.service.compensate(lease);
    expect(f.rows[0]).toMatchObject({ status: 'CLEANUP_FAILED', manifest: [{ key: originalKey, status: 'DELETED' }, { key: displayKey, status: 'PENDING' }] });
    expect(await f.service.protectedKeys()).toEqual([{ operationId: lease.id, status: 'CLEANUP_FAILED', key: displayKey }]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private COS URL');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(displayKey);
    expect(await f.service.recover(lease.id, true)).toBe(true);
    expect(f.storage.delete.mock.calls.map(([key]) => key)).toEqual([originalKey, displayKey, displayKey]);
    expect(f.rows[0]!.status).toBe('CLEANED');
  });

  it('preserves committed originals and import references when compensating', async () => {
    const f = fixture();
    const lease = await f.begin();
    f.prisma.photoOriginal.findUnique.mockImplementation(async ({ where }: Row) => where.objectKey === originalKey ? { photoId: 'photo' } : null);
    f.prisma.knowledgeImportAsset.findFirst.mockImplementation(async ({ where }: Row) => where.objectKey === displayKey ? { id: 'asset' } : null);
    await f.service.compensate(lease);
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ status: 'CLEANED', manifest: [{ status: 'REFERENCED' }, { status: 'REFERENCED' }] });
  });

  it('retains a deletion manifest when a key is referenced, and retries after the reference disappears', async () => {
    const f = fixture();
    const id = await f.service.planDeletion(f.prisma as never, 'photo', [displayKey, originalKey, displayKey]);
    f.prisma.photo.findUnique.mockResolvedValue({ id: 'relinked-photo' });
    expect(await f.service.recover(id, true)).toBe(false);
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.rows[0]!.manifest).toHaveLength(2);
    f.prisma.photo.findUnique.mockResolvedValue(null);
    expect(await f.service.recover(id, true)).toBe(true);
    expect(f.storage.delete).toHaveBeenCalledTimes(2);
  });

  it('does not reclaim an active upload, and rejects stale upload renewal or commit after recovery', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-06T00:00:00Z') });
    const f = fixture();
    const lease = await f.begin();
    expect(await f.service.recover(lease.id, true)).toBe(false);
    await expect(f.service.existingUpload('actor', 'album', 'retry-key', 'hash')).rejects.toBeInstanceOf(ConflictException);
    jest.setSystemTime(new Date('2026-09-06T00:04:01Z'));
    expect(await f.service.recover(lease.id)).toBe(true);
    await expect(f.service.renew(lease)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.commit(f.prisma as never, lease)).rejects.toBeInstanceOf(ConflictException);
  });

  it('prevents competing cleaners and resumes an expired cleaning lease', async () => {
    const f = fixture();
    const id = await f.service.planDeletion(f.prisma as never, 'photo', [originalKey]);
    let finish!: () => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    f.storage.delete.mockImplementationOnce(() => { start(); return new Promise<void>((resolve) => { finish = resolve; }); });
    const first = f.service.recover(id);
    await started;
    expect(await f.service.recover(id, true)).toBe(false);
    finish();
    expect(await first).toBe(true);
    f.rows[0]!.status = 'CLEANING';
    f.rows[0]!.leaseOwnerToken = 'dead-process';
    f.rows[0]!.leasedUntil = new Date(0);
    expect(await f.service.recover(id)).toBe(true);
    expect(f.storage.delete).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite the successor lease when ownership changes during deletion', async () => {
    const f = fixture();
    const id = await f.service.planDeletion(f.prisma as never, 'photo', [originalKey]);
    f.storage.delete.mockImplementationOnce(async () => { f.rows[0]!.leaseOwnerToken = 'successor'; });
    expect(await f.service.recover(id, true)).toBe(false);
    expect(f.rows[0]).toMatchObject({ status: 'CLEANING', leaseOwnerToken: 'successor', manifest: [{ status: 'PENDING' }] });
  });

  it('rejects untrusted key scopes without any storage deletion', async () => {
    const f = fixture();
    await expect(f.service.planDeletion(f.prisma as never, 'photo', ['uploads/private.pdf'])).rejects.toThrow('Invalid media deletion manifest');
    const id = await f.service.planDeletion(f.prisma as never, 'photo', [originalKey]);
    f.rows[0]!.manifest = [{ key: 'uploads/private.pdf', status: 'PENDING' }];
    expect(await f.service.recover(id, true)).toBe(false);
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.rows[0]!.status).toBe('CLEANUP_FAILED');
  });

  it('only reuses a cleaned operation for the same content and fences out the previous attempt', async () => {
    const f = fixture();
    const old = await f.begin();
    await f.service.compensate(old);
    await expect(f.service.existingUpload('actor', 'album', 'retry-key', 'different-hash')).rejects.toBeInstanceOf(ConflictException);
    const next = await f.service.beginUpload({ actorId: 'actor', albumId: 'album', idempotencyKey: 'retry-key', requestHash: 'hash', photoId: 'new-photo', keys: [displayKey] }, old.id);
    await f.service.compensate(old);
    expect(f.rows[0]).toMatchObject({ status: 'UPLOADING', leaseOwnerToken: next.token, photoId: 'new-photo' });
    await f.service.commit(f.prisma as never, next);
    expect(await f.service.recover(old.id, true)).toBe(false);
  });
});
