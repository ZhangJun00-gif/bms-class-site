import { ConflictException, Injectable } from '@nestjs/common';

@Injectable()
export class ExportAdmissionService {
  private busy = false;

  acquire() {
    if (this.busy) throw new ConflictException('已有导出正在生成，请稍后重试');
    this.busy = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy = false;
    };
  }
}
