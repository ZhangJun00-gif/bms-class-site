import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ImageUploadAdmission, IMAGE_UPLOAD_LIMITS } from '../media/image-upload-admission';
import { ApiTags } from '@nestjs/swagger';
import { ContentStatus, Prisma, Role, User, Visibility } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import sanitizeHtml from 'sanitize-html';
import { CurrentUser, Public, Roles } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { MediaService } from '../media/media.service';
import { normalizeNewsContent } from './news-content';

const PUBLISHABLE_STATUSES = [
  ContentStatus.DRAFT,
  ContentStatus.PUBLISHED,
] as const;

const NEWS_SUMMARY_SELECT = {
  id: true,
  title: true,
  summary: true,
  bodyFormat: true,
  visibility: true,
  status: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, displayName: true } },
} satisfies Prisma.NewsSelect;

const NEWS_DETAIL_SELECT = {
  ...NEWS_SUMMARY_SELECT,
  body: true,
} satisfies Prisma.NewsSelect;

class NewsContentDto {
  @IsString() @Length(2, 160) title!: string;
  @IsString() @Length(0, 300) summary!: string;
  @IsString() @Length(1, 100_000) body!: string;
  @IsEnum(Visibility) visibility!: Visibility;
  @IsOptional() @IsIn(PUBLISHABLE_STATUSES) status?: ContentStatus;
}

class NewsUpdateDto extends NewsContentDto {
  @IsOptional() @IsISO8601({ strict: true }) expectedUpdatedAt?: string;
}

class NewsVersionDto {
  @IsOptional() @IsISO8601({ strict: true }) expectedUpdatedAt?: string;
}

class PaginationDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 100;
}

class NewsListDto extends PaginationDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  includeBody = true;
}

class NewsManageDto extends PaginationDto {
  @IsOptional() @IsEnum(ContentStatus) status?: ContentStatus;
}

class NewsImageDto {
  @IsOptional() @IsString() @Length(1, 191) albumId?: string;
  @IsOptional() @IsString() @Length(0, 300) caption?: string;
}

type NewsOwner = {
  id: string;
  authorId: string;
  status: ContentStatus;
  publishedAt: Date | null;
  updatedAt: Date;
};

