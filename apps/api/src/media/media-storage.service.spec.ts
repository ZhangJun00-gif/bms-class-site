import { ServiceUnavailableException } from '@nestjs/common';
import { MediaStorageService } from './media-storage.service';

const MEDIA_ENV_NAMES = [
  'NODE_ENV',
  'MEDIA_STORAGE_PROVIDER',
  'MEDIA_COS_BUCKET',
  'MEDIA_COS_REGION',
  'MEDIA_COS_ENDPOINT',
  'MEDIA_COS_PUBLIC_ENDPOINT',
  'MEDIA_COS_SECRET_ID',
  'MEDIA_COS_SECRET_KEY',
  'MEDIA_COS_SECURITY_TOKEN',
  'MEDIA_SIGNED_URL_TTL_SECONDS',
  'MEDIA_MAX_PROCESSING_CONCURRENCY',
] as const;

function configureCos() {
  process.env.NODE_ENV = 'test';
  process.env.MEDIA_STORAGE_PROVIDER = 'cos';
  process.env.MEDIA_COS_BUCKET = 'private-media-1000000000';
  process.env.MEDIA_COS_REGION = 'ap-test';
  process.env.MEDIA_COS_ENDPOINT =
    'https://private-media-1000000000.cos-internal.ap-test.myqcloud.com';
  process.env.MEDIA_COS_PUBLIC_ENDPOINT = 'https://media.example.test';
  process.env.MEDIA_COS_SECRET_ID = 'test-secret-id';
  process.env.MEDIA_COS_SECRET_KEY = 'test-secret-key';
  process.env.MEDIA_SIGNED_URL_TTL_SECONDS = '300';
  process.env.MEDIA_MAX_PROCESSING_CONCURRENCY = '2';
}

function cosClient() {
  return {
    getBucket: jest.fn((_params, callback) =>
      callback(null, {
        Contents: [],
        IsTruncated: 'false',
      }),
    ),
    putObject: jest.fn((_params, callback) => callback(null)),
    getObjectUrl: jest.fn((_params, callback) => {
      callback(null, { Url: 'https://media.example.test/signed' });
      return '';
    }),
    deleteObject: jest.fn((_params, callback) => callback(null)),
  };
}

