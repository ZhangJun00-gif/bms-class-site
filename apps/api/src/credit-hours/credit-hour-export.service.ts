import { Injectable } from '@nestjs/common';
import {
  AccountStatus,
  CreditHourSubmissionStatus,
  CreditHourType,
  type User,
} from '@prisma/client';
import archiver, { type Archiver } from 'archiver';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { MediaStorageService } from '../media/media-storage.service';
import { ExportAdmissionService } from '../media/export-admission.service';
import { waitForExportDrain } from '../media/export-backpressure';

const EXPORT_VERSION = 1;

interface ExportEvidence {
  id: string;
  originalObjectKey: string | null;
  originalMimeType: string;
  originalSize: number;
  originalSha256: string;
}

interface ExportRecord {
  id: string;
  type: CreditHourType;
  decisionSource: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  user: {
    id: string;
    displayName: string;
    status: AccountStatus;
  };
  revisions: Array<{
    activityName: string;
    halfHours: number;
    sourceDescription: string;
    evidence: ExportEvidence[];
  }>;
}

interface ExportLeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  qualityHalfHours: number;
  volunteerHalfHours: number;
  totalHalfHours: number;
}

interface ExportSnapshot {
  leaderboard: ExportLeaderboardEntry[];
  records: ExportRecord[];
  evidenceCount: number;
}

@Injectable()
export class CreditHourExportService {

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorageService,
    private readonly audit: AuditService,
    private readonly admission: ExportAdmissionService,
  ) {}

  async streamApprovedArchive(user: User, response: Response) {
    const release = this.admission.acquire();
    let phase = 'snapshot';
    let snapshot: ExportSnapshot | null = null;
    let archive: Archiver | null = null;
    let onClientClose: (() => void) | null = null;
    let onArchiveFailure!: (error: Error) => void;
    let disconnected: Promise<never> | null = null;
    const requestedAt = new Date();
    try {
      snapshot = await this.loadSnapshot();
      await this.audit.record(
        user.id,
        'credit-hour.export.started',
        'CreditHourExport',
        undefined,
        exportAuditMetadata(snapshot, requestedAt, phase),
      );

      response.status(200);
      response.setHeader('content-type', 'application/zip');
      response.setHeader(
        'content-disposition',
        `attachment; filename="credit-hours-approved-${dateStamp(requestedAt)}.zip"`,
      );
      response.setHeader('cache-control', 'private, no-store');
      response.setHeader('pragma', 'no-cache');
      response.setHeader('x-content-type-options', 'nosniff');

      disconnected = new Promise<never>((_resolve, reject) => {
        onArchiveFailure = reject;
        onClientClose = () => {
          if (!response.writableFinished) {
            reject(new Error('导出连接已关闭'));
          }
        };
        response.once('close', onClientClose);
      });
      // A bounded object read can remain in flight when the client disconnects.
      void disconnected.catch(() => undefined);
      archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', onArchiveFailure);
      archive.on('warning', onArchiveFailure);
      archive.pipe(response);

      phase = 'total-leaderboard.csv';
      await Promise.race([
        appendArchiveEntry(
          archive,
          totalLeaderboardCsv(snapshot.leaderboard),
          'total-leaderboard.csv',
        ),
        disconnected,
      ]);

      phase = 'approved-records.csv';
      await Promise.race([
        appendArchiveEntry(
          archive,
          approvedRecordsCsv(snapshot.records),
          'approved-records.csv',
        ),
        disconnected,
      ]);

      phase = 'evidence';
      for (const record of snapshot.records) {
        const revision = record.revisions[0]!;
        for (const evidence of revision.evidence) {
          const original = await this.readAndVerifyOriginal(evidence);
          if (response.destroyed) throw new Error('导出连接已关闭');
          await Promise.race([
            appendArchiveEntry(
              archive,
              original,
              evidenceArchivePath(record.id, evidence),
            ),
            disconnected,
          ]);
          await waitForExportDrain(response, disconnected);
        }
      }

      phase = 'finalize';
      await Promise.race([
        archive.finalize(),
        disconnected,
      ]);
      await Promise.race([
        finished(response),
        disconnected,
      ]);
      await this.audit.record(
        user.id,
        'credit-hour.export.completed',
        'CreditHourExport',
        undefined,
        exportAuditMetadata(snapshot, requestedAt, phase),
      );
    } catch (error) {
      archive?.abort();
      await this.audit
        .record(
          user.id,
          'credit-hour.export.failed',
          'CreditHourExport',
          undefined,
          exportAuditMetadata(snapshot, requestedAt, phase),
        )
        .catch(() => undefined);
      if (response.headersSent) {
        if (!response.destroyed) response.destroy(asError(error));
        return;
      }
      throw error;
    } finally {
      if (onClientClose) response.off('close', onClientClose);
      release();
    }
  }

  private async loadSnapshot(): Promise<ExportSnapshot> {
    const [activeUsers, records] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where: { status: AccountStatus.ACTIVE },
        orderBy: { id: 'asc' },
        select: { id: true, displayName: true },
      }),
      this.prisma.creditHourSubmission.findMany({
        where: {
          status: CreditHourSubmissionStatus.APPROVED,
          deletedAt: null,
        },
        orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          type: true,
          decisionSource: true,
          decisionReason: true,
          decidedAt: true,
          createdAt: true,
          user: {
            select: { id: true, displayName: true, status: true },
          },
          revisions: {
            orderBy: { revision: 'desc' },
            take: 1,
            select: {
              activityName: true,
              halfHours: true,
              sourceDescription: true,
              evidence: {
                orderBy: { sortOrder: 'asc' },
                select: {
                  id: true,
                  originalObjectKey: true,
                  originalMimeType: true,
                  originalSize: true,
                  originalSha256: true,
                },
              },
            },
          },
        },
      }),
    ]);
    for (const record of records) {
      if (!record.revisions[0]) {
        throw new Error(`学时记录缺少当前修订：${record.id}`);
      }
    }

    const totals = new Map(
      activeUsers.map((user) => [
        user.id,
        {
          displayName: user.displayName,
          qualityHalfHours: 0,
          volunteerHalfHours: 0,
        },
      ]),
    );
    for (const record of records) {
      const total = totals.get(record.user.id);
      if (!total) continue;
      const halfHours = record.revisions[0]!.halfHours;
      if (record.type === CreditHourType.QUALITY) {
        total.qualityHalfHours += halfHours;
      } else {
        total.volunteerHalfHours += halfHours;
      }
    }
    const ordered = [...totals.entries()]
      .map(([userId, total]) => ({
        userId,
        ...total,
        totalHalfHours:
          total.qualityHalfHours + total.volunteerHalfHours,
      }))
      .sort(
        (left, right) =>
          right.totalHalfHours - left.totalHalfHours ||
          left.userId.localeCompare(right.userId),
      );
    let previousTotal: number | null = null;
    let rank = 0;
    const leaderboard = ordered.map((entry, index) => {
      if (entry.totalHalfHours !== previousTotal) rank = index + 1;
      previousTotal = entry.totalHalfHours;
      return { ...entry, rank };
    });
    return {
      leaderboard,
      records,
      evidenceCount: records.reduce(
        (count, record) =>
          count + record.revisions[0]!.evidence.length,
        0,
      ),
    };
  }

  private async readAndVerifyOriginal(evidence: ExportEvidence) {
    const data = evidence.originalObjectKey
      ? await this.storage.readBounded(evidence.originalObjectKey, 10 * 1024 * 1024)
      : Buffer.from(
          (
            await this.prisma.creditHourEvidence.findUnique({
              where: { id: evidence.id },
              select: { originalData: true },
            })
          )?.originalData ?? [],
        );
    if (
      data.length !== evidence.originalSize ||
      createHash('sha256').update(data).digest('hex') !==
        evidence.originalSha256
    ) {
      throw new Error(`学时凭证原图校验失败：${evidence.id}`);
    }
    return data;
  }
}

