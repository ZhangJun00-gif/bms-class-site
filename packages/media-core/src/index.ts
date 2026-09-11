import COS from "cos-nodejs-sdk-v5";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

export const MAX_STORED_IMAGE_BYTES = 300 * 1024;
export const MAX_INPUT_PIXELS = 32_000_000;
export const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_WIDTH = 1_920;

export interface CompressedImage {
  data: Buffer;
  mimeType: "image/webp";
  size: number;
  width: number;
  height: number;
}

export type SupportedImageFormat = "jpeg" | "png" | "webp";

export async function inspectImage(input: Buffer) {
  if (!input.length || input.length > MAX_INPUT_IMAGE_BYTES) {
    throw new Error("image-size-limit");
  }
  const metadata = await sharp(input, {
    failOn: "none",
    limitInputPixels: MAX_INPUT_PIXELS,
  }).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    !["jpeg", "png", "webp"].includes(metadata.format ?? "")
  ) {
    throw new Error("unsupported-image-format");
  }
  return {
    format: metadata.format as SupportedImageFormat,
    width: metadata.width,
    height: metadata.height,
  };
}

export async function compressImage(input: Buffer): Promise<CompressedImage> {
  const metadata = await inspectImage(input);
  let width = Math.min(metadata.width, MAX_IMAGE_WIDTH);
  const qualities = [82, 74, 66, 58, 50, 42];

  for (const quality of qualities) {
    const compressed = await renderWebp(input, width, quality);
    if (compressed.data.length <= MAX_STORED_IMAGE_BYTES) return compressed;
  }

  while (width > 320) {
    width = Math.max(320, Math.floor(width * 0.8));
    const compressed = await renderWebp(input, width, 46);
    if (compressed.data.length <= MAX_STORED_IMAGE_BYTES) return compressed;
  }

  const fallback = await renderWebp(input, 320, 32);
  if (fallback.data.length > MAX_STORED_IMAGE_BYTES) {
    throw new Error("image-compression-size-limit");
  }
  return fallback;
}

