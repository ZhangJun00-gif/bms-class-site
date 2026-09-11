import { Module } from '@nestjs/common';
import { QuizModule } from '../quiz/quiz.module';
import { AdminDailyPracticeUsersController } from './admin-daily-practice-users.controller';
import { AdminDailyPracticeController } from './admin-daily-practice.controller';
import { DailyPracticeController } from './daily-practice.controller';
import { DailyPracticeService } from './daily-practice.service';

@Module({
  imports: [QuizModule],
  controllers: [
    DailyPracticeController,
    AdminDailyPracticeController,
    AdminDailyPracticeUsersController,
  ],
  providers: [DailyPracticeService],
  exports: [DailyPracticeService],
})
export class DailyPracticeModule {}
