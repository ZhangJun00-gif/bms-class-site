import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Prisma, Role, User } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Response } from 'express';
import { CurrentUser, Roles } from '../common/auth';
import { AuditService } from '../common/audit.service';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from '../common/keyset-cursor';
import { PrismaService } from '../database/prisma.service';
import { MediaService } from '../media/media.service';
import { ImageUploadAdmission, IMAGE_UPLOAD_LIMITS } from '../media/image-upload-admission';
import { AlbumOriginalExportService } from './album-original-export.service';

class AlbumDto {
  @IsString() @Length(1, 160) title!: string;
  @IsString() @Length(0, 2_000) description!: string;
}

class RenameAlbumDto {
  @IsString() @Length(1, 160) title!: string;
}

class AlbumPhotoPageQuery {
  @IsOptional() @IsString() @Length(1, 512) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize = 30;
}

const PHOTO_SELECT = {
  id: true,
  albumId: true,
  caption: true,
  mimeType: true,
  size: true,
  width: true,
  height: true,
  sortOrder: true,
  createdAt: true,
  original: { select: { photoId: true } },
} as const;

@ApiTags('albums')
@Controller('albums')
export class AlbumsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    private readonly originals: AlbumOriginalExportService,
  ) {}

  @Get()
  async list(
    @Query('includePhotos') includePhotos?: string,
    @Query('includeArchived') includeArchived?: string,
    @CurrentUser() user?: User,
  ) {
    const withPhotos = includePhotos === 'true';
    const withArchived = includeArchived === 'true';
    if (withArchived && !isAlbumManager(user)) {
      throw new ForbiddenException('只有编辑和管理员可以查看归档相册');
    }
    const items = await this.prisma.album.findMany({
      where: {
        deletedAt: null,
        ...(withArchived ? {} : { archivedAt: null }),
      },
      include: {
        photos: {
          orderBy: { sortOrder: 'asc' },
          // 摘要模式只取封面一张；管理端可传 includePhotos=true 取全量
          ...(withPhotos ? {} : { take: 1 }),
          select: PHOTO_SELECT,
        },
        _count: { select: { photos: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      items: items.map(({ _count, photos, ...item }) => {
        const base = { ...item, photoCount: _count.photos };
        if (withPhotos) {
          return {
            ...base,
            photos: photos.map((photo) => this.media.serializePhoto(photo)),
          };
        }
        return {
          ...base,
          coverUrl: photos[0]
            ? this.media.serializePhoto(photos[0]).url
            : null,
        };
      }),
      total: items.length,
    };
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user?: User) {
    const album = await this.prisma.album.findFirstOrThrow({
      where: {
        id,
        deletedAt: null,
        ...(isAlbumManager(user) ? {} : { archivedAt: null }),
      },
      include: {
        photos: {
          orderBy: { sortOrder: 'asc' },
          select: PHOTO_SELECT,
        },
        _count: { select: { photos: true } },
      },
    });
    const { _count, photos, ...rest } = album;
    return {
      ...rest,
      photoCount: _count.photos,
      photos: photos.map((photo) => this.media.serializePhoto(photo)),
    };
  }

  @Get(':id/photos')
  async photos(
    @Param('id') id: string,
    @Query() query: AlbumPhotoPageQuery,
    @CurrentUser() user?: User,
  ) {
    const album = await this.prisma.album.findFirstOrThrow({
      where: {
        id,
        deletedAt: null,
        ...(isAlbumManager(user) ? {} : { archivedAt: null }),
      },
      select: { id: true, _count: { select: { photos: true } } },
    });
    const cursor = query.cursor ? readPhotoCursor(query.cursor) : null;
    const cursorWhere: Prisma.PhotoWhereInput | undefined = cursor
      ? {
          OR: [
            { sortOrder: { gt: cursor.sortOrder } },
            {
              sortOrder: cursor.sortOrder,
              createdAt: { gt: cursor.createdAt },
            },
            {
              sortOrder: cursor.sortOrder,
              createdAt: cursor.createdAt,
              id: { gt: cursor.id },
            },
          ],
        }
      : undefined;
    const rows = await this.prisma.photo.findMany({
      where: { albumId: id, ...(cursorWhere ?? {}) },
      select: PHOTO_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: query.pageSize + 1,
    });
    const hasMore = rows.length > query.pageSize;
    const items = rows.slice(0, query.pageSize);
    const last = items.at(-1);
    return {
      items: items.map((photo) => this.media.serializePhoto(photo)),
      photoCount: album._count.photos,
      nextCursor:
        hasMore && last
          ? encodeKeysetCursor({
              sortOrder: last.sortOrder,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Get(':id/originals/summary')
  originalsSummary(@Param('id') id: string, @CurrentUser() user: User) {
    return this.originals.summary(user, id);
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Get(':id/originals.zip')
  originalArchive(@Param('id') id: string, @CurrentUser() user: User, @Res() response: Response) {
    return this.originals.streamArchive(user, id, response);
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post()
  async create(@Body() dto: AlbumDto, @CurrentUser() user: User) {
    const title = dto.title.trim();
    if (!title) throw new BadRequestException('相册标题不能为空');
    return this.prisma.$transaction(async (transaction) => {
      const album = await transaction.album.create({
        data: {
          title,
          description: dto.description.trim(),
          authorId: user.id,
        },
      });
      await this.audit.record(
        user.id,
        'album.create',
        'Album',
        album.id,
        undefined,
        transaction,
      );
      return album;
    });
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Patch(':id')
  async rename(
    @Param('id') id: string,
    @Body() dto: RenameAlbumDto,
    @CurrentUser() user: User,
  ) {
    const title = dto.title.trim();
    if (!title) throw new BadRequestException('相册标题不能为空');
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.album.findFirstOrThrow({
        where: { id, deletedAt: null },
      });
      if (existing.title === title) return existing;
      const album = await transaction.album.update({
        where: { id },
        data: { title },
      });
      await this.audit.record(
        user.id,
        'album.rename',
        'Album',
        id,
        { previousTitle: existing.title, title },
        transaction,
      );
      return album;
    });
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post(':id/archive')
  async archive(@Param('id') id: string, @CurrentUser() user: User) {
    return this.setArchived(id, true, user);
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post(':id/restore')
  async restore(@Param('id') id: string, @CurrentUser() user: User) {
    return this.setArchived(id, false, user);
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post(':id/photos')
  @UseInterceptors(
    ImageUploadAdmission(),
    FileInterceptor('file', { limits: { ...IMAGE_UPLOAD_LIMITS, files: 1, parts: 14 } }),
  )
  async upload(
    @Param('id') albumId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('caption') caption: string,
    @CurrentUser() user: User,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    if (
      !file ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
    ) {
      throw new BadRequestException(
        '仅支持 10MB 以内的 JPEG、PNG 或 WebP 图片',
      );
    }
    await this.prisma.album.findFirstOrThrow({
      where: { id: albumId, deletedAt: null, archivedAt: null },
    });
    return this.media.createAlbumImage(
      file,
      user.id,
      { albumId, caption },
      idempotencyKey,
      async (transaction, photo) => {
        const album = await transaction.album.count({
          where: { id: albumId, deletedAt: null, archivedAt: null },
        });
        if (album !== 1) {
          throw new BadRequestException('相册不存在、已归档或已删除');
        }
        await this.audit.record(
          user.id,
          'photo.upload',
          'Photo',
          photo.id,
          { albumId },
          transaction,
        );
      },
    );
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Delete(':albumId/photos/:photoId')
  async removePhoto(
    @Param('albumId') albumId: string,
    @Param('photoId') photoId: string,
    @CurrentUser() user: User,
  ) {
    return this.media.removeFromAlbum(
      albumId,
      photoId,
      async (transaction, result) => {
        await this.audit.record(
          user.id,
          'album.photo.remove',
          'Photo',
          photoId,
          {
            albumId,
            photoDeleted: result.photoDeleted,
            objectCleanupRequired: Boolean(
              result.photoDeleted && result.objectKey,
            ),
          },
          transaction,
        );
      },
    );
  }

  @Get('photos/:id/content')
  async content(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Res() response: Response,
  ) {
    await this.media.sendContent(id, user, response);
  }

  private async setArchived(id: string, archived: boolean, user: User) {
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      await transaction.album.findFirstOrThrow({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      const changed = await transaction.album.updateMany({
        where: {
          id,
          deletedAt: null,
          archivedAt: archived ? null : { not: null },
        },
        data: { archivedAt: archived ? now : null },
      });
      const album = await transaction.album.findUniqueOrThrow({ where: { id } });
      if (changed.count === 1) {
        await this.audit.record(
          user.id,
          archived ? 'album.archive' : 'album.restore',
          'Album',
          id,
          undefined,
          transaction,
        );
      }
      return album;
    });
  }
}

function isAlbumManager(user?: Pick<User, 'role'>) {
  return user?.role === Role.EDITOR || user?.role === Role.ADMIN;
}

function readPhotoCursor(value: string) {
  const parsed = decodeKeysetCursor(value);
  if (
    typeof parsed.sortOrder !== 'number' ||
    !Number.isInteger(parsed.sortOrder) ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.id !== 'string' ||
    !parsed.id ||
    parsed.id.length > 191
  ) {
    throw new BadRequestException('相册照片游标无效');
  }
  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException('相册照片游标无效');
  }
  return { sortOrder: parsed.sortOrder, createdAt, id: parsed.id };
}
