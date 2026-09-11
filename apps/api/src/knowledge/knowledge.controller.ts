import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  GoneException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ContentStatus,
  KnowledgeKind,
  KnowledgeLibraryScope,
  Role,
  User,
} from '@prisma/client';
import { IsString, Length } from 'class-validator';
import { CurrentUser, Roles } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { SubjectsService } from '../subjects/subjects.service';
import { KnowledgeVersionsService } from './knowledge-versions.service';

export const MAX_KNOWLEDGE_FILE_BYTES = 200 * 1024 * 1024;

class SubjectDto {
  @IsString() @Length(2, 100) name!: string;
  @IsString() @Length(2, 100) slug!: string;
}

@ApiTags('knowledge')
@Controller('knowledge')
export class KnowledgeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subjectsDirectory: SubjectsService,
    private readonly versions: KnowledgeVersionsService,
  ) {}

  @Get('subjects')
  async subjects() {
    return this.subjectsDirectory.listSubjects();
  }

  @Get()
  async list(@Query('subjectId') subjectId?: string) {
    const items = await this.prisma.knowledgeDocument.findMany({
      where: {
        status: ContentStatus.PUBLISHED,
        deletedAt: null,
        library: {
          scope: KnowledgeLibraryScope.SHARED,
          active: true,
          deletedAt: null,
        },
        subject: { active: true },
        ...(subjectId ? { subjectId } : {}),
      },
      select: {
        id: true,
        title: true,
        kind: true,
        indexStatus: true,
        sourceName: true,
        mimeType: true,
        fileSize: true,
        subject: { select: { id: true, name: true, slug: true, sortOrder: true, active: true } },
        publishedAt: true,
        updatedAt: true,
      },
      orderBy: { publishedAt: 'desc' },
    });
    return { items, total: items.length };
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Get('manage')
  async manageList(@Query('subjectId') subjectId?: string) {
    const items = await this.prisma.knowledgeDocument.findMany({
      where: {
        deletedAt: null,
        library: {
          scope: KnowledgeLibraryScope.SHARED,
          deletedAt: null,
        },
        ...(subjectId ? { subjectId } : {}),
      },
      select: {
        id: true,
        title: true,
        kind: true,
        status: true,
        indexStatus: true,
        sourceName: true,
        mimeType: true,
        fileSize: true,
        subject: { select: { id: true, name: true, slug: true, sortOrder: true, active: true } },
        createdAt: true,
        updatedAt: true,
        publishedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    return { items, total: items.length };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.prisma.knowledgeDocument.findFirstOrThrow({
      where: {
        id,
        status: ContentStatus.PUBLISHED,
        deletedAt: null,
        subject: { active: true },
        library: {
          scope: KnowledgeLibraryScope.SHARED,
          active: true,
          deletedAt: null,
        },
      },
      select: {
        id: true,
        title: true,
        kind: true,
        body: true,
        sourceName: true,
        mimeType: true,
        fileSize: true,
        subject: { select: { id: true, name: true, slug: true, sortOrder: true, active: true } },
        publishedAt: true,
      },
    });
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post('subjects')
  async createSubject(@Body() dto: SubjectDto, @CurrentUser() user: User) {
    return this.subjectsDirectory.createSubject(
      user.id,
      dto,
      (transaction, subject) =>
        this.audit.record(
          user.id,
          'knowledge.subject.create',
          'Subject',
          subject.id,
          undefined,
          transaction,
        ),
    );
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post('articles')
  createArticle() {
    throw new GoneException('新知识只接受 Markdown 或 ZIP 知识包');
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post('files')
  uploadFile() {
    throw new GoneException('新知识只接受 Markdown 或 ZIP 知识包');
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Patch(':id/reindex')
  async reindex(@Param('id') id: string, @CurrentUser() user: User) {
    const document = await this.prisma.knowledgeDocument.findFirstOrThrow({
      where: {
        id,
        library: { scope: KnowledgeLibraryScope.SHARED },
      },
    });
    if (document.kind === KnowledgeKind.MARKDOWN) {
      throw new BadRequestException('Markdown 必须从活动版本创建重新索引任务');
    }
    await this.prisma.$transaction(async (transaction) => {
      await transaction.indexJob.create({ data: { documentId: document.id } });
      await transaction.knowledgeDocument.update({
        where: { id },
        data: { indexStatus: 'PENDING' },
      });
      await this.audit.record(
        user.id,
        'knowledge.reindex',
        'KnowledgeDocument',
        id,
        undefined,
        transaction,
      );
    });
    return { id, indexStatus: 'PENDING' as const };
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Patch(':id/publish')
  async publish(@Param('id') id: string, @CurrentUser() user: User) {
    const document = await this.prisma.knowledgeDocument.findFirstOrThrow({
      where: {
        id,
        library: { scope: KnowledgeLibraryScope.SHARED },
      },
    });
    if (document.kind === KnowledgeKind.MARKDOWN) {
      throw new BadRequestException('Markdown 必须发布明确版本');
    }
    if (document.indexStatus !== 'READY') throw new BadRequestException('资料完成索引后才能发布');
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.knowledgeDocument.update({
        where: { id },
        data: { status: ContentStatus.PUBLISHED, publishedAt: new Date() },
      });
      await this.audit.record(
        user.id,
        'knowledge.publish',
        'KnowledgeDocument',
        id,
        undefined,
        transaction,
      );
      return updated;
    });
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: User) {
    await this.prisma.knowledgeDocument.findFirstOrThrow({
      where: {
        id,
        library: { scope: KnowledgeLibraryScope.SHARED },
      },
    });
    const result = await this.versions.removeDocument(user, id);
    return { id, ...result };
  }
}
