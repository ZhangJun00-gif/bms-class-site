import {
  AccountStatus,
  CreditHourDecisionSource,
  CreditHourSubmissionStatus,
  CreditHourType,
  Role,
} from '@prisma/client';
import { CreditHoursService } from './credit-hours.service';

describe('CreditHoursService hour precision', () => {
  const service = new CreditHoursService({} as never, {} as never, {} as never, {} as never, {} as never);
  const user = { id: 'user-1' } as never;

  it('rejects values finer than 0.5 hours before touching storage', async () => {
    await expect(
      service.createSubmission(
        user,
        'idempotency-1',
        {
          type: CreditHourType.QUALITY,
          activityName: '活动',
          hours: 1.25,
          sourceDescription: '来源',
        },
        [],
      ),
    ).rejects.toThrow('必须以 0.5 小时递增');
  });

  it('rejects user submissions above 1000 hours before touching storage', async () => {
    await expect(
      service.createSubmission(
        user,
        'idempotency-over-limit',
        {
          type: CreditHourType.QUALITY,
          activityName: '活动',
          hours: 1_000.5,
          sourceDescription: '来源',
        },
        [],
      ),
    ).rejects.toThrow('0.5-1000 小时');
  });
});

describe('CreditHoursService public ranking', () => {
  const users = [
    {
      id: 'user-a',
      displayName: '甲',
      creditHourSubmissions: [
        { type: CreditHourType.QUALITY, revisions: [{ halfHours: 4 }] },
        { type: CreditHourType.VOLUNTEER, revisions: [{ halfHours: 2 }] },
      ],
    },
    {
      id: 'user-b',
      displayName: '乙',
      creditHourSubmissions: [
        { type: CreditHourType.QUALITY, revisions: [{ halfHours: 4 }] },
      ],
    },
    {
      id: 'user-c',
      displayName: '丙',
      creditHourSubmissions: [],
    },
  ];
  const prisma = {
    user: { findMany: jest.fn().mockResolvedValue(users) },
  };
  const service = new CreditHoursService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('includes zero-hour users and gives tied users the same public rank', async () => {
    const result = await service.leaderboard('user-b', {
      type: CreditHourType.QUALITY,
      pageSize: 100,
    });

    expect(result.items.map((item) => [item.userId, item.rank])).toEqual([
      ['user-a', 1],
      ['user-b', 1],
      ['user-c', 3],
    ]);
    expect(result.items[1]?.currentUser).toBe(true);
    expect(result.items[2]?.qualityHours).toBe(0);
    expect(result.items[0]?.totalHours).toBe(3);
  });

  it('ranks combined hours with ties using integer half-hour totals', async () => {
    const result = await service.leaderboard('user-a', {
      type: 'TOTAL',
      pageSize: 100,
    });

    expect(result.items.map((item) => [item.userId, item.totalHours, item.rank])).toEqual([
      ['user-a', 3, 1],
      ['user-b', 2, 2],
      ['user-c', 0, 3],
    ]);
  });

  it('paginates the admin overview in low-total-hours-first order', async () => {
    const first = await service.adminOverview({
      pageSize: 2,
    });
    const second = await service.adminOverview({
      pageSize: 2,
      cursor: first.nextCursor!,
    });

    expect(first.type).toBe('TOTAL');
    expect(first.items.map((item) => item.userId)).toEqual(['user-c', 'user-b']);
    expect(second.items.map((item) => item.userId)).toEqual(['user-a']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('CreditHoursService admin-created records', () => {
  const actor = {
    id: 'admin-1',
    displayName: '管理员',
    role: Role.ADMIN,
    status: AccountStatus.ACTIVE,
  } as never;

  it('atomically creates an approved record without evidence or an AI job', async () => {
    const now = new Date('2026-09-03T00:00:00.000Z');
    const created = {
      id: 'submission-1',
      userId: 'user-2',
      user: { id: 'user-2', displayName: '乙同学' },
      type: CreditHourType.VOLUNTEER,
      status: CreditHourSubmissionStatus.APPROVED,
      revision: 1,
      currentReviewCycle: 1,
      idempotencyKey: 'admin-create-1',
      requestHash: 'hash',
      replacesSubmissionId: null,
      generation: 1,
      decisionSource: CreditHourDecisionSource.ADMIN_CREATED,
      decisionReason: '管理员直接录入，无需 AI 审核',
      decidedAt: now,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      revisions: [
        {
          id: 'revision-1',
          revision: 1,
          activityName: '志愿活动',
          halfHours: 2_000,
          sourceDescription: '管理员核验后录入',
          evidence: [],
        },
      ],
      reviewJobs: [],
    };
    const transaction = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-2',
          status: AccountStatus.ACTIVE,
        }),
      },
      creditHourSubmission: {
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const prisma = {
      creditHourSubmission: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(
        (task: (tx: typeof transaction) => unknown) => task(transaction),
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new CreditHoursService(
      prisma as never,
      {} as never,
      audit as never,
      {} as never,
      {} as never,
    );

    const result = await service.createAdminSubmission(
      actor,
      'admin-create-1',
      {
        userId: 'user-2',
        type: CreditHourType.VOLUNTEER,
        activityName: ' 志愿活动 ',
        hours: 1_000,
        description: ' 管理员核验后录入 ',
      },
    );

    expect(transaction.creditHourSubmission.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-2',
          status: CreditHourSubmissionStatus.APPROVED,
          decisionSource: CreditHourDecisionSource.ADMIN_CREATED,
          revisions: {
            create: expect.objectContaining({
              activityName: '志愿活动',
              halfHours: 2_000,
              sourceDescription: '管理员核验后录入',
            }),
          },
          decisionEvents: {
            create: expect.objectContaining({
              source: CreditHourDecisionSource.ADMIN_CREATED,
              actorId: 'admin-1',
              toStatus: CreditHourSubmissionStatus.APPROVED,
            }),
          },
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'admin-1',
      'credit-hour.admin-create',
      'CreditHourSubmission',
      'submission-1',
      {
        targetUserId: 'user-2',
        type: CreditHourType.VOLUNTEER,
        halfHours: 2_000,
      },
      transaction,
    );
    expect(result).toMatchObject({
      id: 'submission-1',
      status: CreditHourSubmissionStatus.APPROVED,
      hours: 1_000,
      decisionSource: CreditHourDecisionSource.ADMIN_CREATED,
      evidence: [],
      reviewJob: null,
    });
  });

  it('rejects self-targeting, inactive users, and finer-than-half-hour input', async () => {
    const serviceWithoutDatabase = new CreditHoursService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      serviceWithoutDatabase.createAdminSubmission(actor, 'key-1', {
        userId: 'admin-1',
        type: CreditHourType.QUALITY,
        activityName: '活动',
        hours: 1,
        description: '描述',
      }),
    ).rejects.toThrow('不能通过此入口为自己录入学时');
    await expect(
      serviceWithoutDatabase.createAdminSubmission(actor, 'key-2', {
        userId: 'user-2',
        type: CreditHourType.QUALITY,
        activityName: '活动',
        hours: 1.25,
        description: '描述',
      }),
    ).rejects.toThrow('必须以 0.5 小时递增');
    await expect(
      serviceWithoutDatabase.createAdminSubmission(actor, 'key-over-limit', {
        userId: 'user-2',
        type: CreditHourType.QUALITY,
        activityName: '活动',
        hours: 1_000.5,
        description: '描述',
      }),
    ).rejects.toThrow('0.5-1000 小时');

    const transaction = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-2',
          status: AccountStatus.SUSPENDED,
        }),
      },
    };
    const service = new CreditHoursService(
      {
        creditHourSubmission: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        $transaction: (task: (tx: typeof transaction) => unknown) =>
          task(transaction),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.createAdminSubmission(actor, 'key-3', {
        userId: 'user-2',
        type: CreditHourType.QUALITY,
        activityName: '活动',
        hours: 1,
        description: '描述',
      }),
    ).rejects.toThrow('只能为正常状态的用户录入学时');
  });

  it('does not reopen an evidence-free record into AI review', async () => {
    const transaction = {
      creditHourSubmission: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'submission-1',
          status: CreditHourSubmissionStatus.APPROVED,
          revision: 1,
        }),
      },
      creditHourEvidence: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = new CreditHoursService(
      {
        $transaction: (task: (tx: typeof transaction) => unknown) =>
          task(transaction),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.reopen(actor, 'submission-1', {
        expectedRevision: 1,
        reason: '重新审核',
      }),
    ).rejects.toThrow('无凭证记录不能进入 AI 审核');
  });
});
