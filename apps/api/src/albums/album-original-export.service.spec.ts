import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { AlbumOriginalExportService } from './album-original-export.service';
import { ExportAdmissionService } from '../media/export-admission.service';

const yauzl = createRequire(require.resolve('@bmc3/knowledge-core'))('yauzl');

class MemoryResponse extends Writable {
  readonly chunks: Buffer[] = [];
  readonly headers = new Map<string, string>();
  headersSent = false;
  status() { return this; }
  setHeader(name: string, value: string) { this.headers.set(name, value); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

async function entries(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error: Error | null, zip: any) => {
      if (error) return reject(error);
      const result = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(result));
      zip.on('entry', (entry: { fileName: string }) => {
        zip.openReadStream(entry, (readError: Error | null, stream: NodeJS.ReadableStream) => {
          if (readError) { zip.close(); reject(readError); return; }
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            result.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function fixture() {
  const data = Buffer.from('exact original bytes');
  const original = { photoId: 'photo-2', objectKey: 'private/original.png', mimeType: 'image/png', size: data.length, width: 2, height: 2, sha256: createHash('sha256').update(data).digest('hex') };
  const photos = [{ id: 'photo-1', original: null }, { id: 'photo-2', original }];
  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'editor' }) },
    album: { findFirst: jest.fn().mockResolvedValue({ id: 'album' }) },
    photo: { findMany: jest.fn().mockResolvedValueOnce(photos).mockResolvedValue([]) },
    photoOriginal: { findUnique: jest.fn().mockResolvedValue({ data }) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (operation: (transaction: typeof prisma) => Promise<unknown>) => operation(prisma));
  const storage = { readBounded: jest.fn().mockResolvedValue(data) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const admission = new ExportAdmissionService();
  const service = new AlbumOriginalExportService(prisma as never, storage as never, audit as never, admission);
  const response = new MemoryResponse();
  const user = { id: 'editor', role: 'EDITOR' } as never;
  return { data, original, prisma, storage, audit, admission, service, response, user };
}

describe('album original ZIP export', () => {
  it('exports exact originals and an explicit legacy manifest without private keys', async () => {
    const f = fixture();
    await f.service.streamArchive(f.user, 'album', f.response as never);
    const files = await entries(Buffer.concat(f.response.chunks));
    expect([...files.keys()]).toEqual(['originals/000002-photo-2.png', 'manifest.jsonl']);
    expect(files.get('originals/000002-photo-2.png')).toEqual(f.data);
    const manifest = files.get('manifest.jsonl')!.toString();
    expect(manifest.split('\n').filter(Boolean).map((line) => JSON.parse(line))).toEqual([
      { photoId: 'photo-1', index: 1, status: 'ORIGINAL_NOT_RETAINED' },
      { photoId: 'photo-2', index: 2, status: 'ORIGINAL_AVAILABLE', fileName: 'originals/000002-photo-2.png', mimeType: 'image/png', size: f.data.length, sha256: f.original.sha256 },
    ]);
    expect(manifest).not.toContain('private/');
    expect(f.storage.readBounded).toHaveBeenCalledWith('private/original.png', 10 * 1024 * 1024);
    expect(f.response.headers.get('cache-control')).toBe('private, no-store');
    expect(f.audit.record).toHaveBeenCalledWith('editor', 'album.original-export.completed', 'Album', 'album', expect.any(Object));
  });

  it('supports retained database originals without reading object storage', async () => {
    const f = fixture();
    Object.assign(f.original, { objectKey: null });
    await f.service.streamArchive(f.user, 'album', f.response as never);
    expect((await entries(Buffer.concat(f.response.chunks))).get('originals/000002-photo-2.png')).toEqual(f.data);
    expect(f.storage.readBounded).not.toHaveBeenCalled();
  });

  it('rejects members before snapshot or storage access', async () => {
    const f = fixture();
    await expect(f.service.streamArchive({ id: 'member', role: 'MEMBER' } as never, 'album', f.response as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.storage.readBounded).not.toHaveBeenCalled();
  });

  it('rechecks current permission before fetching an original', async () => {
    const f = fixture();
    f.prisma.user.findFirst.mockResolvedValueOnce({ id: 'editor' }).mockResolvedValue(null);
    await expect(f.service.streamArchive(f.user, 'album', f.response as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.storage.readBounded).not.toHaveBeenCalled();
    const release = f.admission.acquire();
    release();
  });

  it('fails closed when original bytes no longer match the stored digest', async () => {
    const f = fixture();
    f.storage.readBounded.mockResolvedValue(Buffer.alloc(f.data.length));
    await expect(f.service.streamArchive(f.user, 'album', f.response as never)).rejects.toThrow('完整性');
    expect(f.audit.record.mock.calls.some((call) => call[1] === 'album.original-export.completed')).toBe(false);
    expect(f.response.chunks).toHaveLength(0);
  });

  it('holds admission until an in-flight bounded read settles after disconnect', async () => {
    const f = fixture();
    let resolveRead!: (data: Buffer) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    f.storage.readBounded.mockImplementation(() => { started(); return new Promise<Buffer>((resolve) => { resolveRead = resolve; }); });
    const exporting = f.service.streamArchive(f.user, 'album', f.response as never);
    await reading;
    f.response.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(() => f.admission.acquire()).toThrow();
    resolveRead(f.data);
    await exporting;
    const release = f.admission.acquire();
    release();
    expect(f.response.chunks).toHaveLength(0);
  });

  it('does not read the whole album ahead of a stalled client', async () => {
    const f = fixture();
    const data = Buffer.alloc(256 * 1024, 97);
    const original = { ...f.original, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    const photos = Array.from({ length: 101 }, (_, index) => ({ id: `photo-${String(index).padStart(3, '0')}`, original: { ...original, photoId: `photo-${index}` } }));
    f.prisma.photo.findMany.mockReset().mockResolvedValueOnce(photos.slice(0, 100)).mockResolvedValueOnce(photos.slice(100)).mockResolvedValue([]);
    f.storage.readBounded.mockResolvedValue(data);
    f.response.cork();
    const exporting = f.service.streamArchive(f.user, 'album', f.response as never);
    try {
      for (let attempt = 0; attempt < 100 && !f.storage.readBounded.mock.calls.length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(f.storage.readBounded.mock.calls.length).toBeGreaterThan(0);
      expect(f.storage.readBounded.mock.calls.length).toBeLessThan(10);
      expect(() => f.admission.acquire()).toThrow();
    } finally {
      f.response.uncork();
      await exporting;
    }
    const files = await entries(Buffer.concat(f.response.chunks));
    expect(files.size).toBe(102);
    expect(f.prisma.photo.findMany.mock.calls[1][0].where.id).toEqual({ gt: 'photo-099' });
    expect(f.storage.readBounded).toHaveBeenCalledTimes(101);
  });
});
