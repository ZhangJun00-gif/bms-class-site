import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  Body,
  NestInterceptor,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags } from "@nestjs/swagger";
import { QuizImportMode, Role, type User } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";
import { diskStorage } from "multer";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Response } from "express";
import type { Observable } from "rxjs";
import { finalize } from "rxjs";
import { CurrentUser, Roles } from "../common/auth";
import { QuizImportService } from "./quiz-import.service";

const QUIZ_IMPORT_TEMP_DIR = resolve(
  process.env.QUIZ_IMPORT_TEMP_DIR ??
    join(process.cwd(), ".tmp", "quiz-imports"),
);
const quizImportUpload = {
  storage: diskStorage({
    destination: (
      _request: unknown,
      _file: Express.Multer.File,
      callback: (error: Error | null, destination: string) => void,
    ) => {
      mkdirSync(QUIZ_IMPORT_TEMP_DIR, { recursive: true });
      callback(null, QUIZ_IMPORT_TEMP_DIR);
    },
    filename: (
      _request: unknown,
      _file: Express.Multer.File,
      callback: (error: Error | null, filename: string) => void,
    ) => callback(null, `${randomUUID()}.upload`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
};

class QuizImportUploadCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<{ file?: Express.Multer.File }>();
    return next.handle().pipe(
      finalize(() => {
        if (request.file?.path) rmSync(request.file.path, { force: true });
      }),
    );
  }
}

function optionalBoolean(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return value;
}

class CreateQuizImportDto {
  @IsEnum(QuizImportMode) mode!: QuizImportMode;
  @IsOptional()
  @Transform(({ value }) => optionalBoolean(value))
  @IsBoolean()
  createMissingChapters?: boolean;
  @IsOptional() @IsString() @Length(1, 191) subjectId?: string;
  @IsOptional() @IsString() @Length(1, 191) pastPaperId?: string;
  @IsOptional() @IsString() @Length(1, 160) pastPaperTitle?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2200)
  pastPaperYear?: number;
}

class ImportListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize = 10;
}

@ApiTags("quiz imports")
@Roles(Role.EDITOR, Role.ADMIN)
@Controller("quizzes/imports")
export class QuizImportController {
  constructor(private readonly imports: QuizImportService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor("file", quizImportUpload),
    QuizImportUploadCleanupInterceptor,
  )
  create(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: CreateQuizImportDto,
    @CurrentUser() user: User,
  ) {
    return this.imports.create(user, file, dto);
  }

  @Get()
  list(@Query() query: ImportListQueryDto, @CurrentUser() user: User) {
    return this.imports.list(user, query.page, query.pageSize);
  }

  @Get("orphans")
  @Roles(Role.ADMIN)
  orphans() {
    return this.imports.orphanReport();
  }

  @Get(":id")
  get(@Param("id") id: string, @CurrentUser() user: User) {
    return this.imports.get(user, id);
  }

  @Post(":id/confirm")
  confirm(@Param("id") id: string, @CurrentUser() user: User) {
    return this.imports.confirm(user, id);
  }

  @Post(":id/cancel")
  cancel(@Param("id") id: string, @CurrentUser() user: User) {
    return this.imports.cancel(user, id);
  }

  @Get(":id/issues.csv")
  async issues(
    @Param("id") id: string,
    @CurrentUser() user: User,
    @Res() response: Response,
  ) {
    const content = await this.imports.issueCsv(user, id);
    response.type("text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="quiz-import-issues-${id}.csv"`,
    );
    response.send(content);
  }
}
