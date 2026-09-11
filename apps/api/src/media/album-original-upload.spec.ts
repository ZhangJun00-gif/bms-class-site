import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { MediaService } from './media.service';
import { ImageProcessingService } from './image-processing.service';

async function fixture(cos = false) {
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#8ab03c' } }).png().toBuffer();
  const file = { buffer: bytes, mimetype: 'image/png', size: bytes.length } as Express.Multer.File;
  const order: string[] = [];
  const lease = { id: 'operation-1', token: 'token-1', photoId: 'photo-1' };
  const recovery = {
    existingUpload: jest.fn().mockResolvedValue(null),
    beginUpload: jest.fn(async () => { order.push('manifest'); return lease; }),
    renew: jest.fn(), commit: jest.fn(), compensate: jest.fn(),
  };
  const storage = {
    usesCos: jest.fn(() => cos),
    upload: jest.fn(async (_data: Buffer, key: string) => { order.push(key); }),
  };
  const transaction = {
    $queryRaw: jest.fn(),
    album: { findFirst: jest.fn().mockResolvedValue({ id: 'album-1' }) },
    photo: { create: jest.fn(async ({ data }) => ({
      id: data.id, caption: data.caption, original: { photoId: data.id },
      mimeType: data.mimeType, albumId: data.albumId,
    })) },
  };
  const prisma = {
    album: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'album-1' }) },
    photo: { findFirst: jest.fn() },
    $transaction: jest.fn(async (action) => action(transaction)),
  };
  const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);
  return { bytes, file, order, recovery, storage, transaction, prisma, service, lease };
}

describe('album exact-original uploads', () => {
  it('retains exact uploaded bytes and hash alongside a separate WebP in database mode', async () => {
    const f = await fixture();
    const result = await f.service.createAlbumImage(f.file, 'editor-1', { albumId: 'album-1', caption: '活动' }, 'key');
    const data = f.transaction.photo.create.mock.calls[0]![0].data;
    expect(Buffer.from(data.original.create.data)).toEqual(f.bytes);
    expect(data.original.create.sha256).toBe(createHash('sha256').update(f.bytes).digest('hex'));
    expect(data.original.create.mimeType).toBe('image/png');
    expect((await sharp(Buffer.from(data.data)).metadata()).format).toBe('webp');
    expect(data.original.create.objectKey).toBeNull();
    expect(f.storage.upload).not.toHaveBeenCalled();
    expect(result.originalAvailable).toBe(true);
    expect(result).not.toHaveProperty('original');
    expect(f.recovery.commit).toHaveBeenCalledWith(f.transaction, f.lease);
  });

  it('persists both exact keys before COS writes and stores no BLOBs in COS mode', async () => {
    const f = await fixture(true);
    await f.service.createAlbumImage(f.file, 'editor-1', { albumId: 'album-1' }, 'key');
    const manifest = (f.recovery.beginUpload.mock.calls[0] as unknown as [ { keys: string[] } ])[0];
    expect(f.order[0]).toBe('manifest');
    expect(manifest.keys).toHaveLength(2);
    expect(new Set(f.order.slice(1))).toEqual(new Set(manifest.keys));
    expect(f.storage.upload.mock.calls[0]![0]).toEqual(f.bytes);
    expect(f.storage.upload.mock.calls[0]![1]).toMatch(/^album-originals\/.*\.png$/);
    const data = f.transaction.photo.create.mock.calls[0]![0].data;
    expect(data.data).toBeNull();
    expect(data.original.create.data).toBeNull();
  });

  it('compensates the persisted operation when the second object upload fails', async () => {
    const f = await fixture(true);
    f.storage.upload.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('object write failed'));
    await expect(f.service.createAlbumImage(f.file, 'editor-1', { albumId: 'album-1' }, 'key')).rejects.toThrow('object write failed');
    expect(f.recovery.beginUpload).toHaveBeenCalledTimes(1);
    expect(f.storage.upload).toHaveBeenCalledTimes(2);
    expect(f.recovery.compensate).toHaveBeenCalledWith(f.lease);
    expect(f.transaction.photo.create).not.toHaveBeenCalled();
  });

  it('rejects an album archived during upload and retains the operation for compensation', async () => {
    const f = await fixture(true);
    f.transaction.album.findFirst.mockResolvedValue(null);
    await expect(f.service.createAlbumImage(f.file, 'editor-1', { albumId: 'album-1' }, 'key')).rejects.toThrow('相册已归档或删除');
    expect(f.transaction.photo.create).not.toHaveBeenCalled();
    expect(f.recovery.compensate).toHaveBeenCalledWith(f.lease);
  });

  it('replays a committed operation without compressing or uploading again', async () => {
    const f = await fixture(true);
    f.recovery.existingUpload.mockResolvedValue({ status: 'COMMITTED', photoId: 'photo-1' });
    f.prisma.photo.findFirst.mockResolvedValue({ id: 'photo-1', original: { photoId: 'photo-1' } });
    expect((await f.service.createAlbumImage(f.file, 'editor-1', { albumId: 'album-1' }, 'key')).id).toBe('photo-1');
    expect(f.storage.upload).not.toHaveBeenCalled();
    expect(f.recovery.beginUpload).not.toHaveBeenCalled();
  });
});
