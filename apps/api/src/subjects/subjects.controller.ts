import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { CurrentUser, Roles } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { SubjectsService } from './subjects.service';

function optionalBoolean(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

class DirectoryQueryDto {
  @IsOptional()
  @Transform(({ value }) => optionalBoolean(value))
  @IsBoolean()
  includeInactive?: boolean;
}

class CreateDirectoryItemDto {
  @IsString() @Length(1, 100) name!: string;
  @IsString() @Length(1, 100) slug!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(-10_000) @Max(10_000)
  sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

class UpdateDirectoryItemDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsString() @Length(1, 100) slug?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(-10_000) @Max(10_000)
  sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

function canManage(user: User) {
  return user.role === Role.EDITOR || user.role === Role.ADMIN;
}

@ApiTags('subjects')
@Controller('subjects')
export class SubjectsController {
  constructor(
    private readonly subjects: SubjectsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Query() query: DirectoryQueryDto, @CurrentUser() user: User) {
    return this.subjects.listSubjects(
      Boolean(query.includeInactive && canManage(user)),
    );
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post()
  async create(@Body() dto: CreateDirectoryItemDto, @CurrentUser() user: User) {
    return this.subjects.createSubject(
      user.id,
      dto,
      (transaction, subject) =>
        this.audit.record(
          user.id,
          'subject.create',
          'Subject',
          subject.id,
          undefined,
          transaction,
        ),
    );
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateDirectoryItemDto,
    @CurrentUser() user: User,
  ) {
    return this.subjects.updateSubject(id, dto, (transaction) =>
      this.audit.record(
        user.id,
        'subject.update',
        'Subject',
        id,
        { ...dto },
        transaction,
      ),
    );
  }

  @Get(':id/chapters')
  chapters(
    @Param('id') id: string,
    @Query() query: DirectoryQueryDto,
    @CurrentUser() user: User,
  ) {
    return this.subjects.listChapters(
      id,
      Boolean(query.includeInactive && canManage(user)),
    );
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post(':id/chapters')
  async createChapter(
    @Param('id') subjectId: string,
    @Body() dto: CreateDirectoryItemDto,
    @CurrentUser() user: User,
  ) {
    return this.subjects.createChapter(
      subjectId,
      dto,
      (transaction, chapter) =>
        this.audit.record(
          user.id,
          'subject.chapter.create',
          'SubjectChapter',
          chapter.id,
          { subjectId },
          transaction,
        ),
    );
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Patch(':subjectId/chapters/:chapterId')
  async updateChapter(
    @Param('subjectId') subjectId: string,
    @Param('chapterId') chapterId: string,
    @Body() dto: UpdateDirectoryItemDto,
    @CurrentUser() user: User,
  ) {
    return this.subjects.updateChapter(
      subjectId,
      chapterId,
      dto,
      (transaction) =>
        this.audit.record(
          user.id,
          'subject.chapter.update',
          'SubjectChapter',
          chapterId,
          { subjectId, ...dto },
          transaction,
        ),
    );
  }
}
