import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { CurrentUser } from '../common/auth';
import {
  DailyPracticePageQueryDto,
  DailyPracticeSuggestionDto,
} from './daily-practice.dto';
import { DailyPracticeService } from './daily-practice.service';

@ApiTags('daily-practice')
@Controller('daily-practice')
export class DailyPracticeController {
  constructor(private readonly dailyPractice: DailyPracticeService) {}

  @Get('today')
  today(@CurrentUser() user: User) {
    return this.dailyPractice.today(user);
  }

  @Post('plans/:planId/start')
  start(@Param('planId') planId: string, @CurrentUser() user: User) {
    return this.dailyPractice.start(user, planId);
  }

  @Post('suggestions')
  suggest(@Body() dto: DailyPracticeSuggestionDto, @CurrentUser() user: User) {
    return this.dailyPractice.submitUserSuggestion(user, dto);
  }

  @Get('history')
  history(
    @Query() query: DailyPracticePageQueryDto,
    @CurrentUser() user: User,
  ) {
    return this.dailyPractice.history(user, query);
  }

  @Get('history/:planId')
  historyDetail(@Param('planId') planId: string, @CurrentUser() user: User) {
    return this.dailyPractice.historyDetail(user, planId);
  }
}
