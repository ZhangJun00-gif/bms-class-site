import { Controller, INestApplication, Post, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import request from 'supertest';
import { ImageUploadAdmission, ImageUploadAdmissionService, IMAGE_UPLOAD_LIMITS } from './image-upload-admission';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('image reception admission before Multer', () => {
  let app: INestApplication;
  let admission: ImageUploadAdmissionService;
  let held = deferred();
  let entered = deferred();
  let received: jest.Mock;
  let fail: boolean;

  @Controller()
  class UploadController {
    @Post('single')
    @UseInterceptors(ImageUploadAdmission(), FileInterceptor('file', {
      limits: { ...IMAGE_UPLOAD_LIMITS, files: 1, parts: 14 },
      fileFilter: (_req, _file, callback) => { received(); callback(null, true); },
    }))
    async single(@UploadedFile() file: Express.Multer.File) {
      entered.resolve();
      await held.promise;
      if (fail) throw new Error('fixture processing failure');
      return { bytes: file.buffer.length };
    }

    @Post('batch')
    @UseInterceptors(ImageUploadAdmission(5), FilesInterceptor('evidence', 5, {
      limits: { ...IMAGE_UPLOAD_LIMITS, files: 5, parts: 18 },
      fileFilter: (_req, _file, callback) => { received(); callback(null, true); },
    }))
    async batch(@UploadedFiles() files: Express.Multer.File[]) {
      entered.resolve();
      await held.promise;
      return { files: files.length };
    }
  }

  beforeEach(async () => {
    received = jest.fn();
    fail = false;
    held = deferred();
    entered = deferred();
    const module = await Test.createTestingModule({ controllers: [UploadController], providers: [ImageUploadAdmissionService] }).compile();
    admission = module.get(ImageUploadAdmissionService);
    app = module.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => { held.resolve(); await app.close(); });

  it('rejects another route before file reception and holds reservations through business completion', async () => {
    const running = request(app.getHttpServer()).post('/batch').attach('evidence', Buffer.from('image'), 'fixture.png').then((response) => response);
    await entered.promise;
    const rejected = await request(app.getHttpServer()).post('/single').attach('file', Buffer.from('second'), 'fixture.png');
    expect(rejected.status).toBe(503);
    expect(rejected.body.code).toBe('IMAGE_UPLOAD_BUSY');
    expect(received).toHaveBeenCalledTimes(1);
    held.resolve();
    expect((await running).status).toBe(201);
    expect((await request(app.getHttpServer()).post('/single').attach('file', Buffer.from('next'), 'fixture.png')).status).toBe(201);
  });

  it('releases reservations after a downstream error', async () => {
    fail = true;
    held.resolve();
    expect((await request(app.getHttpServer()).post('/single').attach('file', Buffer.from('image'), 'fixture.png')).status).toBe(500);
    const release = admission.acquire(5);
    release();
    release();
    expect(() => admission.acquire(5)()).not.toThrow();
  });

  it('releases reservations after Multer rejects oversized fields or malformed multipart', async () => {
    held.resolve();
    const tooLarge = await request(app.getHttpServer()).post('/single').field('caption', 'x'.repeat(IMAGE_UPLOAD_LIMITS.fieldSize + 1));
    expect(tooLarge.status).toBe(400);
    const malformed = await request(app.getHttpServer()).post('/single').set('Content-Type', 'multipart/form-data; boundary=fixture').send('--fixture\r\n');
    expect(malformed.status).toBe(400);
    expect(() => admission.acquire(5)()).not.toThrow();
  });

  it('releases a partially received multipart upload on client disconnect', async () => {
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    const parsed = deferred();
    received.mockImplementation(() => parsed.resolve());
    const client = httpRequest({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/batch', headers: { 'Content-Type': 'multipart/form-data; boundary=fixture' } });
    client.on('error', () => undefined);
    client.write('--fixture\r\nContent-Disposition: form-data; name="evidence"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\npartial');
    await parsed.promise;
    expect(() => admission.acquire(1)).toThrow();
    client.destroy();
    // The socket event and Multer's rejected promise must settle before reuse.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { admission.acquire(5)(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    throw new Error('Upload admission leaked after disconnect');
  });

  it('retains the reservation when a disconnected client still has async processing in flight', async () => {
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    const client = httpRequest({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/batch', headers: { 'Content-Type': 'multipart/form-data; boundary=fixture' } });
    client.on('error', () => undefined);
    client.end('--fixture\r\nContent-Disposition: form-data; name="evidence"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\nimage\r\n--fixture--\r\n');
    await entered.promise;
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => admission.acquire(1)).toThrow();
    held.resolve();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { admission.acquire(5)(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    throw new Error('Upload admission leaked after processing');
  });

  it('installs admission before Multer on every production image upload route', async () => {
    const { AlbumsController } = await import('../albums/albums.controller');
    const { CreditHoursController } = await import('../credit-hours/credit-hours.controller');
    const { NewsController } = await import('../news/news.controller');
    const { QuizController } = await import('../quiz/quiz.controller');
    for (const handler of [AlbumsController.prototype.upload, CreditHoursController.prototype.submit, NewsController.prototype.uploadImage, QuizController.prototype.uploadQuestionImage]) {
      const interceptors = Reflect.getMetadata(INTERCEPTORS_METADATA, handler);
      expect(interceptors).toHaveLength(2);
      expect(Reflect.getMetadata('design:paramtypes', interceptors[0])).toEqual([ImageUploadAdmissionService]);
    }
  });
});
