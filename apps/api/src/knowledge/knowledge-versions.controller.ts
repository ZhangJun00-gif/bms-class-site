import { Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { IsOptional, IsString, Length } from 'class-validator';
import { CurrentUser } from '../common/auth';
import { KnowledgeVersionsService } from './knowledge-versions.service';

class TreeQueryDto {
  @IsOptional() @IsString() @Length(1, 191) versionId?: string;
}

@ApiTags('knowledge versions')
@Controller('knowledge')
export class KnowledgeVersionsController {
  constructor(private readonly versions: KnowledgeVersionsService) {}

  @Get('libraries/:libraryId/documents')
  documents(
    @Param('libraryId') libraryId: string,
    @CurrentUser() user: User,
  ) {
    return this.versions.listDocuments(user, libraryId);
  }

  @Get('documents/:documentId/versions')
  list(
    @Param('documentId') documentId: string,
    @CurrentUser() user: User,
  ) {
    return this.versions.listVersions(user, documentId);
  }

  @Get('documents/:documentId/tree')
  tree(
    @Param('documentId') documentId: string,
    @Query() query: TreeQueryDto,
    @CurrentUser() user: User,
  ) {
    return this.versions.tree(user, documentId, query.versionId);
  }

  @Post('documents/:documentId/versions/:versionId/publish')
  publish(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: User,
  ) {
    return this.versions.publish(user, documentId, versionId);
  }

  @Post('documents/:documentId/rebuild')
  rebuild(
    @Param('documentId') documentId: string,
    @CurrentUser() user: User,
  ) {
    return this.versions.rebuild(user, documentId);
  }

  @Delete('documents/:documentId')
  removeDocument(
    @Param('documentId') documentId: string,
    @CurrentUser() user: User,
  ) {
    return this.versions.removeDocument(user, documentId);
  }

  @Delete('documents/:documentId/versions/:versionId')
  removeVersion(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: User,
  ) {
    return this.versions.removeVersion(user, documentId, versionId);
  }

  @Post('cleanup-jobs/:jobId/retry')
  retryCleanup(
    @Param('jobId') jobId: string,
    @CurrentUser() user: User,
  ) {
    return this.versions.retryCleanup(user, jobId);
  }
}
