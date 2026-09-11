import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { MediaStorageService } from '../media/media-storage.service';

const LEASE_MS = 120_000;
const RECOVERY_INTERVAL_MS = 60_000;
const UPLOAD_SETTLE_MS = 120_000;
const RETRY_MS = 60_000;
const OBJECT_KEY = /^credit-hours\/(original|display)\/\d{4}\/\d{2}\/[a-f0-9-]+\.(jpeg|png|webp)$/;

export interface UploadLease { id: string; token: string }
interface UploadObject { key: string; status: 'PENDING' | 'DELETED' | 'REFERENCED' }
interface CleanupObject { key: string; evidenceId: string; field: 'original' | 'display' }

@Injectable()
export class CreditHourStorageRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CreditHourStorageRecoveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorageService,
  ) {}

  onApplicationBootstrap() {
    this.scheduleRecovery();
    this.timer = setInterval(() => this.scheduleRecovery(), RECOVERY_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async beginUpload(userId: string, idempotencyKey: string, requestHash: string, keys: string[]): Promise<UploadLease> {
    if (!keys.length || keys.some((key) => !OBJECT_KEY.test(key))) throw new Error('Invalid upload manifest');
    const token = randomUUID();
    const operation = await this.prisma.creditHourUploadOperation.create({
      data: {
        userId,
        idempotencyKey,
        requestHash,
        manifest: keys.map((key) => ({ key, status: 'PENDING' })),
        leaseOwnerToken: token,
        leasedUntil: new Date(Date.now() + LEASE_MS),
      },
      select: { id: true },
    });
    return { id: operation.id, token };
  }

  async renewUpload(lease: UploadLease) {
    const renewed = await this.prisma.creditHourUploadOperation.updateMany({
      where: this.uploadOwner(lease),
      data: { leasedUntil: new Date(Date.now() + LEASE_MS) },
    });
    assertOwned(renewed.count);
  }

  async commitUpload(transaction: Prisma.TransactionClient, lease: UploadLease) {
    const committed = await transaction.creditHourUploadOperation.updateMany({
      where: this.uploadOwner(lease),
      data: {
        status: 'COMMITTED',
        leaseOwnerToken: null,
        leasedUntil: null,
        completedAt: new Date(),
      },
    });
    assertOwned(committed.count);
  }

  async compensateUpload(lease: UploadLease) {
    try {
      const scheduled = await this.prisma.creditHourUploadOperation.updateMany({
        where: { id: lease.id, status: 'UPLOADING', leaseOwnerToken: lease.token },
        data: {
          status: 'CLEANUP_PENDING',
          leaseOwnerToken: null,
          leasedUntil: null,
          nextAttemptAt: new Date(),
        },
      });
      if (scheduled.count === 1) await this.recoverUpload(lease.id, true);
    } catch {
      // The pre-upload manifest remains recoverable even when storage or the database is unavailable.
      this.logFailure('credit-hour.upload-cleanup-pending', lease.id);
    }
  }

  async recoverUpload(id: string, force = false) {
    const now = new Date();
    const token = randomUUID();
    const claimed = await this.prisma.creditHourUploadOperation.updateMany({
      where: { id, ...uploadRecoverable(now, force) },
      data: {
        status: 'CLEANING',
        leaseOwnerToken: token,
        leasedUntil: new Date(now.getTime() + LEASE_MS),
        attempts: { increment: 1 },
        errorMessage: null,
      },
    });
    if (claimed.count !== 1) return false;
    const owner = () => ({ id, status: 'CLEANING' as const, leaseOwnerToken: token, leasedUntil: { gt: new Date() } });
    try {
      const operation = await this.prisma.creditHourUploadOperation.findUniqueOrThrow({ where: { id } });
      const manifest = readUploadManifest(operation.manifest);
      for (const item of manifest) {
        if (item.status !== 'PENDING') continue;
        const renewed = await this.prisma.creditHourUploadOperation.updateMany({
          where: owner(), data: { leasedUntil: new Date(Date.now() + LEASE_MS) },
        });
        assertOwned(renewed.count);
        const reference = await this.prisma.creditHourEvidence.findFirst({
          where: { OR: [{ originalObjectKey: item.key }, { displayObjectKey: item.key }] },
          select: { id: true },
        });
        if (reference) {
          item.status = 'REFERENCED';
        } else {
          await this.storage.delete(item.key);
          item.status = 'DELETED';
        }
        const saved = await this.prisma.creditHourUploadOperation.updateMany({
          where: owner(),
          data: { manifest: manifest as unknown as Prisma.InputJsonValue },
        });
        assertOwned(saved.count);
      }
      const finished = await this.prisma.creditHourUploadOperation.updateMany({
        where: owner(),
        data: { status: 'CLEANED', completedAt: new Date(), leaseOwnerToken: null, leasedUntil: null, nextAttemptAt: null },
      });
      assertOwned(finished.count);
      return true;
    } catch {
      await this.prisma.creditHourUploadOperation.updateMany({
        where: owner(),
        data: {
          status: 'CLEANUP_FAILED', errorMessage: '凭证上传对象尚未完整回收',
          nextAttemptAt: new Date(Date.now() + RETRY_MS), leaseOwnerToken: null, leasedUntil: null,
        },
      }).catch(() => undefined);
      this.logFailure('credit-hour.upload-cleanup-pending', id);
      return false;
    }
  }

  async executeCleanup(id: string, force = false) {
    const now = new Date();
    const token = randomUUID();
    const claimed = await this.prisma.creditHourCleanupOperation.updateMany({
      where: { id, ...cleanupRecoverable(now, force) },
      data: {
        status: 'RUNNING', leaseOwnerToken: token, leasedUntil: new Date(now.getTime() + LEASE_MS),
        attempts: { increment: 1 }, errorMessage: null, completedAt: null,
      },
    });
    if (claimed.count !== 1) throw new ConflictException('清理操作正在执行或已完成');
    const owner = () => ({ id, status: 'RUNNING' as const, leaseOwnerToken: token, leasedUntil: { gt: new Date() } });
    let deleted = 0;
    let failures = 0;
    try {
      const operation = await this.prisma.creditHourCleanupOperation.findUniqueOrThrow({ where: { id } });
      const manifest = readCleanupManifest(operation.manifest);
      for (const item of manifest) {
        const renewed = await this.prisma.creditHourCleanupOperation.updateMany({
          where: owner(), data: { leasedUntil: new Date(Date.now() + LEASE_MS) },
        });
        assertOwned(renewed.count);
        try {
          const evidence = await this.prisma.creditHourEvidence.findUnique({
            where: { id: item.evidenceId },
            select: { originalObjectKey: true, displayObjectKey: true, revision: { select: { submissionId: true, submission: { select: { deletedAt: true } } } } },
          });
          if (!evidence || evidence.revision.submissionId !== operation.submissionId || !evidence.revision.submission.deletedAt) {
            throw new Error('Cleanup target is not deleted');
          }
          const field = item.field === 'original' ? 'originalObjectKey' : 'displayObjectKey';
          if (evidence[field] === null) {
            deleted += 1;
            continue;
          }
          if (evidence[field] !== item.key) throw new Error('Cleanup manifest mismatch');
          const otherReference = await this.prisma.creditHourEvidence.findFirst({
            where: { id: { not: item.evidenceId }, OR: [{ originalObjectKey: item.key }, { displayObjectKey: item.key }] },
            select: { id: true },
          });
          if (otherReference) throw new Error('Object is referenced elsewhere');
          await this.storage.delete(item.key);
          await this.prisma.$transaction(async (transaction) => {
            const owned = await transaction.creditHourCleanupOperation.updateMany({
              where: owner(), data: { leasedUntil: new Date(Date.now() + LEASE_MS) },
            });
            assertOwned(owned.count);
            const cleared = await transaction.creditHourEvidence.updateMany({
              where: { id: item.evidenceId, [field]: item.key, revision: { submissionId: operation.submissionId, submission: { deletedAt: { not: null } } } },
              data: item.field === 'original' ? { originalObjectKey: null, originalData: null } : { displayObjectKey: null, displayData: null },
            });
            if (cleared.count !== 1) throw new Error('Evidence changed during cleanup');
          });
          deleted += 1;
        } catch (error) {
          if (error instanceof ConflictException) throw error;
          failures += 1;
        }
        const progress = await this.prisma.creditHourCleanupOperation.updateMany({ where: owner(), data: { deletedObjects: deleted } });
        assertOwned(progress.count);
      }
      await this.prisma.$transaction(async (transaction) => {
        const finished = await transaction.creditHourCleanupOperation.updateMany({
          where: owner(),
          data: {
            status: failures ? deleted ? 'PARTIAL' : 'FAILED' : 'COMPLETE', deletedObjects: deleted,
            errorMessage: failures ? `${failures} 个凭证对象尚未清理` : null,
            completedAt: failures ? null : new Date(), nextAttemptAt: failures ? new Date(Date.now() + RETRY_MS) : null,
            leaseOwnerToken: null, leasedUntil: null,
          },
        });
        assertOwned(finished.count);
        if (!this.storage.usesCos()) {
          await transaction.creditHourEvidence.updateMany({
            where: { revision: { submissionId: operation.submissionId, submission: { deletedAt: { not: null } } } },
            data: { originalData: null, displayData: null },
          });
        }
      });
    } catch (error) {
      await this.prisma.creditHourCleanupOperation.updateMany({
        where: owner(),
        data: {
          status: deleted ? 'PARTIAL' : 'FAILED', deletedObjects: deleted, errorMessage: '凭证清理中断，等待重试',
          nextAttemptAt: new Date(Date.now() + RETRY_MS), leaseOwnerToken: null, leasedUntil: null,
        },
      }).catch(() => undefined);
      this.logFailure('credit-hour.cleanup-pending', id);
      if (error instanceof ConflictException) throw error;
    }
    return this.prisma.creditHourCleanupOperation.findUniqueOrThrow({
      where: { id },
      select: { id: true, submissionId: true, status: true, totalObjects: true, deletedObjects: true, errorMessage: true },
    });
  }

  async recoverPending() {
    const now = new Date();
    const uploads = await this.prisma.creditHourUploadOperation.findMany({
      where: uploadRecoverable(now), select: { id: true }, orderBy: { createdAt: 'asc' }, take: 10,
    });
    for (const operation of uploads) {
      if (this.stopping) return;
      await this.recoverUpload(operation.id);
    }
    const cleanups = await this.prisma.creditHourCleanupOperation.findMany({
      where: cleanupRecoverable(now), select: { id: true }, orderBy: { createdAt: 'asc' }, take: 10,
    });
    for (const operation of cleanups) {
      if (this.stopping) return;
      await this.executeCleanup(operation.id).catch(() => this.logFailure('credit-hour.cleanup-pending', operation.id));
    }
  }

  private uploadOwner(lease: UploadLease) {
    return { id: lease.id, status: 'UPLOADING' as const, leaseOwnerToken: lease.token, leasedUntil: { gt: new Date() } };
  }

  private scheduleRecovery() {
    if (this.stopping || this.running) return;
    this.running = this.recoverPending()
      .catch(() => this.logFailure('credit-hour.storage-recovery-failed'))
      .finally(() => { this.running = null; });
  }

  private logFailure(event: string, operationId?: string) {
    this.logger.warn(JSON.stringify({ event, operationId }));
  }
}

function assertOwned(count: number) {
  if (count !== 1) throw new ConflictException('存储操作租约已变化，请重试');
}

function uploadRecoverable(now: Date, force = false): Prisma.CreditHourUploadOperationWhereInput {
  return { OR: [
    { status: { in: ['CLEANUP_PENDING', 'CLEANUP_FAILED'] }, ...(force ? {} : { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }) },
    { status: 'CLEANING', OR: [{ leasedUntil: null }, { leasedUntil: { lte: now } }] },
    // Allow bounded in-flight COS writes to settle before reclaiming an interrupted uploader.
    { status: 'UPLOADING', leasedUntil: { lte: new Date(now.getTime() - UPLOAD_SETTLE_MS) } },
  ] };
}

function cleanupRecoverable(now: Date, force = false): Prisma.CreditHourCleanupOperationWhereInput {
  return { OR: [
    { status: { in: ['PENDING', 'PARTIAL', 'FAILED'] }, ...(force ? {} : { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }) },
    { status: 'RUNNING', OR: [{ leasedUntil: null }, { leasedUntil: { lte: now } }] },
  ] };
}

function readUploadManifest(value: Prisma.JsonValue): UploadObject[] {
  if (!Array.isArray(value) || !value.length || value.length > 10) throw new Error('Invalid upload manifest');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.key !== 'string' || !OBJECT_KEY.test(entry.key) || !['PENDING', 'DELETED', 'REFERENCED'].includes(String(entry.status))) throw new Error('Invalid upload manifest entry');
    return { key: entry.key, status: entry.status as UploadObject['status'] };
  });
}

function readCleanupManifest(value: Prisma.JsonValue): CleanupObject[] {
  if (!Array.isArray(value)) throw new Error('Invalid cleanup manifest');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.key !== 'string' || !OBJECT_KEY.test(entry.key) || typeof entry.evidenceId !== 'string' || !['original', 'display'].includes(String(entry.field))) throw new Error('Invalid cleanup manifest entry');
    return { key: entry.key, evidenceId: entry.evidenceId, field: entry.field as CleanupObject['field'] };
  });
}
