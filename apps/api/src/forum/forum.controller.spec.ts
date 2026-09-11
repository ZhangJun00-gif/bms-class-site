import { ForumController } from './forum.controller';

describe('ForumController thread pagination', () => {
  it('paginates threads at the database level', async () => {
    const prisma = {
      forumThread: {
        findMany: jest.fn().mockResolvedValue([{ id: 'thread-11' }]),
        count: jest.fn().mockResolvedValue(30),
      },
    };
    const audit = { record: jest.fn() };
    const controller = new ForumController(prisma as never, audit as never);

    const result = await controller.threads({ page: 2, pageSize: 10 });

    expect(prisma.forumThread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
    expect(result).toMatchObject({ total: 30, page: 2, pageSize: 10 });
    expect(result.items).toHaveLength(1);
  });
});

describe('ForumController thread lifecycle', () => {
  it('locks and rechecks the thread before creating a reply', async () => {
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'thread-1' }]),
      forumThread: {
        findUnique: jest.fn().mockResolvedValue({
          locked: false,
          hidden: false,
          deletedAt: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      forumPost: {
        create: jest.fn().mockResolvedValue({ id: 'post-1' }),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (action: (tx: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const controller = new ForumController(prisma as never, {} as never);

    await controller.reply(
      'thread-1',
      { body: '回复正文' },
      { id: 'member-1' } as never,
    );

    expect(transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.forumThread.findUnique.mock.invocationCallOrder[0]!,
    );
    expect(
      transaction.forumThread.findUnique.mock.invocationCallOrder[0],
    ).toBeLessThan(transaction.forumPost.create.mock.invocationCallOrder[0]!);
  });

  it('does not create a reply when moderation won the row-lock race', async () => {
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'thread-1' }]),
      forumThread: {
        findUnique: jest.fn().mockResolvedValue({
          locked: true,
          hidden: false,
          deletedAt: null,
        }),
      },
      forumPost: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(
        async (action: (tx: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const controller = new ForumController(prisma as never, {} as never);

    await expect(
      controller.reply(
        'thread-1',
        { body: '迟到的回复' },
        { id: 'member-1' } as never,
      ),
    ).rejects.toThrow('主题已锁定');
    expect(transaction.forumPost.create).not.toHaveBeenCalled();
  });
});