describe('MediaStorageService', () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const name of MEDIA_ENV_NAMES) originalEnv.set(name, process.env[name]);
  });

  beforeEach(() => {
    for (const name of MEDIA_ENV_NAMES) delete process.env[name];
  });

  afterAll(() => {
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('rejects incomplete COS configuration at startup', () => {
    process.env.NODE_ENV = 'test';
    process.env.MEDIA_STORAGE_PROVIDER = 'cos';

    expect(() => new MediaStorageService()).toThrow(
      'COS 图片存储配置不完整',
    );
  });

  it('rejects database media storage in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.MEDIA_STORAGE_PROVIDER = 'database';
    const service = new MediaStorageService();

    expect(() => service.onModuleInit()).toThrow(
      '生产环境必须设置 MEDIA_STORAGE_PROVIDER=cos',
    );
  });

  it('uploads a private WebP object with cache bounded by the signed URL TTL', async () => {
    configureCos();
    const client = cosClient();
    const service = new MediaStorageService(client as never);
    service.onModuleInit();

    await service.upload(
      Buffer.from([1, 2, 3]),
      'media/2026/07/photo.webp',
      'image/webp',
    );

    expect(client.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: 'media/2026/07/photo.webp',
        ContentType: 'image/webp',
        ContentLength: 3,
        CacheControl: 'private, max-age=300',
        ACL: 'private',
      }),
      expect.any(Function),
    );
  });

  it('maps COS upload failures to a retryable API error', async () => {
    configureCos();
    const client = cosClient();
    client.putObject.mockImplementation((_params, callback) =>
      callback({ code: 'AccessDenied', message: 'raw detail' }),
    );
    const service = new MediaStorageService(client as never);

    await expect(
      service.upload(Buffer.from([1]), 'media/photo.webp', 'image/webp'),
    ).rejects.toEqual(
      expect.objectContaining({
        message: '图片存储服务暂时不可用，请稍后重试',
      }),
    );
  });

  it('generates a 300-second signed URL on the public endpoint', async () => {
    configureCos();
    const client = cosClient();
    const service = new MediaStorageService(client as never);

    await expect(
      service.signedReadUrl('media/2026/07/photo.webp'),
    ).resolves.toBe('https://media.example.test/signed');
    expect(client.getObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: 'media/2026/07/photo.webp',
        Sign: true,
        Expires: 300,
        Domain: 'media.example.test',
        Protocol: 'https:',
      }),
      expect.any(Function),
    );
  });

  it('maps signed URL failures without exposing SDK details', async () => {
    configureCos();
    const client = cosClient();
    client.getObjectUrl.mockImplementation((_params, callback) => {
      callback({ code: 'NoSuchKey', message: 'raw object detail' });
      return '';
    });
    const service = new MediaStorageService(client as never);

    await expect(
      service.signedReadUrl('media/2026/07/missing.webp'),
    ).rejects.toEqual(
      expect.objectContaining({
        message: '图片存储服务暂时不可用，请稍后重试',
      }),
    );
  });

  it('deletes an object and maps delete failures', async () => {
    configureCos();
    const client = cosClient();
    const service = new MediaStorageService(client as never);

    await service.delete('media/2026/07/photo.webp');
    expect(client.deleteObject).toHaveBeenCalledWith(
      expect.objectContaining({ Key: 'media/2026/07/photo.webp' }),
      expect.any(Function),
    );

    client.deleteObject.mockImplementation((_params, callback) =>
      callback({ code: 'InternalError' }),
    );
    await expect(
      service.delete('media/2026/07/photo.webp'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lists the complete media prefix for read-only orphan auditing', async () => {
    configureCos();
    const client = cosClient();
    client.getBucket
      .mockImplementationOnce((_params, callback) =>
        callback(null, {
          Contents: [
            {
              Key: 'media/2026/07/first.webp',
              Size: '3',
              LastModified: '2026-07-21T00:00:00Z',
            },
          ],
          IsTruncated: 'true',
          NextMarker: 'media/2026/07/first.webp',
        }),
      )
      .mockImplementationOnce((_params, callback) =>
        callback(null, {
          Contents: [
            {
              Key: 'media/2026/07/second.webp',
              Size: '4',
              LastModified: '2026-07-21T00:01:00Z',
            },
          ],
          IsTruncated: 'false',
        }),
      );
    const service = new MediaStorageService(client as never);

    await expect(service.listObjects()).resolves.toEqual([
      expect.objectContaining({
        key: 'media/2026/07/first.webp',
        size: 3,
      }),
      expect.objectContaining({
        key: 'media/2026/07/second.webp',
        size: 4,
      }),
    ]);
    expect(client.getBucket).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        Marker: 'media/2026/07/first.webp',
      }),
      expect.any(Function),
    );
  });

  it('bounds original reads with a range and preserves non-text bytes', async () => {
    configureCos();
    const bytes = Buffer.from([0, 255, 128, 10]);
    const getObject = jest.fn((_params, callback) => callback(null, { Body: bytes }));
    const service = new MediaStorageService({ ...cosClient(), getObject } as never);
    await expect(service.readBounded('album-originals/2026/09/test.png', 4)).resolves.toEqual(bytes);
    expect(getObject).toHaveBeenCalledWith(expect.objectContaining({ Range: 'bytes=0-4' }), expect.any(Function));
    getObject.mockImplementation((_params, callback) => callback(null, { Body: Buffer.alloc(5) }));
    await expect(service.readBounded('album-originals/2026/09/test.png', 4)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
