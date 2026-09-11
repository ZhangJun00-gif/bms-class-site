import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { KnowledgeLibraryScope, type User } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import type { Response } from 'express';
import { CurrentUser } from '../common/auth';
import {
  KnowledgeReaderService,
  READER_OUTLINE_DEFAULT_LIMIT,
  READER_OUTLINE_MAX_LIMIT,
  READER_RANGE_DEFAULT_AFTER,
  READER_RANGE_DEFAULT_BEFORE,
  READER_RANGE_MAX_DIRECTION,
} from './knowledge-reader.service';

class LibraryDirectoryQueryDto {
  @IsOptional() @IsEnum(KnowledgeLibraryScope) scope?: KnowledgeLibraryScope;
  @IsOptional() @IsString() @Length(1, 191) subjectId?: string;
  @IsOptional() @IsString() @Length(1, 160) query?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize = 20;
}

class OutlineQueryDto {
  @IsString() @Length(10, 100) revision!: string;
  @IsOptional() @IsString() @Length(10, 100) cursor?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(READER_OUTLINE_MAX_LIMIT)
  limit = READER_OUTLINE_DEFAULT_LIMIT;
}

class ChapterDirectoryQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 50;
}

class RangeQueryDto {
  @IsString() @Length(10, 100) revision!: string;
  @IsOptional() @IsString() @Length(1, 191) anchor?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(READER_RANGE_MAX_DIRECTION)
  before = READER_RANGE_DEFAULT_BEFORE;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(READER_RANGE_MAX_DIRECTION)
  after = READER_RANGE_DEFAULT_AFTER;
}

class ContextQueryDto {
  @IsOptional() @IsString() @Length(10, 100) revision?: string;
  @IsOptional() @IsString() @Length(1, 191) nodeId?: string;
  @IsOptional() @IsString() @Length(1, 191) blockId?: string;
}

function applyCache(
  response: Response,
  cache: { control: string; etag?: string },
) {
  response.setHeader('Cache-Control', cache.control);
  if (cache.etag) response.setHeader('ETag', cache.etag);
}

@ApiTags('knowledge reader')
@Controller('knowledge')
export class KnowledgeReaderController {
  constructor(private readonly reader: KnowledgeReaderService) {}

  @Get('libraries')
  directory(
    @CurrentUser() user: User,
    @Query() query: LibraryDirectoryQueryDto,
  ) {
    return this.reader.directory(user, query);
  }

  @Get('libraries/:libraryId/reader')
  async manifest(
    @CurrentUser() user: User,
    @Param('libraryId') libraryId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.reader.manifest(user, libraryId);
    applyCache(response, result.cache);
    return result.body;
  }

  @Get('libraries/:libraryId/chapters')
  chapters(
    @CurrentUser() user: User,
    @Param('libraryId') libraryId: string,
    @Query() query: ChapterDirectoryQueryDto,
  ) {
    return this.reader.chapters(
      user,
      libraryId,
      query.page,
      query.pageSize,
    );
  }

  @Get('libraries/:libraryId/reader/outline')
  async outline(
    @CurrentUser() user: User,
    @Param('libraryId') libraryId: string,
    @Query() query: OutlineQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.reader.outline(
      user,
      libraryId,
      query.revision,
      query.cursor,
      query.limit,
    );
    applyCache(response, result.cache);
    return result.body;
  }

  @Get('libraries/:libraryId/reader/range')
  async range(
    @CurrentUser() user: User,
    @Param('libraryId') libraryId: string,
    @Query() query: RangeQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.reader.range(
      user,
      libraryId,
      query.revision,
      query.anchor,
      query.before,
      query.after,
    );
    applyCache(response, result.cache);
    return result.body;
  }

  @Get('libraries/:libraryId/reader-context')
  async context(
    @CurrentUser() user: User,
    @Param('libraryId') libraryId: string,
    @Query() query: ContextQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.reader.context(user, libraryId, query);
    applyCache(response, result.cache);
    return result.body;
  }

  @Get('documents/:documentId/versions/:versionId/preview')
  async preview(
    @CurrentUser() user: User,
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.reader.previewManifest(
      user,
      documentId,
      versionId,
    );
    applyCache(response, result.cache);
    return result.body;
  }

  @Get('documents/:documentId/versions/:versionId/preview/range')
  async previewRange(
    @CurrentUser() user: User,
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Query() query: RangeQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.reader.previewRange(
      user,
      documentId,
      versionId,
      query.revision,
      query.anchor,
      query.before,
      query.after,
    );
    applyCache(response, result.cache);
    return result.body;
  }
}
