import 'reflect-metadata';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AnnouncementsService } from './announcements.service';
import { AdminAnnouncementsController, AnnouncementsController } from './announcements.controller';
import { IS_PUBLIC, REQUIRED_ROLES } from '../common/auth';

const admin = { id: 'admin', role: 'ADMIN', status: 'ACTIVE' } as never;
const member = { id: 'member', role: 'MEMBER', status: 'ACTIVE' } as never;
const now = new Date();
const published = {
  id: 'latest', title: '最新公告', body: '<script>plain text</script>', status: 'PUBLISHED',
  revision: 2, publishedAt: now, withdrawnAt: null, createdAt: now, updatedAt: now,
};

function fixture() {
  const model = {
    findFirst: jest.fn().mockResolvedValue({ ...published, reads: [] }),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(published),
    findUniqueOrThrow: jest.fn().mockResolvedValue(published),
    create: jest.fn().mockResolvedValue({ ...published, status: 'DRAFT', revision: 1 }),
    update: jest.fn().mockResolvedValue(published),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const reads = { upsert: jest.fn().mockResolvedValue({ readAt: now }) };
  const transaction = { announcement: model, announcementRead: reads, $queryRaw: jest.fn() };
  const prisma = { ...transaction, $transaction: jest.fn(async (fn) => fn(transaction)) };
  const audit = { record: jest.fn() };
  return { service: new AnnouncementsService(prisma as never, audit as never), model, reads, prisma, audit };
}

describe('announcement publication and account receipts', () => {
  it('selects the latest publication before checking receipts and never falls back to an older unread item', async () => {
    const f = fixture();
    f.model.findFirst.mockResolvedValue({ ...published, reads: [{ readAt: now }] });
    const status = await f.service.status(member);
    expect(status.latest).toMatchObject({ id: 'latest', readAt: now });
    expect(f.model.findFirst).toHaveBeenCalledTimes(1);
    expect(f.model.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'PUBLISHED' }, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      select: expect.objectContaining({ reads: { where: { userId: 'member' }, select: { readAt: true } } }),
    }));
    expect(f.reads.upsert).not.toHaveBeenCalled();
  });

  it('returns latest:null for no effective publication', async () => {
    const f = fixture();
    f.model.findFirst.mockResolvedValue(null);
    expect(await f.service.status(member)).toEqual({ latest: null });
  });

  it('opening a detail preserves plain text and does not create a receipt', async () => {
    const f = fixture();
    expect((await f.service.detail(member, 'latest')).body).toBe(published.body);
    expect(f.reads.upsert).not.toHaveBeenCalled();
  });

  it('writes explicit, account-bound, idempotent receipts and locks out concurrent withdrawal', async () => {
    const f = fixture();
    const first = await f.service.acknowledge(member, 'latest');
    expect(await f.service.acknowledge(member, 'latest')).toEqual(first);
    expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.reads.upsert).toHaveBeenCalledWith({
      where: { userId_announcementId: { userId: 'member', announcementId: 'latest' } },
      create: { userId: 'member', announcementId: 'latest' }, update: {}, select: { readAt: true },
    });
  });

  it('does not acknowledge a withdrawn announcement', async () => {
    const f = fixture();
    f.model.findFirst.mockResolvedValue(null);
    await expect(f.service.acknowledge(member, 'latest')).rejects.toBeInstanceOf(NotFoundException);
    expect(f.reads.upsert).not.toHaveBeenCalled();
  });

  it('publishes once and replays the same revision without replacing the timestamp', async () => {
    const f = fixture();
    f.model.findUnique.mockResolvedValueOnce({ ...published, status: 'DRAFT', revision: 1 });
    await f.service.publish(admin, 'latest', 1);
    expect(f.model.update).toHaveBeenCalledTimes(1);
    await f.service.publish(admin, 'latest', 1);
    expect(f.model.update).toHaveBeenCalledTimes(1);
    expect(f.audit.record).toHaveBeenCalledTimes(1);
  });

  it('never permits silent editing or deleting a published body', async () => {
    const f = fixture();
    f.model.updateMany.mockResolvedValue({ count: 0 });
    f.model.deleteMany.mockResolvedValue({ count: 0 });
    await expect(f.service.update(admin, 'latest', { title: '更改', body: '改正文', expectedRevision: 2 })).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.deleteDraft(admin, 'latest', 2)).rejects.toBeInstanceOf(ConflictException);
    expect(f.model.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'latest', status: 'DRAFT', revision: 2 } }));
    expect(f.model.deleteMany).toHaveBeenCalledWith({ where: { id: 'latest', status: 'DRAFT', revision: 2 } });
  });

  it('requires matching revisions and retains existing receipts on withdrawal', async () => {
    const f = fixture();
    await f.service.withdraw(admin, 'latest', 2);
    expect(f.model.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'latest', status: 'PUBLISHED', revision: 2 } }));
    expect(f.model.deleteMany).not.toHaveBeenCalled();
    expect(f.reads.upsert).not.toHaveBeenCalled();
  });

  it('bounds historical pages and carries a stable cursor without receipt side effects', async () => {
    const f = fixture();
    f.model.findMany.mockResolvedValue([{ ...published, reads: [] }, { ...published, id: 'older', reads: [] }]);
    const page = await f.service.history(member, { pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    await f.service.history(member, { pageSize: 1, cursor: page.nextCursor! });
    expect(f.model.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      take: 2, where: { status: 'PUBLISHED', OR: [{ publishedAt: { lt: now } }, { publishedAt: now, id: { lt: 'latest' } }] },
    }));
  });

  it('guards every administrative action and keeps member routes authenticated', async () => {
    const f = fixture();
    const editor = { id: 'editor', role: 'EDITOR', status: 'ACTIVE' } as never;
    await expect(f.service.create(editor, { title: 'x', body: 'y' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.publish(member, 'latest', 1)).rejects.toBeInstanceOf(ForbiddenException);
    expect(Reflect.getMetadata(REQUIRED_ROLES, AdminAnnouncementsController)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(IS_PUBLIC, AnnouncementsController)).toBeUndefined();
  });
});
