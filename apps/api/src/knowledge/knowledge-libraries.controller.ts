import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { KnowledgeLibraryScope, Role, type User } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { CurrentUser, Roles } from '../common/auth';
import { KnowledgeAccessService } from './knowledge-access.service';

class CreateLibraryDto {
  @IsString() @Length(2, 160) name!: string;
  @IsString() @Length(1, 191) subjectId!: string;
  @IsEnum(KnowledgeLibraryScope) scope!: KnowledgeLibraryScope;
}

class UpdateLibraryDto {
  @IsOptional() @IsString() @Length(2, 160) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class AiSettingsDto {
  @IsBoolean() enabled!: boolean;
  @IsBoolean() acknowledged!: boolean;
}

class StatusDto {
  @IsBoolean() active!: boolean;
}

class PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize = 20;
}

@ApiTags('knowledge libraries')
@Controller('knowledge')
export class KnowledgeLibrariesController {
  constructor(private readonly access: KnowledgeAccessService) {}

  @Post('libraries')
  create(@Body() dto: CreateLibraryDto, @CurrentUser() user: User) {
    return this.access.create(user, dto);
  }

  @Get('libraries/:id')
  get(@Param('id') id: string, @CurrentUser() user: User) {
    return this.access.getAccessible(user, id);
  }

  @Patch('libraries/:id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLibraryDto,
    @CurrentUser() user: User,
  ) {
    return this.access.update(user, id, dto);
  }

  @Delete('libraries/:id')
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.access.remove(user, id);
  }

  @Patch('libraries/:id/ai-settings')
  setAi(
    @Param('id') id: string,
    @Body() dto: AiSettingsDto,
    @CurrentUser() user: User,
  ) {
    if (dto.enabled && !dto.acknowledged) {
      throw new BadRequestException('启用 AI 前必须明确确认第三方模型数据使用说明');
    }
    return this.access.setPrivateAi(user, id, dto.enabled);
  }

  @Roles(Role.ADMIN)
  @Get('private-library-metadata')
  privateMetadata(@Query() query: PageQueryDto) {
    return this.access.privateMetadata(query.page, query.pageSize);
  }

  @Roles(Role.ADMIN)
  @Patch('private-library-metadata/:id/status')
  setPrivateStatus(
    @Param('id') id: string,
    @Body() dto: StatusDto,
    @CurrentUser() user: User,
  ) {
    return this.access.setPrivateStatus(user, id, dto.active);
  }
}
