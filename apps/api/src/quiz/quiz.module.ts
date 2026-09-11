import { Module } from "@nestjs/common";
import { AiModule } from '../ai/ai.module';
import { QuizController } from "./quiz.controller";
import { QuizService } from "./quiz.service";
import { ShortAnswerGraderService } from "./short-answer-grader.service";
import { QuizImportController } from './quiz-import.controller';
import { QuizImportService } from './quiz-import.service';

@Module({
  imports: [AiModule],
  controllers: [QuizController, QuizImportController],
  providers: [QuizService, ShortAnswerGraderService, QuizImportService],
  exports: [QuizService],
})
export class QuizModule {}
