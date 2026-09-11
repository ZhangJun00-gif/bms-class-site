import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreditHourBatchService } from './credit-hour-batch.service';
import { AdminCreditHourBatchCreateDto } from './credit-hour-batch.dto';
import { CreditHourBatchController } from './credit-hour-batch.controller';
import { REQUIRED_ROLES } from '../common/auth';

const actor = { id: 'admin', role: 'ADMIN', status: 'ACTIVE' } as const;
const request = {
  type: 'QUALITY' as const, activityName: '集体活动', description: '完成同一活动',
  entries: [{ userId: 'member-b', hours: 2 }, { userId: 'member-a', hours: 0.5 }],
};

function fixture() {
  let batches: any[] = [];
  let submissions: any[] = [];
  const users: Array<{ id: string; role: string; status: string }> = [{ ...actor }, ...request.entries.map(({ userId }) => ({ id: userId, role: 'MEMBER', status: 'ACTIVE' }))];
  const failure = { userId: '', serialization: 0 };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const queryRaw = jest.fn();
  const createSubmission = jest.fn();
  const prisma = {
    creditHourSubmissionBatch: { findUnique: jest.fn(async ({ where }) => {
      const key = where.actorId_idempotencyKey;
      const batch = batches.find((row) => row.actorId === key.actorId && row.idempotencyKey === key.idempotencyKey);
      return batch ? { ...batch, submissions } : null;
    }) },
    $transaction: jest.fn(async (action) => {
      if (failure.serialization-- > 0) throw new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '6' });
      const pendingBatches = [...batches];
      const pendingSubmissions = [...submissions];
      const result = await action({
        $queryRaw: queryRaw,
        user: { findMany: jest.fn(async () => users) },
        creditHourSubmissionBatch: {
          create: async ({ data }: any) => {
            const value = { ...data, id: 'batch-1' };
            pendingBatches.push(value);
            return value;
          },
          findUniqueOrThrow: async () => ({ ...pendingBatches[0], submissions: pendingSubmissions }),
        },
        creditHourSubmission: { create: async ({ data }: any) => {
          createSubmission(data);
          if (data.userId === failure.userId) throw new Error('injected write failure');
          const value = { ...data, id: `submission-${data.userId}`, revisions: [data.revisions.create] };
          pendingSubmissions.push(value);
          return value;
        } },
      });
      batches = pendingBatches;
      submissions = pendingSubmissions;
      return result;
    }),
  };
  const service = new CreditHourBatchService(prisma as never, audit as never);
  return { service, prisma, audit, users, failure, queryRaw, createSubmission, stored: () => ({ batches, submissions }) };
}

describe('administrator credit-hour batches', () => {
  it('creates one approved record per user with common reason and individual half-hour values', async () => {
    const f = fixture();
    const result = await f.service.create(actor as never, 'key', request);
    expect(result.count).toBe(2);
    expect(result.items.map((item) => item.hours)).toEqual([0.5, 2]);
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'Serializable' }));
    for (const item of f.stored().submissions) {
      expect(item).toMatchObject({ status: 'APPROVED', decisionSource: 'ADMIN_CREATED', batchId: 'batch-1' });
      expect(item.revisions[0].sourceDescription).toBe(request.description);
      expect(item.decisionEvents.create.actorId).toBe(actor.id);
    }
    expect(f.audit.record).toHaveBeenCalledTimes(3);
  });

  it('replays the same batch even if the client changes selection order or a member is later suspended', async () => {
    const f = fixture();
    const first = await f.service.create(actor as never, 'key', request);
    f.users[1]!.status = 'SUSPENDED';
    const again = await f.service.create(actor as never, 'key', { ...request, entries: [...request.entries].reverse() });
    expect(again).toEqual(first);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.stored().submissions).toHaveLength(2);
  });

  it.each(['hours', 'reason', 'selection'])('rejects same-key content changes: %s', async (change) => {
    const f = fixture();
    await f.service.create(actor as never, 'key', request);
    const changed = structuredClone(request);
    if (change === 'hours') changed.entries[0]!.hours = 3;
    if (change === 'reason') changed.description = '另一理由';
    if (change === 'selection') changed.entries.pop();
    await expect(f.service.create(actor as never, 'key', changed)).rejects.toBeInstanceOf(ConflictException);
    expect(f.stored().submissions).toHaveLength(2);
  });

  it('has no committed batch or records when the second member insert fails', async () => {
    const f = fixture();
    f.failure.userId = 'member-b';
    await expect(f.service.create(actor as never, 'key', request)).rejects.toThrow('injected write failure');
    expect(f.createSubmission).toHaveBeenCalledTimes(2);
    expect(f.stored()).toEqual({ batches: [], submissions: [] });
  });

  it('checks current account state inside the locked transaction before any write', async () => {
    const f = fixture();
    f.users[1]!.status = 'SUSPENDED';
    await expect(f.service.create(actor as never, 'key', request)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.createSubmission).not.toHaveBeenCalled();
  });

  it('rejects a downgraded administrator after the initial guard check', async () => {
    const f = fixture();
    f.users[0] = { ...actor, role: 'MEMBER' };
    await expect(f.service.create(actor as never, 'key', request)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.createSubmission).not.toHaveBeenCalled();
  });

  it('retries rolled-back serialization conflicts within a bounded transaction budget', async () => {
    const f = fixture();
    f.failure.serialization = 1;
    expect((await f.service.create(actor as never, 'key', request)).count).toBe(2);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(f.stored().submissions).toHaveLength(2);
  });

  it.each([0, 0.1, 0.6, 1000.5, NaN, Infinity])('rejects invalid half-hour value %s', async (hours) => {
    const f = fixture();
    await expect(f.service.create(actor as never, 'key', { ...request, entries: [{ userId: 'member-a', hours }] })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects self-awards, duplicate members, empty batches, and non-admin access', async () => {
    const f = fixture();
    await expect(f.service.create(actor as never, 'key', { ...request, entries: [{ userId: actor.id, hours: 1 }] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.create(actor as never, 'key', { ...request, entries: [request.entries[0]!, request.entries[0]!] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.service.create(actor as never, 'key', { ...request, entries: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.service.create({ ...actor, role: 'EDITOR' } as never, 'key', request)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps the controller ADMIN-only and validates nested batch entries', async () => {
    expect(Reflect.getMetadata(REQUIRED_ROLES, CreditHourBatchController)).toEqual(['ADMIN']);
    expect(await validate(plainToInstance(AdminCreditHourBatchCreateDto, request))).toHaveLength(0);
    expect(await validate(plainToInstance(AdminCreditHourBatchCreateDto, { ...request, entries: [{ userId: '', hours: 1001 }] }))).not.toHaveLength(0);
  });
});
