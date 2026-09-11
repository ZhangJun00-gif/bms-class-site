import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import sharp from 'sharp';
import { MAX_INPUT_PIXELS } from '../src/media/image-processing';
import { MediaService } from '../src/media/media.service';
import { ImageProcessingService } from '../src/media/image-processing.service';
import { MediaObjectRecoveryService } from '../src/media/media-object-recovery.service';

const width = 8_000;
const boundaryHeight = MAX_INPUT_PIXELS / width;
const memoryLimitBytes = Number(
  process.env.BMC3_API_MEMORY_LIMIT_BYTES ?? 768 * 1024 * 1024,
);
const minimumHeadroomBytes = 128 * 1024 * 1024;

if (!Number.isInteger(boundaryHeight)) {
  throw new Error('The configured image pixel limit cannot form the test image');
}
if (!Number.isFinite(memoryLimitBytes) || memoryLimitBytes <= 0) {
  throw new Error('BMC3_API_MEMORY_LIMIT_BYTES must be a positive number');
}

process.env.MEDIA_MAX_PROCESSING_CONCURRENCY = '2';

let nextPhoto = 0;
const prisma = {
  photo: {
    create: async ({ data }: { data: Record<string, unknown> }) => ({
      id: `memory-probe-${++nextPhoto}`,
      albumId: null,
      caption: '',
      mimeType: data.mimeType,
      size: data.size,
      width: data.width,
      height: data.height,
      sortOrder: 0,
      createdAt: new Date(),
    }),
  },
};
const storage = {
  usesCos: () => false,
};

async function createBoundaryRaster() {
  return sharp({
    create: {
      width,
      height: boundaryHeight,
      channels: 3,
      background: { r: 42, g: 108, b: 126 },
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function uploadFile(buffer: Buffer): Express.Multer.File {
  return {
    buffer,
    size: buffer.length,
    mimetype: 'image/png',
    originalname: 'memory-boundary.png',
  } as Express.Multer.File;
}

async function run() {
  let peakRssBytes = process.memoryUsage().rss;
  const sample = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  const sampler = setInterval(sample, 5);

  try {
    const input = await createBoundaryRaster();
    sample();
    const service = new MediaService(
      prisma as never,
      storage as never,
      new ImageProcessingService(),
      new MediaObjectRecoveryService(prisma as never, storage as never),
    );
    const first = service.createImage(uploadFile(input), 'memory-probe');
    const second = service.createImage(uploadFile(input), 'memory-probe');

    let thirdStatus: number | undefined;
    try {
      await service.createImage(uploadFile(input), 'memory-probe');
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      thirdStatus = error.getStatus();
    }
    if (thirdStatus !== 503) {
      throw new Error('The third concurrent image did not receive retryable 503');
    }

    await Promise.all([first, second]);
    sample();

    const aboveLimitPng = await sharp({ create: {
      width, height: boundaryHeight + 1, channels: 3,
      background: { r: 42, g: 108, b: 126 },
    } }).png().toBuffer();
    let aboveLimitStatus: number | undefined;
    try {
      await service.createImage(uploadFile(aboveLimitPng), 'memory-probe');
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      aboveLimitStatus = error.getStatus();
    }
    if (aboveLimitStatus !== 400) {
      throw new Error('The image above 32 megapixels did not receive 400');
    }

    const headroomBytes = memoryLimitBytes - peakRssBytes;
    const result = {
      environment: `${process.platform}/${process.arch}; isolated synthetic process, not a container capacity test`,
      maxInputPixels: MAX_INPUT_PIXELS,
      boundaryDimensions: { width, height: boundaryHeight },
      processingConcurrency: 2,
      thirdConcurrentStatus: thirdStatus,
      aboveLimitStatus,
      memoryLimitBytes,
      peakRssBytes,
      headroomBytes,
      minimumHeadroomBytes,
    };
    console.log(JSON.stringify(result));
    if (headroomBytes < minimumHeadroomBytes) {
      throw new Error(
        'Two-way image processing leaves less than 128 MiB API headroom; deploy with MEDIA_MAX_PROCESSING_CONCURRENCY=1',
      );
    }
  } finally {
    clearInterval(sampler);
  }
}

void run().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Image memory validation failed',
  );
  process.exitCode = 1;
});
