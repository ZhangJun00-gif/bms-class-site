import {
  Body,
  CallHandler,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  HttpCode,
  HttpStatus,
  NestInterceptor,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs';
import { CurrentUser } from '../common/auth';
import { KnowledgeImportService } from './knowledge-import.service';
import { readKnowledgeLimits } from './knowledge-limits';

const KNOWLEDGE_IMPORT_TEMP_DIR = resolve(
  process.env.KNOWLEDGE_IMPORT_TEMP_DIR ??
    process.env.KNOWLEDGE_TEMP_DIR ??
    join(process.cwd(), '.tmp', 'knowledge-imports'),
);

const knowledgeImportUpload = {
  storage: diskStorage({
    destination: (
      _request: unknown,
      _file: Express.Multer.File,
      callback: (error: Error | null, destination: string) => void,
    ) => {
      mkdirSync(KNOWLEDGE_IMPORT_TEMP_DIR, { recursive: true });
      callback(null, KNOWLEDGE_IMPORT_TEMP_DIR);
    },
    filename: (
      _request: unknown,
      _file: Express.Multer.File,
      callback: (error: Error | null, filename: string) => void,
    ) => callback(null, `${randomUUID()}.upload`),
  }),
  limits: { fileSize: readKnowledgeLimits().importMaxZipBytes },
};

class UploadCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ file?: Express.Multer.File }>();
    return next.handle().pipe(
      finalize(() => {
        if (request.file?.path) rmSync(request.file.path, { force: true });
      }),
    );
  }
}

class CreateImportDto {
  @IsString() @Length(1, 191) libraryId!: string;
  @IsOptional() @IsString() @Length(1, 191) targetDocumentId?: string;
}

class PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

class CursorQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cursor = 0;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize = 100;
}

@ApiTags('knowledge imports')
@Controller('knowledge/imports')
export class KnowledgeImportController {
  constructor(private readonly imports: KnowledgeImportService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('file', knowledgeImportUpload),
    UploadCleanupInterceptor,
  )
  create(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: CreateImportDto,
    @CurrentUser() user: User,
  ) {
    return this.imports.create(user, file, dto);
  }

  @Get()
  list(@Query() query: PageQueryDto, @CurrentUser() user: User) {
    return this.imports.list(user, query.page, query.pageSize);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: User) {
    return this.imports.get(user, id);
  }

  @Get(':id/structure')
  structure(
    @Param('id') id: string,
    @Query() query: CursorQueryDto,
    @CurrentUser() user: User,
  ) {
    return this.imports.structure(user, id, query.cursor, query.pageSize);
  }

  @Get(':id/issues')
  issues(
    @Param('id') id: string,
    @Query() query: PageQueryDto,
    @CurrentUser() user: User,
  ) {
    return this.imports.issues(user, id, query.page, query.pageSize);
  }

  @Post(':id/confirm')
  confirm(@Param('id') id: string, @CurrentUser() user: User) {
    return this.imports.confirm(user, id);
  }

  @Post(':id/retry-compensation')
  retryCompensation(@Param('id') id: string, @CurrentUser() user: User) {
    return this.imports.retryCompensation(user, id);
  }

  @Delete(':id')
  cancel(@Param('id') id: string, @CurrentUser() user: User) {
    return this.imports.cancel(user, id);
  }
}
