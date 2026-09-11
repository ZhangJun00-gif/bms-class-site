import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role, type User } from '@prisma/client';
import { CurrentUser, Roles } from '../common/auth';
import {
  AdminDailyPracticeSuggestionDto,
  AdminDailyPracticeUsersQueryDto,
} from './daily-practice.dto';
import { DailyPracticeService } from './daily-practice.service';

@ApiTags('admin-daily-practice-users')
@Roles(Role.ADMIN)
@Controller('admin/daily-practice/users')
export class AdminDailyPracticeUsersController {
  constructor(private readonly dailyPractice: DailyPracticeService) {}

  @Get()
  users(@Query() query: AdminDailyPracticeUsersQueryDto) {
    return this.dailyPractice.adminUsers(query);
  }

  @Get(':userId')
  user(@Param('userId') userId: string) {
    return this.dailyPractice.adminUserDetail(userId);
  }

  @Post(':userId/suggestions')
  suggest(
    @Param('userId') userId: string,
    @Body() dto: AdminDailyPracticeSuggestionDto,
    @CurrentUser() user: User,
  ) {
    return this.dailyPractice.submitAdminSuggestion(user, userId, dto);
  }

  @Post(':userId/plans/:practiceDate/regenerate')
  regenerate(
    @Param('userId') userId: string,
    @Param('practiceDate') practiceDate: string,
    @CurrentUser() user: User,
  ) {
    return this.dailyPractice.createAdminPlanRevision(
      user,
      userId,
      practiceDate,
      'ADMIN_REGENERATE',
    );
  }

  @Post(':userId/plans/:practiceDate/preview')
  preview(
    @Param('userId') userId: string,
    @Param('practiceDate') practiceDate: string,
    @CurrentUser() user: User,
  ) {
    return this.dailyPractice.createAdminPlanRevision(
      user,
      userId,
      practiceDate,
      'ADMIN_PREVIEW',
    );
  }
}
