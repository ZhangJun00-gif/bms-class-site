import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { REQUIRED_ROLES } from '../common/auth';
import { AlbumsController } from './albums.controller';

function uploadFile() {
  const buffer = Buffer.from('image');
  return {
    buffer,
    mimetype: 'image/png',
    originalname: 'album.png',
    size: buffer.length,
  } as Express.Multer.File;
}

describe('AlbumsController image upload', () => {
  it('uses the shared media service and preserves the album association', async () => {
    const prisma = {
      album: {
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'album-1' }),
      },
    };
    const media = {
      createAlbumImage: jest.fn(
        async (
          _file: Express.Multer.File,
          _userId: string,
          _options: unknown,
          _idempotencyKey: string,
          hook: (transaction: unknown, photo: { id: string }) => Promise<void>,
        ) => {
          const transaction = { album: { count: jest.fn().mockResolvedValue(1) } };
          await hook(transaction, { id: 'photo-1' });
          return { id: 'photo-1' };
        },
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AlbumsController(
      prisma as never,
      media as never,
      audit as never, {} as never);
    const file = uploadFile();

    await controller.upload(
      'album-1',
      file,
      '班级活动',
      { id: 'editor-1' } as never,
      'upload-key',
    );

    expect(media.createAlbumImage).toHaveBeenCalledWith(
      file,
      'editor-1',
      { albumId: 'album-1', caption: '班级活动' },
      'upload-key',
      expect.any(Function),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'editor-1',
      'photo.upload',
      'Photo',
      'photo-1',
      { albumId: 'album-1' },
      expect.any(Object),
    );
  });

  it('allows editors and administrators to manage albums', () => {
    const reflector = new Reflector();

    expect(
      reflector.get(REQUIRED_ROLES, AlbumsController.prototype.create),
    ).toEqual([Role.EDITOR, Role.ADMIN]);
    expect(
      reflector.get(REQUIRED_ROLES, AlbumsController.prototype.upload),
    ).toEqual([Role.EDITOR, Role.ADMIN]);
    expect(
      reflector.get(REQUIRED_ROLES, AlbumsController.prototype.removePhoto),
    ).toEqual([Role.EDITOR, Role.ADMIN]);
    expect(
      reflector.get(REQUIRED_ROLES, AlbumsController.prototype.rename),
    ).toEqual([Role.EDITOR, Role.ADMIN]);
    expect(
      reflector.get(REQUIRED_ROLES, AlbumsController.prototype.archive),
    ).toEqual([Role.EDITOR, Role.ADMIN]);
    expect(
      reflector.get(REQUIRED_ROLES, AlbumsController.prototype.restore),
    ).toEqual([Role.EDITOR, Role.ADMIN]);
  });

  it('removes a photo through the media service and records the outcome', async () => {
    const media = {
      removeFromAlbum: jest.fn(
        async (
          _albumId: string,
          _photoId: string,
          hook: (transaction: unknown, result: { photoDeleted: boolean; objectKey: string }) => Promise<void>,
        ) => {
          await hook(
            { auditLog: {} },
            { photoDeleted: true, objectKey: 'media/photo.webp' },
          );
          return {
            id: 'photo-1',
            removed: true,
            photoDeleted: true,
            objectDeleted: true,
          };
        },
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AlbumsController(
      {} as never,
      media as never,
      audit as never, {} as never);

    await expect(
      controller.removePhoto('album-1', 'photo-1', {
        id: 'admin-1',
      } as never),
    ).resolves.toEqual(expect.objectContaining({ removed: true }));
    expect(media.removeFromAlbum).toHaveBeenCalledWith(
      'album-1',
      'photo-1',
      expect.any(Function),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'admin-1',
      'album.photo.remove',
      'Photo',
      'photo-1',
      {
        albumId: 'album-1',
        photoDeleted: true,
        objectCleanupRequired: true,
      },
      expect.any(Object),
    );
  });
});

describe('AlbumsController list payloads', () => {
  const photoRow = {
    id: 'photo-1',
    albumId: 'album-1',
    caption: '',
    mimeType: 'image/webp',
    size: 100,
    width: 800,
    height: 600,
    sortOrder: 0,
    createdAt: new Date(),
  };
  const media = {
    serializePhoto: <T extends { id: string }>(photo: T) => ({
      ...photo,
      url: `/api/v1/media/images/${photo.id}/content`,
    }),
  };

  function albumRow(photos: unknown[]) {
    return {
      id: 'album-1',
      title: '春游',
      description: '',
      createdAt: new Date(),
      updatedAt: new Date(),
      photos,
      _count: { photos: 3 },
    };
  }

  it('returns cover-only summaries by default', async () => {
    const prisma = {
      album: {
        findMany: jest.fn().mockResolvedValue([albumRow([photoRow])]),
      },
    };
    const controller = new AlbumsController(
      prisma as never,
      media as never,
      {} as never, {} as never);

    const result = await controller.list();
    const item = result.items[0] as Record<string, unknown>;
    expect(item.coverUrl).toBe('/api/v1/media/images/photo-1/content');
    expect(item.photoCount).toBe(3);
    expect('photos' in item).toBe(false);
    expect(prisma.album.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          photos: expect.objectContaining({ take: 1 }),
        }),
      }),
    );
  });

  it('returns serialized photos when includePhotos=true', async () => {
    const prisma = {
      album: {
        findMany: jest.fn().mockResolvedValue([albumRow([photoRow])]),
      },
    };
    const controller = new AlbumsController(
      prisma as never,
      media as never,
      {} as never, {} as never);

    const result = await controller.list('true');
    const item = result.items[0] as Record<string, unknown>;
    const photos = item.photos as Array<{ url: string }>;
    expect(photos).toHaveLength(1);
    expect(photos[0]!.url).toBe('/api/v1/media/images/photo-1/content');
    expect(prisma.album.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          photos: expect.not.objectContaining({ take: 1 }),
        }),
      }),
    );
  });

  it('returns the full album with photos from the detail endpoint', async () => {
    const prisma = {
      album: {
        findFirstOrThrow: jest.fn().mockResolvedValue(albumRow([photoRow])),
      },
    };
    const controller = new AlbumsController(
      prisma as never,
      media as never,
      {} as never, {} as never);

    const detail = (await controller.get('album-1')) as Record<string, unknown>;
    expect(detail.photoCount).toBe(3);
    const photos = detail.photos as Array<{ url: string }>;
    expect(photos[0]!.url).toBe('/api/v1/media/images/photo-1/content');
  });

  it('does not expose archived albums to ordinary members', async () => {
    const controller = new AlbumsController({} as never, media as never, {} as never, {} as never);

    await expect(
      controller.list(undefined, 'true', {
        id: 'member-1',
        role: Role.MEMBER,
      } as never),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns a bounded cursor page for lazy photo loading', async () => {
    const second = {
      ...photoRow,
      id: 'photo-2',
      sortOrder: 1,
      createdAt: new Date(photoRow.createdAt.getTime() + 1_000),
    };
    const prisma = {
      album: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'album-1',
          _count: { photos: 3 },
        }),
      },
      photo: { findMany: jest.fn().mockResolvedValue([photoRow, second]) },
    };
    const controller = new AlbumsController(
      prisma as never,
      media as never,
      {} as never, {} as never);

    const result = await controller.photos(
      'album-1',
      { pageSize: 1 },
      { id: 'member-1', role: Role.MEMBER } as never,
    );

    expect(result.items).toHaveLength(1);
    expect(result.photoCount).toBe(3);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(prisma.photo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { albumId: 'album-1' },
        take: 2,
        orderBy: [
          { sortOrder: 'asc' },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
      }),
    );
  });
});

