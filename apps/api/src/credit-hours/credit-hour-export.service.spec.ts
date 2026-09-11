import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { ExportAdmissionService } from '../media/export-admission.service';
import {
  approvedRecordsCsv,
  CreditHourExportService,
  totalLeaderboardCsv,
} from './credit-hour-export.service';

class MemoryResponse extends Writable {
  readonly chunks: Buffer[] = [];
  readonly headers = new Map<string, string>();
  statusCode = 200;
  headersSent = false;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

describe('credit-hour export CSV', () => {
  it('exports combined rankings and neutralizes spreadsheet formulas', () => {
    const content = totalLeaderboardCsv([
      {
        rank: 1,
        userId: 'user-1',
        displayName: '  =危险姓名',
        qualityHalfHours: 3,
        volunteerHalfHours: 2,
        totalHalfHours: 5,
      },
    ]);

    expect(content.startsWith('\uFEFF')).toBe(true);
    expect(content).toContain(
      '"userId","displayName","qualityHours","volunteerHours","totalHours"',
    );
    expect(content).toContain('"\'  =危险姓名"');
    expect(content).toContain('"1.5","1.0","2.5"');
  });

  it('maps approved records to current evidence paths without storage keys', () => {
    const content = approvedRecordsCsv([
      {
        id: 'submission/1',
        type: 'QUALITY',
        decisionSource: 'ADMIN',
        decisionReason: null,
        decidedAt: new Date('2026-09-01T00:00:00.000Z'),
        createdAt: new Date('2026-08-31T00:00:00.000Z'),
        user: {
          id: 'user-1',
          displayName: '甲同学',
          status: 'ACTIVE',
        },
        revisions: [
          {
            activityName: '+危险活动',
            halfHours: 1,
            sourceDescription: '@危险来源',
            evidence: [
              {
                id: 'evidence/1',
                originalObjectKey: 'credit-hours/original/private.png',
                originalMimeType: 'image/png',
                originalSize: 3,
                originalSha256: '0'.repeat(64),
              },
            ],
          },
        ],
      },
    ]);

    expect(content).toContain('"\'+危险活动"');
    expect(content).toContain('"\'@危险来源"');
    expect(content).toContain('"evidence/submission_1/evidence_1.png"');
    expect(content).not.toContain('credit-hours/original/private.png');
  });

  it('streams a complete ZIP with aggregate audit records', async () => {
    const original = Buffer.from([1, 2, 3]);
    const record = {
      id: 'submission-1',
      type: 'QUALITY',
      decisionSource: 'AI',
      decisionReason: '通过',
      decidedAt: new Date('2026-09-01T00:00:00.000Z'),
      createdAt: new Date('2026-08-31T00:00:00.000Z'),
      user: { id: 'user-1', displayName: '甲同学', status: 'ACTIVE' },
      revisions: [
        {
          activityName: '活动',
          halfHours: 2,
          sourceDescription: '来源',
          evidence: [
            {
              id: 'evidence-1',
              originalObjectKey: null,
              originalMimeType: 'image/png',
              originalSize: original.length,
              originalSha256: createHash('sha256')
                .update(original)
                .digest('hex'),
            },
          ],
        },
      ],
    };
    const prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      creditHourSubmission: { findMany: jest.fn().mockResolvedValue([]) },
      creditHourEvidence: {
        findUnique: jest.fn().mockResolvedValue({ originalData: original }),
      },
      $transaction: jest.fn().mockResolvedValue([
        [{ id: 'user-1', displayName: '甲同学' }],
        [record],
      ]),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new CreditHourExportService(
      prisma as never,
      { readBounded: jest.fn() } as never,
      audit as never,
      new ExportAdmissionService(),
    );
    const response = new MemoryResponse();

    await service.streamApprovedArchive(
      { id: 'admin-1' } as never,
      response as never,
    );

    const zip = Buffer.concat(response.chunks);
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    expect(zip.includes(Buffer.from('total-leaderboard.csv'))).toBe(true);
    expect(zip.includes(Buffer.from('approved-records.csv'))).toBe(true);
    expect(
      zip.includes(Buffer.from('evidence/submission-1/evidence-1.png')),
    ).toBe(true);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(audit.record.mock.calls.map((call) => call[1])).toEqual([
      'credit-hour.export.started',
      'credit-hour.export.completed',
    ]);
  });

  it('aborts a disconnected stream and rejects a concurrent export', async () => {
    let finishRead!: (data: Buffer) => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const record = {
      id: 'submission-2',
      type: 'VOLUNTEER',
      decisionSource: 'AI',
      decisionReason: null,
      decidedAt: new Date('2026-09-01T00:00:00.000Z'),
      createdAt: new Date('2026-08-31T00:00:00.000Z'),
      user: { id: 'user-2', displayName: '乙同学', status: 'ACTIVE' },
      revisions: [
        {
          activityName: '活动',
          halfHours: 1,
          sourceDescription: '来源',
          evidence: [
            {
              id: 'evidence-2',
              originalObjectKey: 'credit-hours/original/private.png',
              originalMimeType: 'image/png',
              originalSize: 3,
              originalSha256: createHash('sha256').update('abc').digest('hex'),
            },
          ],
        },
      ],
    };
    const prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      creditHourSubmission: { findMany: jest.fn().mockResolvedValue([]) },
      creditHourEvidence: { findUnique: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([
        [{ id: 'user-2', displayName: '乙同学' }],
        [record],
      ]),
    };
    const storage = {
      readBounded: jest.fn().mockImplementation(() => {
        markReadStarted();
        return new Promise<Buffer>((resolve) => { finishRead = resolve; });
      }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new CreditHourExportService(
      prisma as never,
      storage as never,
      audit as never,
      new ExportAdmissionService(),
    );
    const firstResponse = new MemoryResponse();
    const first = service.streamApprovedArchive(
      { id: 'admin-1' } as never,
      firstResponse as never,
    );
    await readStarted;

    await expect(
      service.streamApprovedArchive(
        { id: 'admin-2' } as never,
        new MemoryResponse() as never,
      ),
    ).rejects.toThrow('已有导出正在生成');

    firstResponse.destroy();
    await expect(service.streamApprovedArchive(
      { id: 'admin-2' } as never, new MemoryResponse() as never,
    )).rejects.toThrow('已有导出正在生成');
    finishRead(Buffer.from('abc'));
    await expect(first).resolves.toBeUndefined();
    expect(audit.record.mock.calls.map((call) => call[1])).toEqual([
      'credit-hour.export.started',
      'credit-hour.export.failed',
    ]);
  });
});
