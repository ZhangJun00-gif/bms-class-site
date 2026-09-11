import { ConflictException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { MediaStorageService } from './media-storage.service';

const LEASE_MS = 120_000;
const KEY_PATTERN = /^(media\/\d{4}\/\d{2}\/[a-f0-9-]+\.webp|album-originals\/\d{4}\/\d{2}\/[a-f0-9-]+\.(jpeg|png|webp))$/;
export interface MediaUploadLease { id: string; token: string; photoId: string }
interface ObjectEntry { key: string; status: 'PENDING' | 'DELETED' | 'REFERENCED' }

@Injectable()
export class MediaObjectRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MediaObjectRecoveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  constructor(private readonly prisma: PrismaService, private readonly storage: MediaStorageService) {}

  onApplicationBootstrap() {
    this.schedule();
    this.timer = setInterval(() => this.schedule(), 60_000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async existingUpload(actorId: string, albumId: string, idempotencyKey: string, requestHash: string) {
    const operation = await this.prisma.mediaObjectOperation.findUnique({ where: { actorId_albumId_idempotencyKey: { actorId, albumId, idempotencyKey } } });
    if (operation && operation.requestHash !== requestHash) throw new ConflictException('同一 Idempotency-Key 已用于不同照片内容');
    if (!operation || operation.status === 'COMMITTED' || operation.status === 'CLEANED') return operation;
    await this.recover(operation.id, true);
    const latest = await this.prisma.mediaObjectOperation.findUniqueOrThrow({ where: { id: operation.id } });
    if (latest.status !== 'COMMITTED' && latest.status !== 'CLEANED') throw new ConflictException({ code: 'ALBUM_UPLOAD_IN_PROGRESS', message: '照片上传或对象回收仍在进行，请稍后使用同一请求重试' });
    return latest;
  }

  async beginUpload(input: { actorId: string; albumId: string; idempotencyKey: string; requestHash: string; photoId: string; keys: string[] }, existingId?: string): Promise<MediaUploadLease> {
    if (input.keys.some((key) => !KEY_PATTERN.test(key))) throw new Error('Invalid media manifest');
    const token = randomUUID();
    const data = {
      kind: 'ALBUM_UPLOAD', status: 'UPLOADING', actorId: input.actorId, albumId: input.albumId,
      idempotencyKey: input.idempotencyKey, requestHash: input.requestHash, photoId: input.photoId,
      manifest: input.keys.map((key) => ({ key, status: 'PENDING' })),
      leaseOwnerToken: token, leasedUntil: new Date(Date.now() + LEASE_MS), nextAttemptAt: null, completedAt: null, errorMessage: null,
    };
    try {
      if (existingId) {
        const claimed = await this.prisma.mediaObjectOperation.updateMany({ where: { id: existingId, status: 'CLEANED', requestHash: input.requestHash }, data });
        assertOwned(claimed.count);
        return { id: existingId, token, photoId: input.photoId };
      }
      const row = await this.prisma.mediaObjectOperation.create({ data, select: { id: true } });
      return { id: row.id, token, photoId: input.photoId };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'ALBUM_UPLOAD_IN_PROGRESS', message: '同一照片请求正在处理，请稍后重试' });
      throw error;
    }
  }

  async renew(lease: MediaUploadLease) {
    const renewed = await this.prisma.mediaObjectOperation.updateMany({ where: uploadOwner(lease), data: { leasedUntil: new Date(Date.now() + LEASE_MS) } });
    assertOwned(renewed.count);
  }

  async commit(transaction: Prisma.TransactionClient, lease: MediaUploadLease) {
    const changed = await transaction.mediaObjectOperation.updateMany({ where: uploadOwner(lease), data: { status: 'COMMITTED', completedAt: new Date(), leaseOwnerToken: null, leasedUntil: null } });
    assertOwned(changed.count);
  }

  async compensate(lease: MediaUploadLease) {
    try {
      const changed = await this.prisma.mediaObjectOperation.updateMany({ where: { id: lease.id, status: 'UPLOADING', leaseOwnerToken: lease.token }, data: { status: 'CLEANUP_PENDING', leaseOwnerToken: null, leasedUntil: null, nextAttemptAt: new Date() } });
      if (changed.count === 1) await this.recover(lease.id, true);
    } catch { this.warn(lease.id); }
  }

  async planDeletion(transaction: Prisma.TransactionClient, photoId: string, keys: Array<string | null | undefined>) {
    const exactKeys = [...new Set(keys.filter((key): key is string => Boolean(key)))];
    if (exactKeys.some((key) => !KEY_PATTERN.test(key))) throw new Error('Invalid media deletion manifest');
    const operation = await transaction.mediaObjectOperation.create({
      data: { kind: 'PHOTO_DELETE', status: 'CLEANUP_PENDING', photoId, manifest: exactKeys.map((key) => ({ key, status: 'PENDING' })), nextAttemptAt: new Date() },
      select: { id: true },
    });
    return operation.id;
  }

  async recover(id: string, force = false) {
    const token = randomUUID();
    const claimed = await this.prisma.mediaObjectOperation.updateMany({ where: { id, ...recoverable(new Date(), force) }, data: { status: 'CLEANING', leaseOwnerToken: token, leasedUntil: new Date(Date.now() + LEASE_MS), attempts: { increment: 1 }, errorMessage: null } });
    if (claimed.count !== 1) return false;
    const owner = () => ({ id, status: 'CLEANING', leaseOwnerToken: token, leasedUntil: { gt: new Date() } });
    try {
      const operation = await this.prisma.mediaObjectOperation.findUniqueOrThrow({ where: { id } });
      const manifest = parseManifest(operation.manifest);
      for (const entry of manifest) {
        if (entry.status !== 'PENDING') continue;
        assertOwned((await this.prisma.mediaObjectOperation.updateMany({ where: owner(), data: { leasedUntil: new Date(Date.now() + LEASE_MS) } })).count);
        const [photo, original, quizAsset, knowledgeAsset] = await Promise.all([
          this.prisma.photo.findUnique({ where: { objectKey: entry.key }, select: { id: true } }),
          this.prisma.photoOriginal.findUnique({ where: { objectKey: entry.key }, select: { photoId: true } }),
          this.prisma.quizImportAsset.findFirst({ where: { objectKey: entry.key, importJob: { status: { in: ['IMPORT_PENDING', 'IMPORTING'] } } }, select: { id: true } }),
          this.prisma.knowledgeImportAsset.findFirst({ where: { objectKey: entry.key, importJob: { status: { in: ['INDEX_PENDING', 'PROCESSING', 'COMPENSATION_FAILED'] } } }, select: { id: true } }),
        ]);
        if (photo || original || quizAsset || knowledgeAsset) {
          if (operation.kind === 'PHOTO_DELETE') throw new Error('Media is still referenced');
          entry.status = 'REFERENCED';
        } else {
          await this.storage.delete(entry.key);
          entry.status = 'DELETED';
        }
        assertOwned((await this.prisma.mediaObjectOperation.updateMany({ where: owner(), data: { manifest: manifest as unknown as Prisma.InputJsonValue } })).count);
      }
      assertOwned((await this.prisma.mediaObjectOperation.updateMany({ where: owner(), data: { status: 'CLEANED', completedAt: new Date(), nextAttemptAt: null, leaseOwnerToken: null, leasedUntil: null } })).count);
      return true;
    } catch {
      await this.prisma.mediaObjectOperation.updateMany({ where: owner(), data: { status: 'CLEANUP_FAILED', errorMessage: '图片对象尚未完整回收', nextAttemptAt: new Date(Date.now() + 60_000), leaseOwnerToken: null, leasedUntil: null } }).catch(() => undefined);
      this.warn(id);
      return false;
    }
  }

  async protectedKeys() {
    const rows = await this.prisma.mediaObjectOperation.findMany({ where: { status: { notIn: ['COMMITTED', 'CLEANED'] } }, select: { id: true, status: true, manifest: true } });
    return rows.flatMap((row) => parseManifest(row.manifest).filter((entry) => entry.status === 'PENDING').map((entry) => ({ operationId: row.id, status: row.status, key: entry.key })));
  }

  async originalReport() {
    const [aggregate, originals, operations] = await Promise.all([
      this.prisma.photoOriginal.aggregate({ _count: { _all: true }, _sum: { size: true } }),
      this.prisma.photoOriginal.findMany({ where: { objectKey: { not: null } }, select: { photoId: true, objectKey: true } }),
      this.protectedKeys(),
    ]);
    const objects = this.storage.usesCos() ? await this.storage.listObjects('album-originals/') : null;
    const claimed = new Set(originals.map((entry) => entry.objectKey));
    const protectedKeys = new Set(operations.map((entry) => entry.key));
    const existing = new Set(objects?.map((entry) => entry.key));
    return {
      total: aggregate._count._all, totalBytes: aggregate._sum.size ?? 0,
      pendingObjects: operations,
      cosComparison: objects ? {
        objectCount: objects.length,
        untrackedObjects: objects.filter((entry) => !claimed.has(entry.key) && !protectedKeys.has(entry.key)),
        missingObjects: originals.filter((entry) => !existing.has(entry.objectKey!)),
      } : null,
    };
  }

  private schedule() {
    if (this.running || this.stopping) return;
    this.running = this.runRecovery().catch(() => this.warn()).finally(() => { this.running = null; });
  }

  private async runRecovery() {
    const operations = await this.prisma.mediaObjectOperation.findMany({ where: recoverable(new Date()), select: { id: true }, orderBy: { createdAt: 'asc' }, take: 10 });
    for (const operation of operations) {
      if (this.stopping) return;
      await this.recover(operation.id);
    }
  }

  private warn(operationId?: string) { this.logger.warn(JSON.stringify({ event: 'media.object-cleanup-pending', operationId })); }
}

function recoverable(now: Date, force = false): Prisma.MediaObjectOperationWhereInput {
  return { OR: [
    { status: { in: ['CLEANUP_PENDING', 'CLEANUP_FAILED'] }, ...(force ? {} : { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }) },
    { status: 'CLEANING', OR: [{ leasedUntil: null }, { leasedUntil: { lte: now } }] },
    { status: 'UPLOADING', leasedUntil: { lte: new Date(now.getTime() - LEASE_MS) } },
  ] };
}

function uploadOwner(lease: MediaUploadLease) { return { id: lease.id, status: 'UPLOADING', leaseOwnerToken: lease.token, leasedUntil: { gt: new Date() } }; }
function assertOwned(count: number) { if (count !== 1) throw new ConflictException('图片操作租约已变化，请重试'); }
function parseManifest(value: Prisma.JsonValue): ObjectEntry[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error('Invalid media manifest');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.key !== 'string' || !KEY_PATTERN.test(entry.key) || !['PENDING', 'DELETED', 'REFERENCED'].includes(String(entry.status))) throw new Error('Invalid media manifest entry');
    return { key: entry.key, status: entry.status as ObjectEntry['status'] };
  });
}
