import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CosMediaStore,
  readMediaCosConfig,
  type CosMediaClient,
  type MediaCosConfig,
} from '@bmc3/media-core';

export type MediaStorageProvider = 'database' | 'cos';
export const MEDIA_COS_CLIENT = Symbol('MEDIA_COS_CLIENT');

@Injectable()
export class MediaStorageService implements OnModuleInit {
  private readonly logger = new Logger(MediaStorageService.name);
  readonly provider = this.readProvider();
  private readonly config: MediaCosConfig | null =
    this.provider === 'cos' ? readMediaCosConfig(process.env) : null;
  private readonly store: CosMediaStore | null;

  constructor(
    @Optional() @Inject(MEDIA_COS_CLIENT) cosClient?: CosMediaClient,
  ) {
    this.store = this.config
      ? new CosMediaStore(this.config, cosClient)
      : null;
  }

  onModuleInit() {
    this.validateConfiguration();
  }

  usesCos() {
    return this.provider === 'cos';
  }

  async upload(data: Buffer, objectKey: string, mimeType: string) {
    try {
      await this.requireStore().upload(data, objectKey, mimeType);
    } catch (error) {
      this.logSdkError('upload', error);
      throw this.unavailable();
    }
  }

  async signedReadUrl(objectKey: string) {
    try {
      return await this.requireStore().signedReadUrl(objectKey);
    } catch (error) {
      this.logSdkError('sign', error);
      throw this.unavailable();
    }
  }

  async delete(objectKey: string) {
    try {
      await this.requireStore().delete(objectKey);
    } catch (error) {
      this.logSdkError('delete', error);
      throw this.unavailable();
    }
  }

  async read(objectKey: string) {
    try {
      return await this.requireStore().download(objectKey);
    } catch (error) {
      this.logSdkError('read', error);
      throw this.unavailable();
    }
  }

  async readBounded(objectKey: string, maxBytes: number) {
    try {
      return await this.requireStore().download(objectKey, maxBytes);
    } catch (error) {
      this.logSdkError('read', error);
      throw this.unavailable();
    }
  }

  async listObjects(prefix = 'media/') {
    try {
      return await this.requireStore().listObjects(prefix);
    } catch (error) {
      this.logSdkError('list', error);
      throw this.unavailable();
    }
  }

  private validateConfiguration() {
    if (process.env.NODE_ENV === 'production' && this.provider !== 'cos') {
      throw new Error(
        '生产环境必须设置 MEDIA_STORAGE_PROVIDER=cos，禁止回退到数据库图片存储',
      );
    }
    const concurrency = Number(
      process.env.MEDIA_MAX_PROCESSING_CONCURRENCY ?? '2',
    );
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
      throw new Error('MEDIA_MAX_PROCESSING_CONCURRENCY 必须是 1 或 2');
    }
    if (this.provider === 'cos') this.requireStore();
  }

  private readProvider(): MediaStorageProvider {
    const value = process.env.MEDIA_STORAGE_PROVIDER ?? 'database';
    if (value !== 'database' && value !== 'cos') {
      throw new Error('MEDIA_STORAGE_PROVIDER 仅支持 database 或 cos');
    }
    return value;
  }

  private requireStore() {
    if (!this.store) {
      throw new ServiceUnavailableException('图片对象存储未启用');
    }
    return this.store;
  }

  private unavailable() {
    return new ServiceUnavailableException(
      '图片存储服务暂时不可用，请稍后重试',
    );
  }

  private logSdkError(operation: string, error: unknown) {
    const sdkError = error as { code?: unknown; statusCode?: unknown };
    this.logger.error(
      JSON.stringify({
        event: 'media.storage.error',
        operation,
        code: typeof sdkError?.code === 'string' ? sdkError.code : 'unknown',
        statusCode:
          typeof sdkError?.statusCode === 'number'
            ? sdkError.statusCode
            : undefined,
      }),
    );
  }
}
