import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { compressImage, MAX_INPUT_PIXELS } from './image-processing';

@Injectable()
export class ImageProcessingService {
  private readonly logger = new Logger(ImageProcessingService.name);
  private readonly maxConcurrency = Number(
    process.env.MEDIA_MAX_PROCESSING_CONCURRENCY ?? '2',
  );
  private activeProcessing = 0;

  async compress(buffer: Buffer) {
    if (this.activeProcessing >= this.maxConcurrency) {
      throw new ServiceUnavailableException('图片处理繁忙，请稍后重试');
    }
    this.activeProcessing += 1;
    try {
      return await compressImage(buffer);
    } catch (error) {
      const failure = classifyImageProcessingError(error);
      this.logger.warn(JSON.stringify({
        event: 'media.image-processing-failed',
        category: failure.category,
        message: failure.message,
      }));
      if (failure.category === 'pixel-limit') {
        throw new BadRequestException(
          `图片像素超过 ${MAX_INPUT_PIXELS / 10_000} 万限制，请缩小后重试`,
        );
      }
      throw new BadRequestException('图片无法读取或压缩，请更换图片后重试');
    } finally {
      this.activeProcessing -= 1;
    }
  }
}

function classifyImageProcessingError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/pixel limit|limitInputPixels|exceeds[^\n]*pixels?/i.test(message)) {
    return {
      category: 'pixel-limit' as const,
      message: 'Input image exceeds the configured pixel limit',
    };
  }
  if (/premature end of JPEG/i.test(message)) {
    return {
      category: 'jpeg-decode' as const,
      message: 'JPEG data is too incomplete to decode',
    };
  }
  if (/unsupported image format|corrupt header/i.test(message)) {
    return {
      category: 'invalid-image' as const,
      message: 'Input is not a supported readable image',
    };
  }
  return {
    category: 'processing-error' as const,
    message: 'Image decoding or compression failed',
  };
}
