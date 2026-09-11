import { Controller, Delete, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { CurrentUser } from '../common/auth';
import { AiConversationsService } from './ai-conversations.service';

class ConversationListQuery {
  @IsOptional() @IsString() @Length(1, 512) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  pageSize = 20;
}

@ApiTags('ai')
@Controller('ai/conversations')
export class AiConversationsController {
  constructor(private readonly conversations: AiConversationsService) {}

  @Get()
  list(@CurrentUser() user: User, @Query() query: ConversationListQuery) {
    return this.conversations.list(user.id, query.cursor, query.pageSize);
  }

  @Get(':id')
  detail(@CurrentUser() user: User, @Param('id') id: string) {
    return this.conversations.detail(user.id, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.conversations.remove(user.id, id);
  }
}
