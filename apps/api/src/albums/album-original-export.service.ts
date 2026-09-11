import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountStatus, Prisma, Role, type User } from '@prisma/client';
import archiver, { type Archiver } from 'archiver';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ExportAdmissionService } from '../media/export-admission.service';
import { MediaStorageService } from '../media/media-storage.service';
import { waitForExportDrain } from '../media/export-backpressure';

const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;
const PAGE_SIZE = 100;
const originalSelect = { photoId: true, objectKey: true, mimeType: true, size: true, width: true, height: true, sha256: true } as const;
type SnapshotPhoto = { id: string; original: Prisma.PhotoOriginalGetPayload<{ select: typeof originalSelect }> | null };

@Injectable()
export class AlbumOriginalExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorageService,
    private readonly audit: AuditService,
    private readonly admission: ExportAdmissionService,
  ) {}

  async summary(user: User, albumId: string) {
    await this.assertAccess(user, albumId);
    const [photoCount, originals] = await this.prisma.$transaction([
      this.prisma.photo.count({ where: { albumId } }),
      this.prisma.photoOriginal.aggregate({ where: { photo: { albumId } }, _count: { _all: true }, _sum: { size: true } }),
    ]);
    return { albumId, photoCount, originalCount: originals._count._all, missingOriginalCount: photoCount - originals._count._all, originalBytes: originals._sum.size ?? 0, canExport: originals._count._all > 0 };
  }

  async streamArchive(user: User, albumId: string, response: Response) {
    await this.assertAccess(user, albumId);
    const release = this.admission.acquire();
    let directory: string | null = null;
    let archive: Archiver | null = null;
    let disconnected = false;
    let rejectFailure!: (error: Error) => void;
    const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
    void failure.catch(() => undefined);
    const onClose = () => {
      if (!response.writableFinished) {
        disconnected = true;
        archive?.abort();
        rejectFailure(new Error('导出连接已关闭'));
      }
    };
    response.once('close', onClose);
    let counts = { photoCount: 0, originalCount: 0, originalBytes: 0 };
    try {
      directory = await fs.mkdtemp(join(tmpdir(), 'bmc3-album-originals-'));
      await fs.chmod(directory, 0o700);
      const snapshotPath = join(directory, 'snapshot.jsonl');
      const manifestPath = join(directory, 'manifest.jsonl');
      counts = await this.snapshot(albumId, snapshotPath, manifestPath, () => disconnected);
      if (!counts.originalCount) throw new ConflictException('相册照片未保留原图，无法导出');
      if (disconnected || response.destroyed) throw new Error('导出连接已关闭');
      await this.audit.record(user.id, 'album.original-export.started', 'Album', albumId, counts);
      response.status(200);
      response.setHeader('content-type', 'application/zip');
      response.setHeader('content-disposition', `attachment; filename="album-originals-${albumId.replace(/[^A-Za-z0-9_-]/g, '_')}.zip"`);
      response.setHeader('cache-control', 'private, no-store');
      response.setHeader('x-content-type-options', 'nosniff');
      archive = archiver('zip', { store: true });
      archive.on('error', rejectFailure);
      archive.on('warning', rejectFailure);
      archive.pipe(response);
      const stream = createReadStream(snapshotPath);
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        let index = 0;
        for await (const line of lines) {
          index += 1;
          if (disconnected || response.destroyed) throw new Error('导出连接已关闭');
          const photo = JSON.parse(line) as SnapshotPhoto;
          if (!photo.original) continue;
          await this.assertAccess(user, albumId);
          // Keep the admission until the bounded storage request settles, even after disconnect.
          const original = await this.readOriginal(photo.original);
          if (disconnected || response.destroyed) throw new Error('导出连接已关闭');
          await appendEntry(archive, original, imageName(index, photo), failure);
          await waitForExportDrain(response, failure);
        }
      } finally {
        lines.close();
        stream.destroy();
      }
      const manifestStream = createReadStream(manifestPath);
      try {
        await appendEntry(archive, manifestStream, 'manifest.jsonl', failure);
      } finally { manifestStream.destroy(); }
      await Promise.race([archive.finalize(), failure]);
      await Promise.race([finished(response), failure]);
      await this.audit.record(user.id, 'album.original-export.completed', 'Album', albumId, counts);
    } catch (error) {
      archive?.abort();
      await this.audit.record(user.id, 'album.original-export.failed', 'Album', albumId, { ...counts, disconnected }).catch(() => undefined);
      if (response.headersSent || response.destroyed) {
        if (!response.destroyed) response.destroy();
      } else { throw error; }
    } finally {
      response.off('close', onClose);
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      release();
    }
  }

  private async snapshot(albumId: string, snapshotPath: string, manifestPath: string, disconnected: () => boolean) {
    const snapshotFile = await fs.open(snapshotPath, 'wx', 0o600);
    const manifestFile = await fs.open(manifestPath, 'wx', 0o600);
    const totals = { photoCount: 0, originalCount: 0, originalBytes: 0 };
    try {
      await this.prisma.$transaction(async (transaction) => {
        const album = await transaction.album.findFirst({ where: { id: albumId, deletedAt: null }, select: { id: true } });
        if (!album) throw new NotFoundException('相册不存在');
        let cursor: string | undefined;
        while (true) {
          if (disconnected()) throw new Error('导出连接已关闭');
          const photos = await transaction.photo.findMany({ where: { albumId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: PAGE_SIZE, select: { id: true, original: { select: originalSelect } } });
          if (!photos.length) break;
          const manifest = photos.map((photo) => {
            totals.photoCount += 1;
            if (!photo.original) return { photoId: photo.id, index: totals.photoCount, status: 'ORIGINAL_NOT_RETAINED' };
            validateOriginal(photo.original);
            totals.originalCount += 1;
            totals.originalBytes += photo.original.size;
            if (!Number.isSafeInteger(totals.originalBytes)) throw new Error('Album byte count is too large');
            return { photoId: photo.id, index: totals.photoCount, status: 'ORIGINAL_AVAILABLE', fileName: imageName(totals.photoCount, photo), mimeType: photo.original.mimeType, size: photo.original.size, sha256: photo.original.sha256 };
          });
          await snapshotFile.writeFile(photos.map((photo) => JSON.stringify(photo)).join('\n') + '\n');
          await manifestFile.writeFile(manifest.map((item) => JSON.stringify(item)).join('\n') + '\n');
          cursor = photos.at(-1)!.id;
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 });
    } finally {
      await snapshotFile.close();
      await manifestFile.close();
    }
    return totals;
  }

  private async assertAccess(user: User, albumId: string) {
    if (![Role.ADMIN, Role.EDITOR].includes(user.role as 'ADMIN' | 'EDITOR')) throw new ForbiddenException('只有编辑和管理员可以导出相册原图');
    const current = await this.prisma.user.findFirst({ where: { id: user.id, status: AccountStatus.ACTIVE, role: { in: [Role.ADMIN, Role.EDITOR] } }, select: { id: true } });
    if (!current) throw new ForbiddenException('当前账号无权导出原图');
    const album = await this.prisma.album.findFirst({ where: { id: albumId, deletedAt: null }, select: { id: true } });
    if (!album) throw new NotFoundException('相册不存在');
  }

  private async readOriginal(original: NonNullable<SnapshotPhoto['original']>) {
    validateOriginal(original);
    const data = original.objectKey
      ? await this.storage.readBounded(original.objectKey, MAX_ORIGINAL_BYTES)
      : Buffer.from((await this.prisma.photoOriginal.findUnique({ where: { photoId: original.photoId }, select: { data: true } }))?.data ?? []);
    if (data.length !== original.size || createHash('sha256').update(data).digest('hex') !== original.sha256) throw new Error('相册原图完整性校验失败');
    return data;
  }
}

function validateOriginal(original: NonNullable<SnapshotPhoto['original']>) {
  if (!Number.isInteger(original.size) || original.size < 1 || original.size > MAX_ORIGINAL_BYTES || !['image/jpeg', 'image/png', 'image/webp'].includes(original.mimeType) || !/^[a-f0-9]{64}$/.test(original.sha256)) throw new Error('相册原图元数据无效');
}

function imageName(index: number, photo: SnapshotPhoto) {
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[photo.original!.mimeType];
  return `originals/${String(index).padStart(6, '0')}-${photo.id.replace(/[^A-Za-z0-9_-]/g, '_')}.${extension}`;
}

async function appendEntry(archive: Archiver, source: Buffer | ReturnType<typeof createReadStream>, name: string, failure: Promise<never>) {
  let onEntry!: (entry: { name: string }) => void;
  const written = new Promise<void>((resolve) => { onEntry = (entry) => { if (entry.name === name) resolve(); }; archive.on('entry', onEntry); archive.append(source, { name, store: true }); });
  try { await Promise.race([written, failure]); } finally { archive.off('entry', onEntry); }
}