describe('AlbumsController archive lifecycle', () => {
  it('rejects a whitespace-only title when creating an album', async () => {
    const prisma = { $transaction: jest.fn() };
    const controller = new AlbumsController(
      prisma as never,
      {} as never,
      {} as never, {} as never);

    await expect(
      controller.create(
        { title: '   ', description: '' },
        { id: 'editor-1', role: Role.EDITOR } as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only title before starting a transaction', async () => {
    const prisma = { $transaction: jest.fn() };
    const controller = new AlbumsController(
      prisma as never,
      {} as never,
      {} as never, {} as never);

    await expect(
      controller.rename(
        'album-1',
        { title: '   ' },
        { id: 'editor-1', role: Role.EDITOR } as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('renames and archives albums without changing photo relations', async () => {
    const existing = {
      id: 'album-1',
      title: '旧标题',
      description: '',
      authorId: 'editor-1',
      archivedAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const transaction = {
      album: {
        findFirstOrThrow: jest.fn().mockResolvedValue(existing),
        update: jest
          .fn()
          .mockResolvedValue({ ...existing, title: '新标题' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          ...existing,
          title: '新标题',
          archivedAt: new Date(),
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (action) => action(transaction)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new AlbumsController(
      prisma as never,
      {} as never,
      audit as never, {} as never);
    const actor = { id: 'editor-1', role: Role.EDITOR } as never;

    await controller.rename('album-1', { title: '新标题' }, actor);
    await controller.archive('album-1', actor);

    expect(transaction.album.update).toHaveBeenCalledWith({
      where: { id: 'album-1' },
      data: { title: '新标题' },
    });
    expect(transaction.album.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'album-1', deletedAt: null, archivedAt: null },
        data: { archivedAt: expect.any(Date) },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'editor-1',
      'album.archive',
      'Album',
      'album-1',
      undefined,
      transaction,
    );
    expect(transaction).not.toHaveProperty('photo');
  });
});
