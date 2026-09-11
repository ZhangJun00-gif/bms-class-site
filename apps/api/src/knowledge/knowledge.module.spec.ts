import { MODULE_METADATA } from '@nestjs/common/constants';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeImportController } from './knowledge-import.controller';
import { KnowledgeLibrariesController } from './knowledge-libraries.controller';
import { KnowledgeModule } from './knowledge.module';
import { KnowledgeReaderController } from './knowledge-reader.controller';
import { KnowledgeVersionsController } from './knowledge-versions.controller';

describe('KnowledgeModule routing', () => {
  it('registers stage-three routes before the legacy document id route', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      KnowledgeModule,
    ) as unknown[];
    const legacyIndex = controllers.indexOf(KnowledgeController);

    expect(legacyIndex).toBeGreaterThan(controllers.indexOf(KnowledgeLibrariesController));
    expect(legacyIndex).toBeGreaterThan(controllers.indexOf(KnowledgeReaderController));
    expect(legacyIndex).toBeGreaterThan(controllers.indexOf(KnowledgeImportController));
    expect(legacyIndex).toBeGreaterThan(controllers.indexOf(KnowledgeVersionsController));
  });
});
