import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { KnowledgeAccessService } from './knowledge-access.service';

describe('KnowledgeAccessService tenant boundaries', () => {
  function suspensionFixture() {
    const library = {
      id: 'private-1', scope: 'PRIVATE', ownerId: 'owner-1', name: '资料库',
      active: true, adminDisabledAt: null as Date | null, deletedAt: null,
      aiEnabledAt: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const transaction = {
      knowledgeLibrary: {
        updateMany: jest.fn(async ({ where, data }) => {
          if ('adminDisabledAt' in where && library.adminDisabledAt !== null) {
            return { count: 0 };
          }
          Object.assign(library, data);
          return { count: 1 };
        }),
        findUniqueOrThrow: jest.fn(async () => ({ ...library })),
      },
      quizQuestionKnowledgeSource: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma = {
      knowledgeLibrary: { findFirst: jest.fn(async () => ({ ...library })) },
      $transaction: jest.fn(async (fn) => fn(transaction)),
    };
    const service = new KnowledgeAccessService(
      prisma as never, { record: jest.fn() } as never,
    );
    return { service, library, transaction, prisma };
  }

  it('prevents an owner from re-enabling an admin-disabled library', async () => {
    const { service, library } = suspensionFixture();
    await service.setPrivateStatus({ id: 'admin', role: 'ADMIN' } as never, library.id, false);
    await expect(service.update(
      { id: 'owner-1', role: 'MEMBER' } as never, library.id, { active: true },
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(library.active).toBe(false);
    expect(library.adminDisabledAt).toBeInstanceOf(Date);
  });

  it('still rejects reactivation when suspension arrives after the ownership read', async () => {
    const { service, library, prisma } = suspensionFixture();
    prisma.knowledgeLibrary.findFirst.mockImplementationOnce(async () => {
      const before = { ...library };
      library.active = false;
      library.adminDisabledAt = new Date();
      return before;
    });
    await expect(service.update(
      { id: 'owner-1', role: 'MEMBER' } as never, library.id, { active: true },
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(library.active).toBe(false);
  });

  it('allows owner renaming during suspension and reactivation after admin restore', async () => {
    const { service, library } = suspensionFixture();
    const owner = { id: 'owner-1', role: 'MEMBER' } as never;
    const admin = { id: 'admin', role: 'ADMIN' } as never;
    await service.setPrivateStatus(admin, library.id, false);
    await service.update(owner, library.id, { name: '更名资料库' });
    expect(library.name).toBe('更名资料库');
    expect(library.active).toBe(false);
    await service.setPrivateStatus(admin, library.id, true);
    expect(library.adminDisabledAt).toBeNull();
    await service.update(owner, library.id, { active: false });
    await service.update(owner, library.id, { active: true });
    expect(library.active).toBe(true);
  });

  it('does not allow non-admin callers to clear an administrative suspension', async () => {
    const { service, transaction } = suspensionFixture();
    await expect(service.setPrivateStatus(
      { id: 'owner-1', role: 'MEMBER' } as never, 'private-1', true,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction.knowledgeLibrary.updateMany).not.toHaveBeenCalled();
  });

  it('limits accessible private libraries to the current owner', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new KnowledgeAccessService(
      { knowledgeLibrary: { findMany } } as never,
      {} as never,
    );

    await service.listAccessible({ id: 'member-1' } as never);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              scope: 'PRIVATE',
              ownerId: 'member-1',
            }),
          ]),
        }),
      }),
    );
  });

  it('does not let a member manage a shared library', async () => {
    const service = new KnowledgeAccessService(
      {
        knowledgeLibrary: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'shared-1',
            scope: 'SHARED',
            ownerId: null,
          }),
        },
      } as never,
      {} as never,
    );

    await expect(
      service.assertManage(
        { id: 'member-1', role: 'MEMBER' } as never,
        'shared-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not let an administrator manage another member private library', async () => {
    const service = new KnowledgeAccessService(
      {
        knowledgeLibrary: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'private-1',
            scope: 'PRIVATE',
            ownerId: 'owner-1',
          }),
        },
      } as never,
      {} as never,
    );

    await expect(
      service.assertManage(
        { id: 'admin-1', role: 'ADMIN' } as never,
        'private-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns not found when a private library is outside the user scope', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = new KnowledgeAccessService(
      { knowledgeLibrary: { findFirst } } as never,
      {} as never,
    );

    await expect(
      service.getAccessible({ id: 'admin-1' } as never, 'private-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { scope: 'PRIVATE', ownerId: 'admin-1' },
          ]),
        }),
      }),
    );
  });

  it('locks the owner capacity row before enforcing the private library limit', async () => {
    const transaction = {
      knowledgeCapacityCounter: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      knowledgeLibrary: {
        count: jest.fn().mockResolvedValue(2),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const prisma = {
      subject: { findFirst: jest.fn().mockResolvedValue({ id: 'subject-1' }) },
      $transaction: jest.fn((action: (tx: typeof transaction) => unknown) =>
        action(transaction),
      ),
    };
    const service = new KnowledgeAccessService(prisma as never, {} as never);

    await expect(
      service.create(
        { id: 'owner-1', role: 'MEMBER' } as never,
        { name: '个人资料库', subjectId: 'subject-1', scope: 'PRIVATE' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.knowledgeLibrary.count).toHaveBeenCalledWith({
      where: {
        ownerId: 'owner-1',
        scope: 'PRIVATE',
        deletedAt: null,
      },
    });
    expect(transaction.knowledgeLibrary.create).not.toHaveBeenCalled();
  });
});
