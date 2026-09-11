import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { MediaStorageService } from "./media-storage.service";
import { Prisma } from '@prisma/client';
import { MediaObjectRecoveryService } from './media-object-recovery.service';

const ACTIVE_IMPORT_STATUSES = ["IMPORT_PENDING", "IMPORTING"] as const;
const PROTECTED_KNOWLEDGE_IMPORT_STATUSES = [
  "INDEX_PENDING",
  "PROCESSING",
  "COMPENSATION_FAILED",
] as const;

@Injectable()
export class MediaCleanupService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MediaCleanupService.name);
  private readonly enabled = readBoolean("MEDIA_ORPHAN_CLEANUP_ENABLED", false);
  private readonly intervalMs = readInteger(
    "MEDIA_ORPHAN_CLEANUP_INTERVAL_MS",
    60 * 60 * 1_000,
    60_000,
    7 * 24 * 60 * 60 * 1_000,
  );
  private readonly graceMs = readInteger(
    "MEDIA_ORPHAN_GRACE_MS",
    24 * 60 * 60 * 1_000,
    60 * 60 * 1_000,
    30 * 24 * 60 * 60 * 1_000,
  );
  private readonly batchSize = readInteger(
    "MEDIA_ORPHAN_CLEANUP_BATCH_SIZE",
    100,
    1,
    1_000,
  );
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorageService,
    private readonly recovery: MediaObjectRecoveryService,
  ) {}

  onApplicationBootstrap() {
    if (!this.storage.usesCos()) return;
    if (!this.enabled) {
      this.logger.log(
        JSON.stringify({
          event: "media.orphan-cleanup-status",
          enabled: false,
        }),
      );
      return;
    }
    void this.runCleanup().catch((error) => this.logRunFailure(error));
    this.timer = setInterval(() => {
      void this.runCleanup().catch((error) => this.logRunFailure(error));
    }, this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runCleanup(now = new Date()) {
    if (!this.enabled || !this.storage.usesCos() || this.running) {
      return {
        skipped: true,
        trackedDeleted: 0,
        untrackedDeleted: 0,
        failed: 0,
      };
    }
    this.running = true;
    const cutoff = new Date(now.getTime() - this.graceMs);
    let trackedDeleted = 0;
    let untrackedDeleted = 0;
    let failed = 0;
    let processed = 0;
    const attemptedKeys = new Set<string>();
    try {
      const candidates = await this.prisma.photo.findMany({
        where: {
          objectKey: { not: null },
          createdAt: { lte: cutoff },
          albumId: null,
          news: { none: {} },
          quizQuestions: { none: {} },
          knowledgeImages: { none: {} },
          knowledgeImportAssets: { none: {} },
        },
        select: { id: true, objectKey: true },
        orderBy: { createdAt: "asc" },
        take: this.batchSize,
      });

      for (const candidate of candidates) {
        if (!candidate.objectKey) continue;
        const operationId = await this.prisma.$transaction(async (transaction) => {
          await transaction.$queryRaw(Prisma.sql`SELECT id FROM Photo WHERE id = ${candidate.id} FOR UPDATE`);
          const where = { id: candidate.id, objectKey: candidate.objectKey, createdAt: { lte: cutoff }, albumId: null, news: { none: {} }, quizQuestions: { none: {} }, knowledgeImages: { none: {} }, knowledgeImportAssets: { none: {} } };
          const photo = await transaction.photo.findFirst({ where, select: { id: true, objectKey: true, original: { select: { objectKey: true } } } });
          if (!photo) return null;
          const operation = await this.recovery.planDeletion(transaction, photo.id, [photo.objectKey, photo.original?.objectKey]);
          await transaction.photoOriginal.deleteMany({ where: { photoId: photo.id } });
          const deleted = await transaction.photo.deleteMany({ where });
          if (deleted.count !== 1) throw new Error('Media references changed during cleanup');
          return operation;
        });
        if (!operationId) continue;
        processed += 1;
        attemptedKeys.add(candidate.objectKey);
        try {
          if (await this.recovery.recover(operationId, true)) trackedDeleted += 1;
          else failed += 1;
        } catch (error) {
          failed += 1;
          this.logObjectFailure(
            candidate.objectKey,
            "tracked-photo-delete-failed",
            error,
          );
        }
      }

      const remaining = this.batchSize - processed;
      if (remaining > 0) {
        const [
          objects,
          storedPhotos,
          activeImportAssets,
          protectedKnowledgeAssets,
          protectedMediaOperations,
        ] = await Promise.all([
          this.storage.listObjects(),
          this.prisma.photo.findMany({
            where: { objectKey: { not: null } },
            select: { objectKey: true },
          }),
          this.prisma.quizImportAsset.findMany({
            where: {
              objectKey: { not: null },
              importJob: { status: { in: [...ACTIVE_IMPORT_STATUSES] } },
            },
            select: { objectKey: true },
          }),
          this.prisma.knowledgeImportAsset.findMany({
            where: {
              objectKey: { not: null },
              importJob: {
                status: { in: [...PROTECTED_KNOWLEDGE_IMPORT_STATUSES] },
              },
            },
            select: { objectKey: true },
          }),
          this.recovery.protectedKeys(),
        ]);
        const databaseKeys = new Set(
          storedPhotos.map((photo) => photo.objectKey).filter(Boolean),
        );
        const protectedImportKeys = new Set(
          [...activeImportAssets, ...protectedKnowledgeAssets, ...protectedMediaOperations.map((entry) => ({ objectKey: entry.key }))]
            .map((asset) => asset.objectKey)
            .filter(Boolean),
        );
        const untracked = objects
          .filter(
            (object) =>
              !databaseKeys.has(object.key) &&
              !protectedImportKeys.has(object.key) &&
              !attemptedKeys.has(object.key) &&
              new Date(object.lastModified) <= cutoff,
          )
          .sort((left, right) =>
            left.lastModified.localeCompare(right.lastModified),
          )
          .slice(0, remaining);

        for (const object of untracked) {
          const claimed = await this.prisma.photo.findUnique({
            where: { objectKey: object.key },
            select: { id: true },
          });
          if (claimed) continue;
          const [activeImport, protectedKnowledgeImport] = await Promise.all([
            this.prisma.quizImportAsset.findFirst({
              where: {
                objectKey: object.key,
                importJob: { status: { in: [...ACTIVE_IMPORT_STATUSES] } },
              },
              select: { id: true },
            }),
            this.prisma.knowledgeImportAsset.findFirst({
              where: {
                objectKey: object.key,
                importJob: {
                  status: { in: [...PROTECTED_KNOWLEDGE_IMPORT_STATUSES] },
                },
              },
              select: { id: true },
            }),
          ]);
          if (activeImport || protectedKnowledgeImport) continue;
          if ((await this.recovery.protectedKeys()).some((entry) => entry.key === object.key)) continue;
          try {
            await this.storage.delete(object.key);
            untrackedDeleted += 1;
          } catch (error) {
            failed += 1;
            this.logObjectFailure(
              object.key,
              "untracked-object-delete-failed",
              error,
            );
          }
        }
      }

      const result = {
        skipped: false,
        trackedDeleted,
        untrackedDeleted,
        failed,
      };
      if (trackedDeleted || untrackedDeleted || failed) {
        this.logger.log(
          JSON.stringify({ event: "media.orphan-cleanup", ...result }),
        );
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private logRunFailure(error: unknown) {
    this.logger.error(
      JSON.stringify({
        event: "media.orphan-cleanup-failed",
        message: error instanceof Error ? error.message : "unknown",
      }),
    );
  }

  private logObjectFailure(objectKey: string, reason: string, error: unknown) {
    this.logger.error(
      JSON.stringify({
        event: "media.orphan-object",
        objectKey,
        reason,
      }),
      error instanceof Error ? error.stack : undefined,
    );
  }
}

function readBoolean(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function readInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}
