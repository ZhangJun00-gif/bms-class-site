import { BadRequestException, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CreditHoursModule } from '../credit-hours/credit-hours.module';
import { CreditHoursService } from '../credit-hours/credit-hours.service';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { compressImage } from './image-processing';
import { ImageProcessingService } from './image-processing.service';
import { MediaModule } from './media.module';
import { MediaService } from './media.service';
import { MediaStorageService } from './media-storage.service';

jest.mock('./image-processing', () => ({
  compressImage: jest.fn(),
  MAX_INPUT_PIXELS: 32_000_000,
}));
jest.mock('@bmc3/media-core', () => ({
  ...jest.requireActual('@bmc3/media-core'),
  inspectImage: jest.fn().mockResolvedValue({ format: 'png', width: 10, height: 8 }),
}));

const compressed = {
  data: Buffer.from('display'),
  mimeType: 'image/webp' as const,
  size: 7,
  width: 10,
  height: 8,
};
const mockedCompress = jest.mocked(compressImage);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('shared API image processing budget', () => {
  const originalConcurrency = process.env.MEDIA_MAX_PROCESSING_CONCURRENCY;

  beforeEach(() => {
    mockedCompress.mockReset().mockResolvedValue(compressed);
  });

  afterEach(() => {
    if (originalConcurrency === undefined) {
      delete process.env.MEDIA_MAX_PROCESSING_CONCURRENCY;
    } else {
      process.env.MEDIA_MAX_PROCESSING_CONCURRENCY = originalConcurrency;
    }
  });

  it.each([1, 2])('enforces the configured %i processing slots and releases them', async (limit) => {
    process.env.MEDIA_MAX_PROCESSING_CONCURRENCY = String(limit);
    const held = deferred<typeof compressed>();
    mockedCompress.mockReturnValue(held.promise);
    const processor = new ImageProcessingService();
    const running = Array.from({ length: limit }, () => processor.compress(Buffer.from('input')));
    await expect(processor.compress(Buffer.from('excess'))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mockedCompress).toHaveBeenCalledTimes(limit);
    held.resolve(compressed);
    await Promise.all(running);
    await expect(processor.compress(Buffer.from('next'))).resolves.toEqual(compressed);
  });

  it('releases the processing slot after a decoding failure without leaking error details', async () => {
    process.env.MEDIA_MAX_PROCESSING_CONCURRENCY = '1';
    const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      mockedCompress.mockRejectedValueOnce(new Error('pixel limit: private-file-name.png'));
      const processor = new ImageProcessingService();
      await expect(processor.compress(Buffer.from('invalid'))).rejects.toBeInstanceOf(BadRequestException);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pixel-limit'));
      expect(log.mock.calls[0]?.[0]).not.toContain('private-file-name');
      await expect(processor.compress(Buffer.from('next'))).resolves.toEqual(compressed);
    } finally {
      log.mockRestore();
    }
  });

  it('shares the MediaModule singleton across media and credit-hour requests', async () => {
    process.env.MEDIA_MAX_PROCESSING_CONCURRENCY = '1';
    const transactionFailure = new Error('fixture transaction failure');
    const prisma = {
      photo: { create: jest.fn().mockResolvedValue({ id: 'photo-fixture' }) },
      creditHourSubmission: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockRejectedValue(transactionFailure),
    };
    @Module({})
    class TestDependenciesModule {}
    const testing = await Test.createTestingModule({
      imports: [
        {
          module: TestDependenciesModule,
          global: true,
          providers: [
            { provide: PrismaService, useValue: prisma },
            { provide: AuditService, useValue: { record: jest.fn() } },
          ],
          exports: [PrismaService, AuditService],
        },
        MediaModule,
        CreditHoursModule,
      ],
    })
      .overrideProvider(MediaStorageService)
      .useValue({ usesCos: () => false })
      .compile();
    try {
      const media = testing.get(MediaService);
      const credits = testing.get(CreditHoursService);
      const file = {
        buffer: Buffer.from('original'),
        mimetype: 'image/png',
      } as Express.Multer.File;
      const submit = () => credits.createSubmission(
        { id: 'user-fixture' } as never,
        'key-fixture',
        { type: 'QUALITY', activityName: 'Fixture', hours: 1, sourceDescription: 'Fixture' },
        [file],
      );

      const mediaHeld = deferred<typeof compressed>();
      mockedCompress.mockReturnValueOnce(mediaHeld.promise);
      const mediaRequest = media.createImage(file, 'user-fixture');
      await expect(submit()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockedCompress).toHaveBeenCalledTimes(1);
      mediaHeld.resolve(compressed);
      await mediaRequest;

      const creditsHeld = deferred<typeof compressed>();
      const creditsEntered = deferred<void>();
      mockedCompress.mockImplementationOnce(() => {
        creditsEntered.resolve();
        return creditsHeld.promise;
      });
      const creditRequest = expect(submit()).rejects.toBe(transactionFailure);
      await creditsEntered.promise;
      await expect(media.createImage(file, 'user-fixture')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockedCompress).toHaveBeenCalledTimes(2);
      creditsHeld.resolve(compressed);
      await creditRequest;
      await expect(media.createImage(file, 'user-fixture')).resolves.toMatchObject({ id: 'photo-fixture' });
    } finally {
      await testing.close();
    }
  });
});
