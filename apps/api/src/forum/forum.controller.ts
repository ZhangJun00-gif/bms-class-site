import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma, Role, User } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import sanitizeHtml from 'sanitize-html';
import { CurrentUser, Roles } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';

class ThreadDto {
  @IsString() @Length(2, 160) title!: string;
  @IsString() @Length(1, 50_000) body!: string;
}
class PostDto { @IsString() @Length(1, 20_000) body!: string; }
class ReportDto { @IsString() @Length(2, 500) reason!: string; }
class ModerateDto {
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsBoolean() locked?: boolean;
  @IsOptional() @IsBoolean() hidden?: boolean;
}
class ThreadListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

@ApiTags('forum')
@Controller('forum')
export class ForumController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get('threads')
  async threads(@Query() query: ThreadListQueryDto) {
    const where = { deletedAt: null, hidden: false };
    const [items, total] = await Promise.all([
      this.prisma.forumThread.findMany({
        where,
        include: { author: { select: { id: true, displayName: true } }, _count: { select: { posts: true } } },
        orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.forumThread.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  @Get('threads/:id')
  getThread(@Param('id') id: string) {
    return this.prisma.forumThread.findFirstOrThrow({
      where: { id, deletedAt: null, hidden: false },
      include: {
        author: { select: { id: true, displayName: true } },
        posts: {
          where: { deletedAt: null, hidden: false },
          include: { author: { select: { id: true, displayName: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  @Post('threads')
  async createThread(@Body() dto: ThreadDto, @CurrentUser() user: User) {
    return this.prisma.$transaction(async (transaction) => {
      const thread = await transaction.forumThread.create({
        data: { title: sanitizeHtml(dto.title, { allowedTags: [] }), body: sanitizeHtml(dto.body), authorId: user.id },
      });
      await this.audit.record(
        user.id,
        'forum.thread.create',
        'ForumThread',
        thread.id,
        undefined,
        transaction,
      );
      return thread;
    });
  }

  @Patch('threads/:id')
  async updateThread(@Param('id') id: string, @Body() dto: ThreadDto, @CurrentUser() user: User) {
    const existing = await this.prisma.forumThread.findUniqueOrThrow({ where: { id } });
    if (existing.authorId !== user.id && user.role === Role.MEMBER) throw new ForbiddenException('只能编辑自己的主题');
    return this.prisma.forumThread.update({
      where: { id },
      data: { title: sanitizeHtml(dto.title, { allowedTags: [] }), body: sanitizeHtml(dto.body) },
    });
  }

  @Delete('threads/:id')
  async deleteThread(@Param('id') id: string, @CurrentUser() user: User) {
    const existing = await this.prisma.forumThread.findUniqueOrThrow({ where: { id } });
    if (existing.authorId !== user.id && user.role === Role.MEMBER) throw new ForbiddenException('只能删除自己的主题');
    await this.prisma.forumThread.update({ where: { id }, data: { deletedAt: new Date() } });
    return { deleted: true };
  }

  @Post('threads/:id/posts')
  async reply(@Param('id') threadId: string, @Body() dto: PostDto, @CurrentUser() user: User) {
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM ForumThread WHERE id = ${threadId} FOR UPDATE`,
      );
      if (rows.length !== 1) throw new NotFoundException('主题不存在');
      const thread = await transaction.forumThread.findUnique({
        where: { id: threadId },
        select: { locked: true, hidden: true, deletedAt: true },
      });
      if (!thread || thread.hidden || thread.deletedAt) {
        throw new NotFoundException('主题不存在');
      }
      if (thread.locked) {
        throw new ConflictException({
          statusCode: 409,
          code: 'FORUM_THREAD_LOCKED',
          message: '主题已锁定，不能回复',
        });
      }
      const post = await transaction.forumPost.create({
        data: { threadId, body: sanitizeHtml(dto.body), authorId: user.id },
      });
      await transaction.forumThread.update({
        where: { id: threadId },
        data: { updatedAt: new Date() },
      });
      return post;
    });
  }

  @Patch('posts/:id')
  async updatePost(@Param('id') id: string, @Body() dto: PostDto, @CurrentUser() user: User) {
    const existing = await this.prisma.forumPost.findUniqueOrThrow({ where: { id } });
    if (existing.authorId !== user.id && user.role === Role.MEMBER) throw new ForbiddenException('只能编辑自己的回复');
    return this.prisma.forumPost.update({ where: { id }, data: { body: sanitizeHtml(dto.body) } });
  }

  @Delete('posts/:id')
  async deletePost(@Param('id') id: string, @CurrentUser() user: User) {
    const existing = await this.prisma.forumPost.findUniqueOrThrow({ where: { id } });
    if (existing.authorId !== user.id && user.role === Role.MEMBER) throw new ForbiddenException('只能删除自己的回复');
    await this.prisma.forumPost.update({ where: { id }, data: { deletedAt: new Date() } });
    return { deleted: true };
  }

  @Post('threads/:id/reports')
  reportThread(@Param('id') threadId: string, @Body() dto: ReportDto, @CurrentUser() user: User) {
    return this.prisma.forumReport.create({ data: { threadId, reason: dto.reason, reporterId: user.id } });
  }

  @Post('posts/:id/reports')
  reportPost(@Param('id') postId: string, @Body() dto: ReportDto, @CurrentUser() user: User) {
    return this.prisma.forumReport.create({ data: { postId, reason: dto.reason, reporterId: user.id } });
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Get('reports')
  async reports() {
    const items = await this.prisma.forumReport.findMany({
      where: { resolvedAt: null },
      include: { reporter: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return { items, total: items.length };
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Patch('reports/:id/resolve')
  async resolveReport(@Param('id') id: string, @CurrentUser() user: User) {
    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.forumReport.updateMany({
        where: { id, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
      if (changed.count !== 1) {
        throw new ConflictException({
          statusCode: 409,
          code: 'FORUM_REPORT_STATUS_CHANGED',
          message: '举报状态已变化，请刷新后重试',
        });
      }
      const report = await transaction.forumReport.findUniqueOrThrow({
        where: { id },
      });
      await this.audit.record(
        user.id,
        'forum.report.resolve',
        'ForumReport',
        id,
        undefined,
        transaction,
      );
      return report;
    });
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Patch('threads/:id/moderation')
  async moderate(@Param('id') id: string, @Body() dto: ModerateDto, @CurrentUser() user: User) {
    return this.prisma.$transaction(async (transaction) => {
      const thread = await transaction.forumThread.update({
        where: { id },
        data: dto,
      });
      await this.audit.record(
        user.id,
        'forum.thread.moderate',
        'ForumThread',
        id,
        dto as unknown as Prisma.InputJsonValue,
        transaction,
      );
      return thread;
    });
  }
}
