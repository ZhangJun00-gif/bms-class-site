import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ContentStatus, Role, Visibility } from '@prisma/client';
import { NewsController } from './news.controller';

const timestamp = new Date('2026-07-22T08:00:00.000Z');

function owner(overrides: Record<string, unknown> = {}) {
  return {
    id: 'news-1',
    authorId: 'editor-1',
    status: ContentStatus.DRAFT,
    publishedAt: null,
    updatedAt: timestamp,
    ...overrides,
  };
}

function writeDto(overrides: Record<string, unknown> = {}) {
  return {
    title: '动态标题',
    summary: '动态摘要',
    body: '<p>动态正文</p>',
    visibility: Visibility.MEMBERS,
    status: ContentStatus.DRAFT,
    ...overrides,
  };
}

describe('NewsController reads', () => {
  it('limits legacy draft reads to the current editor and caps the result', async () => {
    const prisma = {
      news: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const controller = new NewsController(
      prisma as never,
      {} as never,
      {} as never,
    );

    await controller.drafts({ id: 'editor-1' } as never);

    expect(prisma.news.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: ContentStatus.DRAFT,
          authorId: 'editor-1',
          deletedAt: null,
        },
        take: 100,
      }),
    );
  });

  it('returns a bounded summary page without selecting the body', async () => {
    const prisma = {
      news: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(25),
      },
    };
    const controller = new NewsController(
      prisma as never,
      {} as never,
      {} as never,
    );

    await expect(
      controller.list({ page: 2, pageSize: 10, includeBody: false }),
    ).resolves.toEqual({ items: [], total: 25, page: 2, pageSize: 10 });
    expect(prisma.news.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
        select: expect.not.objectContaining({ body: true }),
      }),
    );
  });

  it('scopes the management list to the editor but lets an admin list all', async () => {
    const prisma = {
      news: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const controller = new NewsController(
      prisma as never,
      {} as never,
      {} as never,
    );

    await controller.manage(
      { page: 1, pageSize: 20, status: ContentStatus.PUBLISHED },
      { id: 'editor-1', role: Role.EDITOR } as never,
    );
    await controller.manage(
      { page: 1, pageSize: 20 },
      { id: 'admin-1', role: Role.ADMIN } as never,
    );

    expect(prisma.news.findMany.mock.calls[0]![0].where).toEqual({
      deletedAt: null,
      authorId: 'editor-1',
      status: ContentStatus.PUBLISHED,
    });
    expect(prisma.news.findMany.mock.calls[1]![0].where).toEqual({
      deletedAt: null,
    });
  });
});

