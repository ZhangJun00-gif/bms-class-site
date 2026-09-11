import { CallHandler, ExecutionContext, Injectable, NestInterceptor, ServiceUnavailableException, mixin } from '@nestjs/common';
import { defer, finalize } from 'rxjs';

export const IMAGE_UPLOAD_LIMITS = {
  fileSize: 10 * 1024 * 1024,
  fieldSize: 16 * 1024,
  fields: 12,
  fieldNameSize: 100,
};

// Reserve worst-case input bytes before Multer allocates buffers. Decoding has
// its own shared budget; reservations remain held through all async handlers.
@Injectable()
export class ImageUploadAdmissionService {
  private activeFiles = 0;

  acquire(files: number) {
    if (!Number.isInteger(files) || files < 1 || files > 5) throw new Error('Invalid image upload reservation');
    if (this.activeFiles + files > 5) {
      throw new ServiceUnavailableException({ code: 'IMAGE_UPLOAD_BUSY', message: '图片上传繁忙，请稍后重试' });
    }
    this.activeFiles += files;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeFiles -= files;
    };
  }
}

export function ImageUploadAdmission(files = 1) {
  @Injectable()
  class AdmissionInterceptor implements NestInterceptor {
    constructor(private readonly admission: ImageUploadAdmissionService) {}

    intercept(_context: ExecutionContext, next: CallHandler) {
      return defer(() => {
        const release = this.admission.acquire(files);
        // Never release on socket close: async storage/DB work can still hold
        // file buffers after the client disconnects. Multer rejects aborted
        // receptions, which also flow through this finalizer.
        return defer(() => next.handle()).pipe(finalize(release));
      });
    }
  }
  return mixin(AdmissionInterceptor);
}
