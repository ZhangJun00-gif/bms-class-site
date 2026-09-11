import { CreditHoursService } from './credit-hours.service';

jest.mock('@bmc3/media-core', () => ({
  ...jest.requireActual('@bmc3/media-core'),
  inspectImage: jest.fn().mockResolvedValue({ format: 'png', width: 10, height: 8 }),
}));

function fixture() {
  const events: string[] = [];
  const lease = { id: 'operation-fixture', token: 'token-fixture' };
  let manifest: string[] = [];
  const recovery = {
    beginUpload: jest.fn(async (_user: string, _key: string, _hash: string, keys: string[]) => {
      manifest = [...keys];
      events.push('manifest');
      return lease;
    }),
    renewUpload: jest.fn().mockResolvedValue(undefined),
    commitUpload: jest.fn(async () => { events.push('commit-operation'); }),
    compensateUpload: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    usesCos: () => true,
    upload: jest.fn(async (_data: Buffer, key: string) => {
      expect(manifest).toContain(key);
      expect(manifest).toHaveLength(2);
      events.push('upload');
    }),
  };
  const transaction = {
    creditHourSubmission: {
      create: jest.fn(async () => {
        events.push('create-submission');
        return {
          id: 'submission-fixture', status: 'PENDING_REVIEW',
          user: { id: 'user-fixture' },
          revisions: [{ activityName: 'Fixture', sourceDescription: 'Fixture', halfHours: 2, evidence: [] }],
          reviewJobs: [],
        };
      }),
    },
  };
  const prisma = {
    creditHourSubmission: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (run: (tx: typeof transaction) => unknown) => run(transaction)),
  };
  const processing = { compress: jest.fn().mockResolvedValue({ data: Buffer.from('display'), size: 7, width: 10, height: 8 }) };
  const service = new CreditHoursService(prisma as never, storage as never, { record: jest.fn() } as never, processing as never, recovery as never);
  const submit = () => service.createSubmission(
    { id: 'user-fixture' } as never, 'key-fixture',
    { type: 'QUALITY', activityName: 'Fixture', hours: 1, sourceDescription: 'Fixture' },
    [{ buffer: Buffer.from('original') } as Express.Multer.File],
  );
  return { submit, storage, prisma, transaction, recovery, events, lease };
}

describe('credit-hour upload durable write ordering', () => {
  it('persists both exact keys before the first upload and commits their operation inside the submission transaction', async () => {
    const f = fixture();
    await expect(f.submit()).resolves.toMatchObject({ id: 'submission-fixture' });
    expect(f.events).toEqual(['manifest', 'upload', 'upload', 'commit-operation', 'create-submission']);
    expect(f.recovery.commitUpload).toHaveBeenCalledWith(f.transaction, f.lease);
    expect(f.recovery.compensateUpload).not.toHaveBeenCalled();
    const data = (f.transaction.creditHourSubmission.create.mock.calls as unknown as Array<[{ data: any }]>)[0]![0].data;
    expect(data.revisions.create.evidence.create[0]).toMatchObject({ originalData: null, displayData: null });
  });

  it('does not write COS when the durable manifest cannot be created', async () => {
    const f = fixture();
    f.recovery.beginUpload.mockRejectedValueOnce(new Error('manifest unavailable'));
    await expect(f.submit()).rejects.toThrow('manifest unavailable');
    expect(f.storage.upload).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('hands a failed second upload to durable recovery without creating a submission', async () => {
    const f = fixture();
    f.storage.upload.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('upload unavailable'));
    await expect(f.submit()).rejects.toThrow('upload unavailable');
    expect(f.recovery.compensateUpload).toHaveBeenCalledWith(f.lease);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not create metadata after losing upload ownership and schedules exact compensation', async () => {
    const f = fixture();
    f.recovery.commitUpload.mockRejectedValueOnce(new Error('lease lost'));
    await expect(f.submit()).rejects.toThrow('lease lost');
    expect(f.transaction.creditHourSubmission.create).not.toHaveBeenCalled();
    expect(f.recovery.compensateUpload).toHaveBeenCalledWith(f.lease);
  });
});
