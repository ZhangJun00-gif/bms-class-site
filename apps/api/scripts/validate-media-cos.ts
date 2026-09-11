import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { MediaStorageService } from '../src/media/media-storage.service';
import { createMediaObjectKey } from '../src/media/media.service';

const mediaStorage = new MediaStorageService();

async function run() {
  mediaStorage.onModuleInit();
  if (!mediaStorage.usesCos()) {
    throw new Error('MEDIA_STORAGE_PROVIDER must be cos');
  }

  const objectKey = createMediaObjectKey(new Date());
  const image = await sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: { r: 29, g: 116, b: 132 },
    },
  })
    .webp({ quality: 80 })
    .toBuffer();
  const expectedHash = createHash('sha256').update(image).digest('hex');
  let uploaded = false;
  let unsignedReadDenied = false;
  let signedRead = false;
  let listed = false;
  let deleted = false;
  let validationError: unknown;

  try {
    await mediaStorage.upload(image, objectKey, 'image/webp');
    uploaded = true;

    const publicEndpoint = process.env.MEDIA_COS_PUBLIC_ENDPOINT!;
    const unsignedUrl = new URL(
      objectKey.split('/').map(encodeURIComponent).join('/'),
      publicEndpoint.endsWith('/') ? publicEndpoint : `${publicEndpoint}/`,
    );
    const unsignedResponse = await fetch(unsignedUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (unsignedResponse.status !== 403) {
      throw new Error(
        `Unsigned COS read returned HTTP ${unsignedResponse.status} instead of 403`,
      );
    }
    unsignedReadDenied = true;

    const signedUrl = await mediaStorage.signedReadUrl(objectKey);
    const response = await fetch(signedUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Signed COS read returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/webp')) {
      throw new Error('Signed COS read returned an unexpected content type');
    }
    const cacheControl = response.headers.get('cache-control') ?? '';
    if (!cacheControl.toLowerCase().includes('max-age=300')) {
      throw new Error('COS object cache metadata is not limited to 300 seconds');
    }
    const downloaded = Buffer.from(await response.arrayBuffer());
    const downloadedHash = createHash('sha256')
      .update(downloaded)
      .digest('hex');
    if (downloadedHash !== expectedHash) {
      throw new Error('Signed COS read did not return the uploaded bytes');
    }
    signedRead = true;

    const objects = await mediaStorage.listObjects(objectKey);
    listed = objects.some(
      (object) => object.key === objectKey && object.size === image.length,
    );
    if (!listed) throw new Error('Uploaded COS object was not listed');
  } catch (error) {
    validationError = error;
  } finally {
    if (uploaded) {
      try {
        await mediaStorage.delete(objectKey);
        deleted = true;
      } catch {
        throw new Error(`Validation COS object cleanup failed: ${objectKey}`);
      }
    }
  }

  if (deleted) {
    const remaining = await mediaStorage.listObjects(objectKey);
    if (remaining.some((object) => object.key === objectKey)) {
      throw new Error(
        `Validation COS object cleanup is incomplete: ${objectKey}`,
      );
    }
  }
  if (validationError) {
    const message =
      validationError instanceof Error
        ? validationError.message
        : 'unknown validation failure';
    throw new Error(`Media COS validation failed for ${objectKey}: ${message}`);
  }

  console.log(
    JSON.stringify({
      objectKey,
      bytes: image.length,
      uploaded,
      unsignedReadDenied,
      signedRead,
      listed,
      deleted,
      cleanupVerified: true,
    }),
  );
}

void run().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Media COS validation failed',
  );
  process.exitCode = 1;
});
