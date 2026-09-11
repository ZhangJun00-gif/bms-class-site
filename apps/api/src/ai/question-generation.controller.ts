import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AiQuestionGenerationComplexity,
  AiQuestionGenerationStatus,
  QuestionType,
  Role,
  type User,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { CurrentUser, Roles } from '../common/auth';
import { QuestionGenerationService } from './question-generation.service';
import { QuestionGenerationSourceService } from './question-generation-source.service';

class SubjectQueryDto {
  @IsString() @Length(1, 191) subjectId!: string;
}

class GenerationNodeQueryDto extends SubjectQueryDto {
  @IsOptional() @IsString() @Length(1, 200) query?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 100;
}

class QuestionGenerationDto {
  @IsString() @Length(1, 191) subjectId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  chapterIds!: string[];
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  knowledgeNodeIds!: string[];
  @IsEnum(QuestionType) gradingType!: QuestionType;
  @IsString() @Length(1, 100) typeLabel!: string;
  @IsEnum(AiQuestionGenerationComplexity)
  complexity!: AiQuestionGenerationComplexity;
  @IsInt() @Min(1) @Max(20) requestedCount!: number;
}

class GenerationJobQueryDto {
  @IsOptional() @IsEnum(AiQuestionGenerationStatus)
  status?: AiQuestionGenerationStatus;
  @IsOptional() @IsString() @Length(1, 191) subjectId?: string;
  @IsOptional() @IsString() @Length(1, 191) createdById?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

@ApiTags('AI question generation')
@Roles(Role.EDITOR, Role.ADMIN)
@Controller('ai')
export class QuestionGenerationController {
  constructor(
    private readonly generation: QuestionGenerationService,
    private readonly sources: QuestionGenerationSourceService,
  ) {}

  @Get('question-generation/sources/libraries')
  libraries(@Query() query: SubjectQueryDto) {
    return this.sources.libraries(query.subjectId);
  }

  @Get('question-generation/sources/libraries/:libraryId/nodes')
  nodes(
    @Param('libraryId') libraryId: string,
    @Query() query: GenerationNodeQueryDto,
  ) {
    return this.sources.nodes(
      query.subjectId,
      libraryId,
      query.query,
      query.page,
      query.pageSize,
    );
  }

  @Post('question-generation-jobs/preview')
  preview(@Body() dto: QuestionGenerationDto) {
    return this.generation.preview(dto);
  }

  @Post('question-generation-jobs')
  create(
    @CurrentUser() user: User,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: QuestionGenerationDto,
  ) {
    return this.generation.create(user, idempotencyKey ?? '', dto);
  }

  @Get('question-generation-jobs')
  list(@Query() query: GenerationJobQueryDto) {
    return this.generation.list(query);
  }

  @Get('question-generation-jobs/:id')
  get(@Param('id') id: string) {
    return this.generation.get(id);
  }

  @Post('question-generation-jobs/:id/cancel')
  cancel(@CurrentUser() user: User, @Param('id') id: string) {
    return this.generation.cancel(user, id);
  }
}
