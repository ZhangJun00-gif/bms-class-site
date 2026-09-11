import { Module } from '@nestjs/common';
import { SubjectsModule } from '../subjects/subjects.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeAccessService } from './knowledge-access.service';
import { KnowledgeImportController } from './knowledge-import.controller';
import { KnowledgeImportService } from './knowledge-import.service';
import { KnowledgeLibrariesController } from './knowledge-libraries.controller';
import { KnowledgeReaderController } from './knowledge-reader.controller';
import { KnowledgeReaderService } from './knowledge-reader.service';
import { KnowledgeVectorService } from './knowledge-vector.service';
import { KnowledgeVersionsController } from './knowledge-versions.controller';
import { KnowledgeVersionsService } from './knowledge-versions.service';

@Module({
  imports: [SubjectsModule],
  controllers: [
    KnowledgeReaderController,
    KnowledgeLibrariesController,
    KnowledgeImportController,
    KnowledgeVersionsController,
    KnowledgeController,
  ],
  providers: [
    KnowledgeAccessService,
    KnowledgeImportService,
    KnowledgeReaderService,
    KnowledgeVectorService,
    KnowledgeVersionsService,
  ],
  exports: [KnowledgeAccessService, KnowledgeVectorService],
})
export class KnowledgeModule {}