async function renderWebp(
  input: Buffer,
  width: number,
  quality: number,
): Promise<CompressedImage> {
  const { data, info } = await sharp(input, {
    failOn: "none",
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    mimeType: "image/webp",
    size: data.length,
    width: info.width,
    height: info.height,
  };
}

export function createMediaObjectKey(now: Date, id = randomUUID()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `media/${year}/${month}/${id}.webp`;
}

export interface MediaEndpoint {
  domain: string;
  protocol: "http:" | "https:";
}

export interface MediaCosConfig {
  bucket: string;
  region: string;
  endpoint?: MediaEndpoint;
  publicEndpoint: MediaEndpoint;
  secretId: string;
  secretKey: string;
  securityToken?: string;
  signedUrlTtlSeconds: number;
}

export interface CosMediaClient {
  getBucket(
    params: COS.GetBucketParams,
    callback: (error: COS.CosError, data: COS.GetBucketResult) => void,
  ): void;
  putObject(
    params: COS.PutObjectParams,
    callback: (error: COS.CosError) => void,
  ): void;
  getObjectUrl(
    params: COS.GetObjectUrlParams,
    callback: (error: COS.CosError, data: COS.GetObjectUrlResult) => void,
  ): string;
  deleteObject(
    params: COS.DeleteObjectParams,
    callback: (error: COS.CosError) => void,
  ): void;
  getObject?(
    params: COS.GetObjectParams,
    callback: (error: COS.CosError, data: COS.GetObjectResult) => void,
  ): void;
  headObject?(
    params: COS.HeadObjectParams,
    callback: (error: COS.CosError, data: COS.HeadObjectResult) => void,
  ): void;
}

export class CosMediaStore {
  private readonly client: CosMediaClient;

  constructor(
    private readonly config: MediaCosConfig,
    client?: CosMediaClient,
  ) {
    this.client =
      client ??
      new COS({
        SecretId: config.secretId,
        SecretKey: config.secretKey,
        SecurityToken: config.securityToken,
        Domain: config.endpoint?.domain,
        Protocol: config.endpoint?.protocol,
        KeepAlive: true,
        Timeout: 10_000,
      });
  }

  async upload(data: Buffer, objectKey: string, mimeType: string) {
    await new Promise<void>((resolve, reject) => {
      this.client.putObject(
        {
          Bucket: this.config.bucket,
          Region: this.config.region,
          Key: objectKey,
          Body: data,
          ContentLength: data.length,
          ContentType: mimeType,
          CacheControl: "private, max-age=300",
          ACL: "private",
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  async signedReadUrl(objectKey: string) {
    return new Promise<string>((resolve, reject) => {
      this.client.getObjectUrl(
        {
          Bucket: this.config.bucket,
          Region: this.config.region,
          Key: objectKey,
          Method: "GET",
          Sign: true,
          Expires: this.config.signedUrlTtlSeconds,
          Domain: this.config.publicEndpoint.domain,
          Protocol: this.config.publicEndpoint.protocol,
        },
        (error, data) => (error ? reject(error) : resolve(data.Url)),
      );
    });
  }

  async delete(objectKey: string) {
    await new Promise<void>((resolve, reject) => {
      this.client.deleteObject(
        {
          Bucket: this.config.bucket,
          Region: this.config.region,
          Key: objectKey,
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  async download(objectKey: string, maxBytes?: number) {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error('Invalid download byte limit');
    if (!this.client.getObject) {
      throw new Error('COS client does not support getObject');
    }
    return new Promise<Buffer>((resolve, reject) => {
      this.client.getObject!(
        {
          Bucket: this.config.bucket,
          Region: this.config.region,
          Key: objectKey,
          ...(maxBytes === undefined ? {} : { Range: `bytes=0-${maxBytes}` }),
        },
        (error, data) => {
          if (error) return reject(error);
          const body = data.Body;
          if (maxBytes !== undefined && (Buffer.isBuffer(body) ? body.length : typeof body === 'string' ? Buffer.byteLength(body) : Infinity) > maxBytes) return reject(new Error('Media object exceeds download byte limit'));
          if (Buffer.isBuffer(body)) return resolve(body);
          if (typeof body === 'string') return resolve(Buffer.from(body));
          reject(new Error('COS object body is not a buffer'));
        },
      );
    });
  }

  async exists(objectKey: string) {
    if (!this.client.headObject) return false;
    return new Promise<boolean>((resolve, reject) => {
      this.client.headObject!(
        {
          Bucket: this.config.bucket,
          Region: this.config.region,
          Key: objectKey,
        },
        (error) => {
          if (!error) return resolve(true);
          if ((error as { statusCode?: number }).statusCode === 404) {
            return resolve(false);
          }
          reject(error);
        },
      );
    });
  }

  async listObjects(prefix = "media/") {
    const objects: Array<{ key: string; size: number; lastModified: string }> =
      [];
    let marker: string | undefined;
    do {
      const page = await new Promise<COS.GetBucketResult>((resolve, reject) => {
        this.client.getBucket(
          {
            Bucket: this.config.bucket,
            Region: this.config.region,
            Prefix: prefix,
            Marker: marker,
            MaxKeys: 1_000,
          },
          (error, data) => (error ? reject(error) : resolve(data)),
        );
      });
      for (const item of page.Contents ?? []) {
        objects.push({
          key: item.Key,
          size: Number(item.Size),
          lastModified: item.LastModified,
        });
      }
      if (page.IsTruncated !== "true") break;
      if (!page.NextMarker || page.NextMarker === marker) {
        throw new Error("COS list response did not advance");
      }
      marker = page.NextMarker;
    } while (objects.length <= 50_000);
    if (objects.length > 50_000)
      throw new Error("COS media object audit limit exceeded");
    return objects;
  }
}

export function parseMediaEndpoint(value: string): MediaEndpoint {
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new Error("COS 图片存储访问域名格式无效");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("COS 图片存储访问域名格式无效");
  }
  return { domain: url.host, protocol: url.protocol };
}

export function readMediaCosConfig(
  env: Record<string, string | undefined>,
): MediaCosConfig {
  const required = [
    "MEDIA_COS_BUCKET",
    "MEDIA_COS_REGION",
    "MEDIA_COS_PUBLIC_ENDPOINT",
    "MEDIA_COS_SECRET_ID",
    "MEDIA_COS_SECRET_KEY",
  ] as const;
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`COS 图片存储配置不完整：缺少 ${missing.join(", ")}`);
  }
  const ttl = Number(env.MEDIA_SIGNED_URL_TTL_SECONDS ?? "300");
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 300) {
    throw new Error("MEDIA_SIGNED_URL_TTL_SECONDS 必须是 30 到 300 之间的整数");
  }
  const bucket = env.MEDIA_COS_BUCKET!.trim();
  if (!/-\d+$/.test(bucket)) {
    throw new Error("MEDIA_COS_BUCKET 必须是包含 APPID 的完整 Bucket 名称");
  }
  return {
    bucket,
    region: env.MEDIA_COS_REGION!.trim(),
    endpoint: env.MEDIA_COS_ENDPOINT?.trim()
      ? parseMediaEndpoint(env.MEDIA_COS_ENDPOINT)
      : undefined,
    publicEndpoint: parseMediaEndpoint(env.MEDIA_COS_PUBLIC_ENDPOINT!),
    secretId: env.MEDIA_COS_SECRET_ID!.trim(),
    secretKey: env.MEDIA_COS_SECRET_KEY!.trim(),
    securityToken: env.MEDIA_COS_SECURITY_TOKEN?.trim() || undefined,
    signedUrlTtlSeconds: ttl,
  };
}
