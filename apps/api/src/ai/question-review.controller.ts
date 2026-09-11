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
import {
  QuestionType,
  QuizQuestionReviewStatus,
  QuizQuestionSourceReviewStatus,
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
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { CurrentUser, Roles } from '../common/auth';
import { QuestionReviewService } from './question-review.service';

class ReviewListQueryDto {
  @IsOptional() @IsEnum(QuizQuestionReviewStatus)
  reviewStatus: QuizQuestionReviewStatus =
    QuizQuestionReviewStatus.DRAFT_REVIEW;
  @IsOptional() @IsEnum(QuizQuestionSourceReviewStatus)
  sourceReviewStatus?: QuizQuestionSourceReviewStatus;
  @IsOptional() @IsString() @Length(1, 191) subjectId?: string;
  @IsOptional() @IsEnum(QuestionType) gradingType?: QuestionType;
  @IsOptional() @IsString() @Length(1, 191) createdById?: string;
  @IsOptional() @IsString() @Length(1, 200) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

class QuestionReviewDto {
  @IsInt() @Min(1) expectedRevision!: number;
  @IsString() @Length(1, 100) typeLabel!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  chapterIds!: string[];
  @IsString() @Length(2, 10_000) prompt!: string;
  @IsArray() options!: Array<{ id: string; text: string }>;
  @IsArray() correctAnswer!: string[];
  @IsOptional() @IsObject() gradingRubric?: Record<string, unknown> | null;
  @IsString() @Length(0, 10_000) explanation!: string;
}

class RejectQuestionDto {
  @IsInt() @Min(1) expectedRevision!: number;
  @IsString() @Length(1, 1_000) reason!: string;
}

class ReopenQuestionDto {
  @IsInt() @Min(1) expectedRevision!: number;
}

class RevalidateSourceDto {
  @IsInt() @Min(1) expectedRevision!: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  knowledgeNodeIds!: string[];
}

class BulkRevalidateSourceDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  questionIds!: string[];
}

@ApiTags('AI question reviews')
@Roles(Role.EDITOR, Role.ADMIN)
@Controller('ai/question-reviews')
export class QuestionReviewController {
  constructor(private readonly reviews: QuestionReviewService) {}

  @Get()
  list(@Query() query: ReviewListQueryDto) {
    return this.reviews.list(query);
  }

  @Get(':questionId')
  get(@Param('questionId') questionId: string) {
    return this.reviews.get(questionId);
  }

  @Patch(':questionId')
  save(
    @CurrentUser() user: User,
    @Param('questionId') questionId: string,
    @Body() dto: QuestionReviewDto,
  ) {
    return this.reviews.save(user, questionId, dto);
  }

  @Post(':questionId/approve')
  approve(
    @CurrentUser() user: User,
    @Param('questionId') questionId: string,
    @Body() dto: QuestionReviewDto,
  ) {
    return this.reviews.approve(user, questionId, dto);
  }

  @Post(':questionId/reject')
  reject(
    @CurrentUser() user: User,
    @Param('questionId') questionId: string,
    @Body() dto: RejectQuestionDto,
  ) {
    return this.reviews.reject(
      user,
      questionId,
      dto.expectedRevision,
      dto.reason,
    );
  }

  @Post(':questionId/reopen')
  reopen(
    @CurrentUser() user: User,
    @Param('questionId') questionId: string,
    @Body() dto: ReopenQuestionDto,
  ) {
    return this.reviews.reopen(user, questionId, dto.expectedRevision);
  }

  @Post('revalidate-source/bulk')
  bulkRevalidateSources(
    @CurrentUser() user: User,
    @Body() dto: BulkRevalidateSourceDto,
  ) {
    return this.reviews.bulkRevalidateSources(user, dto.questionIds);
  }

  @Post(':questionId/revalidate-source')
  revalidateSource(
    @CurrentUser() user: User,
    @Param('questionId') questionId: string,
    @Body() dto: RevalidateSourceDto,
  ) {
    return this.reviews.revalidateSource(
      user,
      questionId,
      dto.expectedRevision,
      dto.knowledgeNodeIds,
    );
  }
}
