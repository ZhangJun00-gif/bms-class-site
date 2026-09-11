import { StorageService } from './storage.service';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('StorageService media decoupling', () => {
  const originalStorageProvider = process.env.STORAGE_PROVIDER;
  const originalMediaStorageProvider = process.env.MEDIA_STORAGE_PROVIDER;
  const originalLocalUploadDir = process.env.LOCAL_UPLOAD_DIR;

  afterAll(() => {
    if (originalStorageProvider === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = originalStorageProvider;
    if (originalMediaStorageProvider === undefined)
      delete process.env.MEDIA_STORAGE_PROVIDER;
    else process.env.MEDIA_STORAGE_PROVIDER = originalMediaStorageProvider;
    if (originalLocalUploadDir === undefined) delete process.env.LOCAL_UPLOAD_DIR;
    else process.env.LOCAL_UPLOAD_DIR = originalLocalUploadDir;
  });

  it('keeps knowledge documents local when only media selects COS', () => {
    process.env.STORAGE_PROVIDER = 'local';
    process.env.MEDIA_STORAGE_PROVIDER = 'cos';

    const storage = new StorageService();

    expect(storage.provider).toBe('local');
  });

  it('moves disk-backed large uploads without retaining the temporary file', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'bmc3-knowledge-storage-'));
    const source = join(root, 'incoming.tmp');
    await fs.writeFile(source, Buffer.from('knowledge-data'));
    process.env.STORAGE_PROVIDER = 'local';
    process.env.LOCAL_UPLOAD_DIR = join(root, 'objects');
    const storage = new StorageService();
    await storage.initialize();

    try {
      const stored = await storage.save({
        path: source,
        originalname: 'course.pdf',
        mimetype: 'application/pdf',
        size: 14,
        buffer: Buffer.alloc(0),
      } as Express.Multer.File, 'knowledge');

      await expect(fs.readFile(join(storage.root, ...stored.key.split('/')), 'utf8')).resolves.toBe('knowledge-data');
      await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
