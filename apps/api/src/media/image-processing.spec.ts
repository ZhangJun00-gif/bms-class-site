import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import {
  compressImage,
  MAX_INPUT_PIXELS,
  MAX_STORED_IMAGE_BYTES,
} from './image-processing';

describe('compressImage', () => {
  it('normalizes a high-entropy image to WebP within the database limit', async () => {
    const width = 1_200;
    const height = 800;
    const source = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    })
      .png()
      .toBuffer();

    const result = await compressImage(source);

    expect(result.mimeType).toBe('image/webp');
    expect(result.size).toBeLessThanOrEqual(MAX_STORED_IMAGE_BYTES);
    expect(result.data.length).toBe(result.size);
    expect(result.width).toBeLessThanOrEqual(width);
    expect(result.height).toBeGreaterThan(0);
  });

  it('rejects images above the 32 megapixel decode limit', async () => {
    const width = 5_000;
    const height = Math.floor(MAX_INPUT_PIXELS / width) + 1;
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="red"/></svg>`,
    );

    await expect(compressImage(svg)).rejects.toThrow();
  });

  it('normalizes a JPEG with a recoverable truncated ending', async () => {
    const jpeg = await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: '#c03b2b',
      },
    })
      .jpeg()
      .toBuffer();

    const result = await compressImage(jpeg.subarray(0, jpeg.length - 2));

    expect(result.mimeType).toBe('image/webp');
    expect(result.size).toBeLessThanOrEqual(MAX_STORED_IMAGE_BYTES);
    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
  });

  it('rejects input that is not a readable image', async () => {
    await expect(
      compressImage(Buffer.from('not an image')),
    ).rejects.toThrow();
  });
});
