import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AiModule } from './ai/ai.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { AlbumsModule } from './albums/albums.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { CsrfGuard, RoleGuard, SessionGuard } from './common/guards';
import { DatabaseModule } from './database/database.module';
import { DailyPracticeModule } from './daily-practice/daily-practice.module';
import { CreditHoursModule } from './credit-hours/credit-hours.module';
import { ForumModule } from './forum/forum.module';
import { HealthController } from './health.controller';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { MediaModule } from './media/media.module';
import { NewsModule } from './news/news.module';
import { QuizModule } from './quiz/quiz.module';
import { StorageModule } from './storage/storage.module';
import { SubjectsModule } from './subjects/subjects.module';
import { UsersModule } from './users/users.module';
import { validateApiRuntimeConfig } from './runtime-config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      validate: (config) => {
        validateApiRuntimeConfig(config);
        return config;
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    DailyPracticeModule,
    CreditHoursModule,
    AnnouncementsModule,
    CommonModule,
    StorageModule,
    MediaModule,
    AuthModule,
    UsersModule,
    NewsModule,
    AlbumsModule,
    ForumModule,
    SubjectsModule,
    KnowledgeModule,
    QuizModule,
    AiModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RoleGuard },
  ],
})
export class AppModule {}