@ApiTags('news')
@Controller('news')
export class NewsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Get()
  async list(@Query() query: NewsListDto) {
    return this.publishedList(
      {
        status: ContentStatus.PUBLISHED,
        visibility: Visibility.PUBLIC,
        deletedAt: null,
      },
      query,
    );
  }

  @Get('members')
  async memberList(@Query() query: NewsListDto) {
    return this.publishedList(
      { status: ContentStatus.PUBLISHED, deletedAt: null },
      query,
    );
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Get('drafts')
  async drafts(@CurrentUser() user: User) {
    const items = await this.prisma.news.findMany({
      where: {
        status: ContentStatus.DRAFT,
        authorId: user.id,
        deletedAt: null,
      },
      select: NEWS_DETAIL_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return { items, total: items.length };
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Get('drafts/:id')
  async draft(@Param('id') id: string, @CurrentUser() user: User) {
    return this.prisma.news.findFirstOrThrow({
      where: {
        id,
        status: ContentStatus.DRAFT,
        authorId: user.id,
        deletedAt: null,
      },
      select: NEWS_DETAIL_SELECT,
    });
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Get('manage')
  async manage(@Query() query: NewsManageDto, @CurrentUser() user: User) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 100;
    const where: Prisma.NewsWhereInput = {
      deletedAt: null,
      ...(user.role === Role.ADMIN ? {} : { authorId: user.id }),
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.news.findMany({
        where,
        select: NEWS_SUMMARY_SELECT,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.news.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Get('manage/:id')
  async manageDetail(@Param('id') id: string, @CurrentUser() user: User) {
    const existing = await this.findManageable(id, user);
    return this.prisma.news.findUniqueOrThrow({
      where: { id: existing.id },
      select: NEWS_DETAIL_SELECT,
    });
  }

  @Get('members/:id')
  async memberDetail(@Param('id') id: string) {
    return this.prisma.news.findFirstOrThrow({
      where: { id, status: ContentStatus.PUBLISHED, deletedAt: null },
      select: NEWS_DETAIL_SELECT,
    });
  }

  @Public()
  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.prisma.news.findFirstOrThrow({
      where: {
        id,
        status: ContentStatus.PUBLISHED,
        visibility: Visibility.PUBLIC,
        deletedAt: null,
      },
      select: NEWS_DETAIL_SELECT,
    });
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post('images')
  @UseInterceptors(
    ImageUploadAdmission(),
    FileInterceptor('file', { limits: { ...IMAGE_UPLOAD_LIMITS, files: 1, parts: 14 } }),
  )
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: NewsImageDto,
    @CurrentUser() user: User,
  ) {
    return this.media.createImage(
      file,
      user.id,
      dto,
      async (transaction, photo) => {
        await this.audit.record(
          user.id,
          'news.image.upload',
          'Photo',
          photo.id,
          { albumId: dto.albumId ?? null },
          transaction,
        );
      },
    );
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post()
  async create(@Body() dto: NewsContentDto, @CurrentUser() user: User) {
    const normalized = normalizeNewsContent(dto.body);
    const title = cleanTitle(dto.title);
    return this.prisma.$transaction(async (transaction) => {
      await this.validatePhotoReferences(
        transaction,
        normalized.photoIds,
        user.id,
      );
      const news = await transaction.news.create({
        data: {
          title,
          summary: cleanText(dto.summary),
          body: normalized.body,
          bodyFormat: 'HTML_V1',
          visibility: dto.visibility,
          status: dto.status ?? ContentStatus.DRAFT,
          authorId: user.id,
          publishedAt:
            dto.status === ContentStatus.PUBLISHED ? new Date() : null,
        },
      });
      if (normalized.photoIds.length) {
        await transaction.newsPhoto.createMany({
          data: normalized.photoIds.map((photoId) => ({
            newsId: news.id,
            photoId,
          })),
        });
      }
      await this.audit.record(
        user.id,
        'news.create',
        'News',
        news.id,
        { status: news.status, visibility: news.visibility },
        transaction,
      );
      return news;
    });
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Patch(':id/archive')
  async archive(
    @Param('id') id: string,
    @Body() dto: NewsVersionDto,
    @CurrentUser() user: User,
  ) {
    return this.changeStatus(
      id,
      ContentStatus.ARCHIVED,
      'news.archive',
      dto?.expectedUpdatedAt,
      user,
    );
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Patch(':id/restore')
  async restore(
    @Param('id') id: string,
    @Body() dto: NewsVersionDto,
    @CurrentUser() user: User,
  ) {
    return this.changeStatus(
      id,
      ContentStatus.DRAFT,
      'news.restore',
      dto?.expectedUpdatedAt,
      user,
      ContentStatus.ARCHIVED,
    );
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: NewsUpdateDto,
    @CurrentUser() user: User,
  ) {
    const existing = await this.findManageable(id, user);
    if (existing.status === ContentStatus.ARCHIVED)
      throw new BadRequestException('请先恢复已归档动态再进行编辑');

    const normalized = normalizeNewsContent(dto.body);
    const title = cleanTitle(dto.title);
    const nextStatus = dto.status ?? existing.status;
    const publishedAt =
      nextStatus === ContentStatus.PUBLISHED
        ? (existing.publishedAt ?? new Date())
        : null;

    return this.prisma.$transaction(async (transaction) => {
      await this.validatePhotoReferences(
        transaction,
        normalized.photoIds,
        user.id,
        id,
      );
      await this.updateWithVersion(
        transaction,
        id,
        dto.expectedUpdatedAt,
        {
          title,
          summary: cleanText(dto.summary),
          body: normalized.body,
          bodyFormat: 'HTML_V1',
          visibility: dto.visibility,
          status: nextStatus,
          publishedAt,
        },
      );
      await transaction.newsPhoto.deleteMany({ where: { newsId: id } });
      if (normalized.photoIds.length) {
        await transaction.newsPhoto.createMany({
          data: normalized.photoIds.map((photoId) => ({ newsId: id, photoId })),
        });
      }
      await this.audit.record(
        user.id,
        'news.update',
        'News',
        id,
        {
          previousStatus: existing.status,
          status: nextStatus,
          visibility: dto.visibility,
        },
        transaction,
      );
      return transaction.news.findUniqueOrThrow({ where: { id } });
    });
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: User) {
    const existing = await this.findManageable(id, user);
    return this.prisma.$transaction(async (transaction) => {
      const deleted = await transaction.news.updateMany({
        where: { id, deletedAt: null },
        data: {
          status: ContentStatus.ARCHIVED,
          publishedAt: null,
          deletedAt: new Date(),
        },
      });
      if (!deleted.count)
        throw new ConflictException('动态已被其他人修改或删除，请刷新后重试');
      await transaction.newsPhoto.deleteMany({ where: { newsId: id } });
      await this.audit.record(
        user.id,
        'news.delete',
        'News',
        id,
        { previousStatus: existing.status },
        transaction,
      );
      return { id, deleted: true as const };
    });
  }

  private async publishedList(
    where: Prisma.NewsWhereInput,
    query: NewsListDto,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 100;
    const includeBody = query.includeBody ?? true;
    const findMany = {
      where,
      select: includeBody ? NEWS_DETAIL_SELECT : NEWS_SUMMARY_SELECT,
      orderBy: [
        { publishedAt: 'desc' as const },
        { id: 'desc' as const },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    };
    const [items, total] = await Promise.all([
      this.prisma.news.findMany(findMany),
      this.prisma.news.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  private async findManageable(id: string, user: User): Promise<NewsOwner> {
    const existing = await this.prisma.news.findFirstOrThrow({
      where: { id, deletedAt: null },
      select: {
        id: true,
        authorId: true,
        status: true,
        publishedAt: true,
        updatedAt: true,
      },
    });
    if (existing.authorId !== user.id && user.role !== Role.ADMIN)
      throw new ForbiddenException('只能管理自己创建的动态');
    return existing;
  }

  private async changeStatus(
    id: string,
    status: ContentStatus,
    action: string,
    expectedUpdatedAt: string | undefined,
    user: User,
    requiredStatus?: ContentStatus,
  ) {
    const existing = await this.findManageable(id, user);
    if (requiredStatus && existing.status !== requiredStatus)
      throw new BadRequestException('只有已归档动态可以恢复为草稿');
    if (existing.status === status)
      throw new BadRequestException('动态已经处于目标状态');

    return this.prisma.$transaction(async (transaction) => {
      await this.updateWithVersion(transaction, id, expectedUpdatedAt, {
        status,
        publishedAt: null,
      });
      await this.audit.record(
        user.id,
        action,
        'News',
        id,
        { previousStatus: existing.status, status },
        transaction,
      );
      return transaction.news.findUniqueOrThrow({ where: { id } });
    });
  }

  private async updateWithVersion(
    transaction: Prisma.TransactionClient,
    id: string,
    expectedUpdatedAt: string | undefined,
    data: Prisma.NewsUpdateManyMutationInput,
  ) {
    const updated = await transaction.news.updateMany({
      where: {
        id,
        deletedAt: null,
        ...(expectedUpdatedAt
          ? { updatedAt: new Date(expectedUpdatedAt) }
          : {}),
      },
      data,
    });
    if (!updated.count)
      throw new ConflictException('动态已被其他人修改或删除，请刷新后重试');
  }

  private async validatePhotoReferences(
    transaction: Prisma.TransactionClient,
    photoIds: string[],
    userId: string,
    newsId?: string,
  ) {
    if (!photoIds.length) return;
    const photos = await transaction.photo.findMany({
      where: {
        id: { in: photoIds },
        OR: [
          { albumId: { not: null } },
          { uploadedById: userId },
          ...(newsId ? [{ news: { some: { newsId } } }] : []),
        ],
      },
      select: { id: true },
    });
    if (photos.length !== photoIds.length)
      throw new BadRequestException('正文包含无效或无权使用的图片');
  }
}

function cleanText(value: string) {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim();
}

function cleanTitle(value: string) {
  const title = cleanText(value);
  if (title.length < 2)
    throw new BadRequestException('动态标题至少需要 2 个字符');
  return title;
}
