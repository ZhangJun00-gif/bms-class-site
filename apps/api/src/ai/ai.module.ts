import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AiConversationsController } from './ai-conversations.controller';
import { AiConversationsService } from './ai-conversations.service';
import { AiKnowledgeService } from './ai-knowledge.service';
import { AiController } from './ai.controller';
import { AiGatewayService } from './ai-gateway.service';
import { EmbeddingService } from './embedding.service';
import { LlmService } from './llm.service';
import { QuestionGenerationController } from './question-generation.controller';
import { QuestionGenerationService } from './question-generation.service';
import { QuestionGenerationSourceService } from './question-generation-source.service';
import { QuestionReviewController } from './question-review.controller';
import { QuestionReviewService } from './question-review.service';

@Module({
  imports: [KnowledgeModule],
  controllers: [
    AiController,
    AiConversationsController,
    QuestionGenerationController,
    QuestionReviewController,
  ],
  providers: [
    AiConversationsService,
    AiGatewayService,
    AiKnowledgeService,
    EmbeddingService,
    LlmService,
    QuestionGenerationService,
    QuestionGenerationSourceService,
    QuestionReviewService,
  ],
  exports: [AiGatewayService],
})
export class AiModule {}
