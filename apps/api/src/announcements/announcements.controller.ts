import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role, type User } from '@prisma/client';
import { CurrentUser, Roles } from '../common/auth';
import {
  AdminAnnouncementPageQuery, AnnouncementActionDto, AnnouncementDraftDto,
  AnnouncementPageQuery, AnnouncementUpdateDto,
} from './announcements.dto';
import { AnnouncementsService } from './announcements.service';

@ApiTags('announcements')
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get('status')
  @Header('Cache-Control', 'private, no-store')
  status(@CurrentUser() user: User) { return this.announcements.status(user); }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentUser() user: User, @Query() query: AnnouncementPageQuery) { return this.announcements.history(user, query); }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  detail(@CurrentUser() user: User, @Param('id') id: string) { return this.announcements.detail(user, id); }

  @Post(':id/read')
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentUser() user: User, @Param('id') id: string) { return this.announcements.acknowledge(user, id); }
}

@ApiTags('admin-announcements')
@Roles(Role.ADMIN)
@Controller('admin/announcements')
export class AdminAnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentUser() user: User, @Query() query: AdminAnnouncementPageQuery) { return this.announcements.adminList(user, query); }

  @Post()
  @Header('Cache-Control', 'private, no-store')
  create(@CurrentUser() user: User, @Body() dto: AnnouncementDraftDto) { return this.announcements.create(user, dto); }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  detail(@CurrentUser() user: User, @Param('id') id: string) { return this.announcements.adminDetail(user, id); }

  @Patch(':id')
  @Header('Cache-Control', 'private, no-store')
  update(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: AnnouncementUpdateDto) { return this.announcements.update(user, id, dto); }

  @Delete(':id')
  @Header('Cache-Control', 'private, no-store')
  deleteDraft(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: AnnouncementActionDto) { return this.announcements.deleteDraft(user, id, dto.expectedRevision); }

  @Post(':id/publish')
  @Header('Cache-Control', 'private, no-store')
  publish(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: AnnouncementActionDto) { return this.announcements.publish(user, id, dto.expectedRevision); }

  @Post(':id/withdraw')
  @Header('Cache-Control', 'private, no-store')
  withdraw(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: AnnouncementActionDto) { return this.announcements.withdraw(user, id, dto.expectedRevision); }
}
