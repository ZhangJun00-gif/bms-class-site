import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Role, type User } from '@prisma/client';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { CurrentUser, Roles } from '../common/auth';
import { MediaStorageService } from '../media/media-storage.service';
import { ImageUploadAdmission, IMAGE_UPLOAD_LIMITS } from '../media/image-upload-admission';
import {
  AdminCreditHourActionDto,
  AdminCreditHourCreateDto,
  AdminCreditHourDecisionDto,
  AdminCreditHourOverviewQuery,
  AdminCreditHourPageQuery,
  CreditHourLeaderboardQuery,
  CreditHourPageQuery,
  CreditHourSubmissionDto,
  WithdrawCreditHourDto,
} from './credit-hours.dto';
import { CreditHoursService } from './credit-hours.service';
import { CreditHourExportService } from './credit-hour-export.service';

@ApiTags('credit-hours')
@Controller('credit-hours')
export class CreditHoursController {
  constructor(
    private readonly creditHours: CreditHoursService,
    private readonly storage: MediaStorageService,
  ) {}

  @Post('submissions')
  @UseInterceptors(
    ImageUploadAdmission(5),
    FilesInterceptor('evidence', 5, {
      storage: memoryStorage(),
      limits: { ...IMAGE_UPLOAD_LIMITS, files: 5, parts: 18 },
    }),
  )
  submit(
    @CurrentUser() user: User,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: CreditHourSubmissionDto,
    @UploadedFiles() files: Express.Multer.File[] = [],
  ) {
    return this.creditHours.createSubmission(
      user,
      idempotencyKey,
      dto,
      files,
    );
  }

  @Get('submissions')
  listMine(@CurrentUser() user: User, @Query() query: CreditHourPageQuery) {
    return this.creditHours.listMine(user.id, query);
  }

  @Get('leaderboard')
  leaderboard(
    @CurrentUser() user: User,
    @Query() query: CreditHourLeaderboardQuery,
  ) {
    return this.creditHours.leaderboard(user.id, query);
  }

  @Get('users/:userId/submissions')
  publicSubmissions(
    @Param('userId') userId: string,
    @Query() query: CreditHourPageQuery,
  ) {
    return this.creditHours.publicSubmissions(userId, query);
  }

  @Get('me/summary')
  summary(@CurrentUser() user: User) {
    return this.creditHours.summary(user.id);
  }

  @Get('submissions/:id')
  detail(@CurrentUser() user: User, @Param('id') id: string) {
    return this.creditHours.getMine(user.id, id);
  }

  @Post('submissions/:id/withdraw')
  withdraw(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: WithdrawCreditHourDto,
  ) {
    return this.creditHours.withdraw(user, id, dto.expectedRevision);
  }

  @Get('evidence/:id/display')
  async display(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const evidence = await this.creditHours.evidenceForDisplay(id, user);
    await sendEvidence(this.storage, evidence, response);
  }
}

@ApiTags('admin-credit-hours')
@Roles(Role.ADMIN)
@Controller('admin/credit-hours')
export class AdminCreditHoursController {
  constructor(
    private readonly creditHours: CreditHoursService,
    private readonly exports: CreditHourExportService,
    private readonly storage: MediaStorageService,
  ) {}

  @Post('submissions')
  create(
    @CurrentUser() user: User,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: AdminCreditHourCreateDto,
  ) {
    return this.creditHours.createAdminSubmission(user, idempotencyKey, dto);
  }

  @Get('submissions')
  list(@Query() query: AdminCreditHourPageQuery) {
    return this.creditHours.listAdmin(query);
  }

  @Get('submissions/:id')
  detail(@Param('id') id: string) {
    return this.creditHours.getAdmin(id);
  }

  @Get('overview')
  overview(@Query() query: AdminCreditHourOverviewQuery) {
    return this.creditHours.adminOverview(query);
  }

  @Get('exports/approved.zip')
  async exportApproved(
    @CurrentUser() user: User,
    @Res() response: Response,
  ) {
    await this.exports.streamApprovedArchive(user, response);
  }

  @Get('runtime')
  runtime() {
    return this.creditHours.runtime();
  }

  @Get('operations/:id')
  operation(@Param('id') id: string) {
    return this.creditHours.cleanupOperation(id);
  }

  @Post('operations/:id/resume')
  resumeOperation(@CurrentUser() user: User, @Param('id') id: string) {
    return this.creditHours.resumeCleanup(user, id);
  }

  @Post('initializations/preflight')
  preflight() {
    return this.creditHours.preflight();
  }

  @Get('evidence/:id/original')
  async original(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const evidence = await this.creditHours.evidenceOriginal(id, user);
    await sendEvidence(this.storage, evidence, response);
  }

  @Post('submissions/:id/decisions')
  decision(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: AdminCreditHourDecisionDto,
  ) {
    return this.creditHours.overrideDecision(user, id, dto);
  }

  @Post('submissions/:id/reopen')
  reopen(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: AdminCreditHourActionDto,
  ) {
    return this.creditHours.reopen(user, id, dto);
  }

  @Post('submissions/:id/ai-retry')
  retry(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: AdminCreditHourActionDto,
  ) {
    return this.creditHours.retry(user, id, dto);
  }

  @Post('submissions/:id/deletion')
  delete(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: AdminCreditHourActionDto,
  ) {
    return this.creditHours.deleteSubmission(user, id, dto);
  }
}

async function sendEvidence(
  storage: MediaStorageService,
  evidence: { objectKey: string | null; data: Uint8Array | null; mimeType: string },
  response: Response,
) {
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  if (evidence.objectKey) {
    response.redirect(302, await storage.signedReadUrl(evidence.objectKey));
    return;
  }
  if (!evidence.data) {
    response.status(404).json({ message: '凭证内容不存在' });
    return;
  }
  response.type(evidence.mimeType).send(Buffer.from(evidence.data));
}