describe('NewsController writes', () => {
  it("prevents an editor from updating another editor's published news", async () => {
    const prisma = {
      news: {
        findFirstOrThrow: jest.fn().mockResolvedValue(
          owner({
            authorId: 'editor-2',
            status: ContentStatus.PUBLISHED,
            publishedAt: timestamp,
          }),
        ),
      },
    };
    const controller = new NewsController(
      prisma as never,
      {} as never,
      {} as never,
    );

    await expect(
      controller.update(
        'news-1',
        writeDto({ status: ContentStatus.PUBLISHED }),
        { id: 'editor-1', role: Role.EDITOR } as never,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lets an admin preserve images already linked to another author\'s news', async () => {
    const transaction = {
      photo: { findMany: jest.fn().mockResolvedValue([{ id: 'photo-1' }]) },
      news: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'news-1' }),
      },
      newsPhoto: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      news: {
        findFirstOrThrow: jest.fn().mockResolvedValue(
          owner({
            authorId: 'editor-2',
            status: ContentStatus.PUBLISHED,
            publishedAt: timestamp,
          }),
        ),
      },
      $transaction: jest.fn((callback) => callback(transaction)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new NewsController(
      prisma as never,
      {} as never,
      audit as never,
    );

    await controller.update(
      'news-1',
      writeDto({
        status: ContentStatus.PUBLISHED,
        expectedUpdatedAt: timestamp.toISOString(),
        body: '<p>正文</p><img src="/api/v1/media/images/photo-1/content" data-photo-id="photo-1">',
      }),
      { id: 'admin-1', role: Role.ADMIN } as never,
    );

    expect(transaction.photo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ news: { some: { newsId: 'news-1' } } }]),
        }),
      }),
    );
    expect(transaction.news.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAt: timestamp }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'admin-1',
      'news.update',
      'News',
      'news-1',
      expect.any(Object),
      transaction,
    );
  });

  it('returns a conflict without changing photo links when the version is stale', async () => {
    const transaction = {
      photo: { findMany: jest.fn() },
      news: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      newsPhoto: { deleteMany: jest.fn(), createMany: jest.fn() },
    };
    const prisma = {
      news: { findFirstOrThrow: jest.fn().mockResolvedValue(owner()) },
      $transaction: jest.fn((callback) => callback(transaction)),
    };
    const audit = { record: jest.fn() };
    const controller = new NewsController(
      prisma as never,
      {} as never,
      audit as never,
    );

    await expect(
      controller.update(
        'news-1',
        writeDto({ expectedUpdatedAt: timestamp.toISOString() }),
        { id: 'editor-1', role: Role.EDITOR } as never,
      ),
    ).rejects.toThrow(ConflictException);
    expect(transaction.newsPhoto.deleteMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('creates the news, image links, and audit entry in one transaction', async () => {
    const created = {
      id: 'news-1',
      status: ContentStatus.PUBLISHED,
      visibility: Visibility.PUBLIC,
    };
    const transaction = {
      photo: { findMany: jest.fn().mockResolvedValue([{ id: 'photo-1' }]) },
      news: { create: jest.fn().mockResolvedValue(created) },
      newsPhoto: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(transaction)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new NewsController(
      prisma as never,
      {} as never,
      audit as never,
    );

    await controller.create(
      writeDto({
        status: ContentStatus.PUBLISHED,
        visibility: Visibility.PUBLIC,
        body: '<img src="/api/v1/media/images/photo-1/content" data-photo-id="photo-1">',
      }),
      { id: 'editor-1', role: Role.EDITOR } as never,
    );

    expect(audit.record).toHaveBeenCalledWith(
      'editor-1',
      'news.create',
      'News',
      'news-1',
      { status: ContentStatus.PUBLISHED, visibility: Visibility.PUBLIC },
      transaction,
    );
  });

  it('archives an owned news item and records the transition atomically', async () => {
    const transaction = {
      news: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'news-1',
          status: ContentStatus.ARCHIVED,
        }),
      },
    };
    const prisma = {
      news: {
        findFirstOrThrow: jest.fn().mockResolvedValue(
          owner({ status: ContentStatus.PUBLISHED, publishedAt: timestamp }),
        ),
      },
      $transaction: jest.fn((callback) => callback(transaction)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new NewsController(
      prisma as never,
      {} as never,
      audit as never,
    );

    await controller.archive(
      'news-1',
      { expectedUpdatedAt: timestamp.toISOString() },
      { id: 'editor-1', role: Role.EDITOR } as never,
    );

    expect(transaction.news.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: ContentStatus.ARCHIVED, publishedAt: null },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'editor-1',
      'news.archive',
      'News',
      'news-1',
      expect.any(Object),
      transaction,
    );
  });

  it('soft-deletes an owned news item and releases its photo links', async () => {
    const transaction = {
      news: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      newsPhoto: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const prisma = {
      news: { findFirstOrThrow: jest.fn().mockResolvedValue(owner()) },
      $transaction: jest.fn((callback) => callback(transaction)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new NewsController(
      prisma as never,
      {} as never,
      audit as never,
    );

    await expect(
      controller.remove('news-1', {
        id: 'editor-1',
        role: Role.EDITOR,
      } as never),
    ).resolves.toEqual({ id: 'news-1', deleted: true });
    expect(transaction.newsPhoto.deleteMany).toHaveBeenCalledWith({
      where: { newsId: 'news-1' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      'editor-1',
      'news.delete',
      'News',
      'news-1',
      { previousStatus: ContentStatus.DRAFT },
      transaction,
    );
  });
});

describe('NewsController image upload', () => {
  it('commits the image metadata and upload audit through one media transaction', async () => {
    const transaction = { auditLog: {} };
    const media = {
      createImage: jest.fn(
        async (_file, _userId, _dto, afterCreate) => {
          await afterCreate(transaction, { id: 'photo-1' });
          return { id: 'photo-1' };
        },
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new NewsController(
      {} as never,
      media as never,
      audit as never,
    );
    const buffer = Buffer.from('image');
    const file = {
      buffer,
      mimetype: 'image/webp',
      originalname: 'news.webp',
      size: buffer.length,
    } as Express.Multer.File;

    await controller.uploadImage(
      file,
      { albumId: 'album-1', caption: '图注' },
      { id: 'editor-1' } as never,
    );

    expect(media.createImage).toHaveBeenCalledWith(
      file,
      'editor-1',
      { albumId: 'album-1', caption: '图注' },
      expect.any(Function),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'editor-1',
      'news.image.upload',
      'Photo',
      'photo-1',
      { albumId: 'album-1' },
      transaction,
    );
  });
});
