import { Injectable, NotImplementedException } from '@nestjs/common';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import COS from 'cos-nodejs-sdk-v5';

export interface StoredObject {
  key: string;
  size: number;
  mimeType: string;
}

@Injectable()
export class StorageService {
  readonly provider = process.env.STORAGE_PROVIDER ?? 'local';
  readonly root = resolve(process.env.LOCAL_UPLOAD_DIR ?? join(process.cwd(), 'uploads'));
  private readonly cos = this.provider === 'cos'
    ? new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY })
    : null;

  async initialize() {
    if (this.provider === 'local') await fs.mkdir(this.root, { recursive: true });
  }

  async save(file: Express.Multer.File, prefix: string): Promise<StoredObject> {
    const safeName = `${randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const key = `${prefix}/${safeName}`;
    try {
      if (this.provider === 'cos') {
        const cos = this.requireCos();
        await new Promise<void>((resolveUpload, reject) => {
          cos.putObject({
            Bucket: process.env.COS_BUCKET!,
            Region: process.env.COS_REGION!,
            Key: key,
            Body: file.path ? createReadStream(file.path) : file.buffer,
            ContentType: file.mimetype,
          }, (error) => error ? reject(error) : resolveUpload());
        });
        return { key, size: file.size, mimeType: file.mimetype };
      }
      if (this.provider !== 'local') throw new NotImplementedException(`不支持的存储适配器：${this.provider}`);
      const target = join(this.root, ...key.split('/'));
      await fs.mkdir(dirname(target), { recursive: true });
      if (file.path) await fs.copyFile(file.path, target);
      else if (file.buffer) await fs.writeFile(target, file.buffer);
      else throw new Error('上传文件没有可读取的数据');
      return { key, size: file.size, mimeType: file.mimetype };
    } finally {
      await this.discardUpload(file);
    }
  }

  async remove(key: string) {
    if (this.provider === 'cos') {
      const cos = this.requireCos();
      await new Promise<void>((resolveDelete, reject) => {
        cos.deleteObject({ Bucket: process.env.COS_BUCKET!, Region: process.env.COS_REGION!, Key: key }, (error) =>
          error ? reject(error) : resolveDelete(),
        );
      });
      return;
    }
    const target = resolve(this.root, ...key.split('/'));
    if (!(target === this.root || target.startsWith(`${this.root}${sep}`))) throw new Error('Invalid object key');
    await fs.rm(target, { force: true });
  }

  async discardUpload(file: Express.Multer.File) {
    if (file.path) await fs.rm(file.path, { force: true }).catch(() => undefined);
  }

  stream(key: string) {
    const target = resolve(this.root, ...key.split('/'));
    if (!(target === this.root || target.startsWith(`${this.root}${sep}`))) throw new Error('Invalid object key');
    return createReadStream(target);
  }

  async signedReadUrl(key: string) {
    if (this.provider === 'local') return null;
    const cos = this.requireCos();
    return new Promise<string>((resolveUrl, reject) => {
      cos.getObjectUrl({
        Bucket: process.env.COS_BUCKET!,
        Region: process.env.COS_REGION!,
        Key: key,
        Sign: true,
        Expires: 300,
      }, (error, data) => error ? reject(error) : resolveUrl(data.Url));
    });
  }

  private requireCos() {
    if (!this.cos || !process.env.COS_BUCKET || !process.env.COS_REGION || !process.env.COS_SECRET_ID || !process.env.COS_SECRET_KEY) {
      throw new Error('COS 模式需要 COS_SECRET_ID、COS_SECRET_KEY、COS_BUCKET 和 COS_REGION');
    }
    return this.cos;
  }
}