async function appendArchiveEntry(
  archive: Archiver,
  source: Buffer | string,
  name: string,
) {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      archive.off('entry', onEntry);
      archive.off('warning', onFailure);
      archive.off('error', onFailure);
    };
    const onEntry = (entry: { name: string }) => {
      if (entry.name !== name) return;
      cleanup();
      resolve();
    };
    const onFailure = (error: Error) => {
      cleanup();
      reject(error);
    };
    archive.on('entry', onEntry);
    archive.once('warning', onFailure);
    archive.once('error', onFailure);
    archive.append(source, { name });
  });
}

export function totalLeaderboardCsv(rows: ExportLeaderboardEntry[]) {
  return csv([
    [
      'rank',
      'userId',
      'displayName',
      'qualityHours',
      'volunteerHours',
      'totalHours',
    ],
    ...rows.map((row) => [
      String(row.rank),
      row.userId,
      row.displayName,
      hours(row.qualityHalfHours),
      hours(row.volunteerHalfHours),
      hours(row.totalHalfHours),
    ]),
  ]);
}

export function approvedRecordsCsv(records: ExportRecord[]) {
  return csv([
    [
      'submissionId',
      'userId',
      'displayName',
      'accountStatus',
      'type',
      'activityName',
      'hours',
      'sourceDescription',
      'decisionSource',
      'decisionReason',
      'decidedAt',
      'createdAt',
      'evidenceFiles',
    ],
    ...records.map((record) => {
      const revision = record.revisions[0]!;
      return [
        record.id,
        record.user.id,
        record.user.displayName,
        record.user.status,
        record.type,
        revision.activityName,
        hours(revision.halfHours),
        revision.sourceDescription,
        record.decisionSource ?? '',
        record.decisionReason ?? '',
        record.decidedAt?.toISOString() ?? '',
        record.createdAt.toISOString(),
        revision.evidence
          .map((evidence) => evidenceArchivePath(record.id, evidence))
          .join(';'),
      ];
    }),
  ]);
}

function evidenceArchivePath(submissionId: string, evidence: ExportEvidence) {
  return `evidence/${safeSegment(submissionId)}/${safeSegment(evidence.id)}.${extensionForMime(evidence.originalMimeType)}`;
}

function csv(rows: string[][]) {
  return `\uFEFF${rows
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')}\r\n`;
}

function csvCell(value: string) {
  const spreadsheetSafe = /^(?:[=+\-@\t\r]|\s+[=+\-@])/.test(value)
    ? `'${value}`
    : value;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}

function extensionForMime(mimeType: string) {
  return {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }[mimeType] ?? 'bin';
}

function safeSegment(value: string) {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, '_');
}

function hours(halfHours: number) {
  return (halfHours / 2).toFixed(1);
}

function dateStamp(value: Date) {
  return value.toISOString().slice(0, 10);
}

function exportAuditMetadata(
  snapshot: ExportSnapshot | null,
  requestedAt: Date,
  phase: string,
) {
  return {
    exportVersion: EXPORT_VERSION,
    requestedAt: requestedAt.toISOString(),
    phase,
    activeUserCount: snapshot?.leaderboard.length ?? 0,
    approvedRecordCount: snapshot?.records.length ?? 0,
    evidenceCount: snapshot?.evidenceCount ?? 0,
  };
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error('学时导出失败');
}
