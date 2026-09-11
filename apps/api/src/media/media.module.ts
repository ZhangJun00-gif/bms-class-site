import { Global, Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaCleanupService } from './media-cleanup.service';
import { MediaStorageService } from './media-storage.service';
import { MediaService } from './media.service';
import { ImageProcessingService } from './image-processing.service';
import { MediaObjectRecoveryService } from './media-object-recovery.service';
import { ExportAdmissionService } from './export-admission.service';
import { ImageUploadAdmissionService } from './image-upload-admission';

@Global()
@Module({
  controllers: [MediaController],
  providers: [
    MediaStorageService,
    ImageProcessingService,
    MediaService,
    MediaCleanupService,
    MediaObjectRecoveryService,
    ExportAdmissionService,
    ImageUploadAdmissionService,
  ],
  exports: [MediaService, MediaStorageService, ImageProcessingService, MediaObjectRecoveryService, ExportAdmissionService, ImageUploadAdmissionService],
})
export class MediaModule {}
