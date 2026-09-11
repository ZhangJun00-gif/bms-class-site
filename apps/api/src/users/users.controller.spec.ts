import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AccountStatus, Prisma, Role } from '@prisma/client';
import { UsersController } from './users.controller';

interface UserRecord {
  id: string;
  displayName: string;
  role: Role;
  status: AccountStatus;
}

function setup(existing: UserRecord, activeAdminCount = 1) {
  const tx = {
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(existing),
      count: jest.fn().mockResolvedValue(activeAdminCount),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Partial<UserRecord> }) =>
          Promise.resolve({ ...existing, ...data }),
        ),
    },
    session: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const prisma = {
    $transaction: jest
      .fn()
      .mockImplementation((task: (client: typeof tx) => Promise<unknown>) =>
        task(tx),
      ),
  };
  const controller = new UsersController(prisma as never, {} as never);
  return { controller, prisma, tx };
}

const admin: UserRecord = {
  id: 'admin-1',
  displayName: '管理员一',
  role: Role.ADMIN,
  status: AccountStatus.ACTIVE,
};

describe('UsersController administrator safety', () => {
  it('rejects suspending the current administrator', async () => {
    const { controller, tx } = setup(admin, 2);

    await expect(
      controller.update(
        admin.id,
        { status: AccountStatus.SUSPENDED },
        admin as never,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('rejects demoting the current administrator even when another admin remains', async () => {
    const { controller, tx } = setup(admin, 2);

    await expect(
      controller.update(admin.id, { role: Role.EDITOR }, admin as never),
    ).rejects.toThrow(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it.each([
    [{ role: Role.EDITOR }, 'demoting'],
    [{ status: AccountStatus.SUSPENDED }, 'suspending'],
  ] as const)(
    'rejects $1 the last active administrator',
    async (change, _label) => {
      const target = { ...admin, id: 'admin-2' };
      const { controller, tx } = setup(target, 1);

      await expect(
        controller.update(target.id, change, admin as never),
      ).rejects.toThrow(ConflictException);
      expect(tx.user.update).not.toHaveBeenCalled();
    },
  );

  it('allows an administrator change when another active administrator remains', async () => {
    const target = { ...admin, id: 'admin-2' };
    const { controller, tx } = setup(target, 2);

    await expect(
      controller.update(target.id, { role: Role.EDITOR }, admin as never),
    ).resolves.toMatchObject({ id: target.id, role: Role.EDITOR });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: admin.id,
        action: 'user.update',
        targetId: target.id,
        metadata: { role: Role.EDITOR },
      }),
    });
  });

  it('uses Serializable isolation so concurrent admin changes cannot both commit', async () => {
    const target = { ...admin, id: 'admin-2' };
    const { controller, prisma } = setup(target, 2);

    await controller.update(target.id, { role: Role.EDITOR }, admin as never);

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it('rejects resetting the current administrator password', async () => {
    const { controller } = setup(admin, 2);
    await expect(
      controller.resetPassword(admin.id, admin as never),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('UsersController invite lifecycle', () => {
  const invite = {
    id: 'invite-1',
    label: '秋季入班',
    active: true,
    maxUses: 5,
    usedCount: 2,
    expiresAt: new Date('2030-09-01T00:00:00.000Z'),
    revokedAt: null,
    createdAt: new Date('2026-08-11T00:00:00.000Z'),
  };

  it('lists invite metadata without selecting the code hash', async () => {
    const prisma = {
      invite: { findMany: jest.fn().mockResolvedValue([invite]) },
    };
    const controller = new UsersController(prisma as never, {} as never);

    await expect(controller.invites()).resolves.toEqual({
      items: [expect.objectContaining({ id: 'invite-1', state: 'ACTIVE' })],
      total: 1,
    });
    const selection = prisma.invite.findMany.mock.calls[0]![0].select;
    expect(selection.codeHash).toBeUndefined();
  });

  it('distinguishes exhausted and expired invites from explicit revocation', async () => {
    const prisma = {
      invite: {
        findMany: jest.fn().mockResolvedValue([
          { ...invite, usedCount: invite.maxUses },
          {
            ...invite,
            id: 'invite-expired',
            expiresAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            ...invite,
            id: 'invite-revoked',
            active: false,
            revokedAt: new Date('2026-08-11T01:00:00.000Z'),
          },
        ]),
      },
    };
    const controller = new UsersController(prisma as never, {} as never);

    const result = await controller.invites();

    expect(result.items.map((item) => item.state)).toEqual([
      'EXHAUSTED',
      'EXPIRED',
      'REVOKED',
    ]);
  });

  it('revokes an invite idempotently and audits only the winning transition', async () => {
    const transaction = {
      invite: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValueOnce({ id: invite.id })
          .mockResolvedValueOnce({
            ...invite,
            active: false,
            revokedAt: new Date('2026-08-11T01:00:00.000Z'),
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (action) => action(transaction)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new UsersController(prisma as never, audit as never);

    await expect(
      controller.revokeInvite(invite.id, admin as never),
    ).resolves.toEqual(expect.objectContaining({ state: 'REVOKED' }));
    expect(transaction.invite.updateMany).toHaveBeenCalledWith({
      where: { id: invite.id, active: true },
      data: { active: false, revokedAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      admin.id,
      'invite.revoke',
      'Invite',
      invite.id,
      undefined,
      transaction,
    );
  });
});

describe('UsersController audit log pagination and export', () => {
  const createdAt = new Date('2026-08-11T02:00:00.000Z');
  const row = {
    id: 'audit-2',
    actorId: 'admin-1',
    action: 'album.archive',
    targetType: 'Album',
    targetId: 'album-1',
    metadata: null,
    createdAt,
    actor: { id: 'admin-1', displayName: '=FORMULA' },
  };

  it('uses a stable time/id cursor and applies the requested filters', async () => {
    const prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([
          row,
          { ...row, id: 'audit-overflow' },
        ]),
      },
    };
    const controller = new UsersController(prisma as never, {} as never);

    const result = await controller.logs({
      actorId: 'admin-1',
      action: 'album.archive',
      targetType: 'Album',
      pageSize: 1,
    });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          actorId: 'admin-1',
          action: 'album.archive',
          targetType: 'Album',
        },
        take: 2,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('exports the same bounded filters and neutralizes spreadsheet formulas', async () => {
    const prisma = {
      auditLog: { findMany: jest.fn().mockResolvedValue([row]) },
    };
    const response = {
      type: jest.fn(),
      setHeader: jest.fn(),
    };
    const controller = new UsersController(prisma as never, {} as never);

    const csv = await controller.exportLogs(
      { targetType: 'Album', limit: 50 },
      response as never,
    );

    expect(csv).toContain("'=FORMULA");
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { targetType: 'Album' }, take: 51 }),
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Result-Truncated',
      'false',
    );
  });

  it('neutralizes formulas preceded by whitespace in exported cells', async () => {
    const prisma = {
      auditLog: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ ...row, actor: { ...row.actor, displayName: '  =FORMULA' } }]),
      },
    };
    const controller = new UsersController(prisma as never, {} as never);

    const csv = await controller.exportLogs(
      { limit: 1 },
      { type: jest.fn(), setHeader: jest.fn() } as never,
    );

    expect(csv).toContain("'  =FORMULA");
  });
});
