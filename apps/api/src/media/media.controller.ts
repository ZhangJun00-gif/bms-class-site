import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role, type User } from '@prisma/client';
import { Request, Response } from 'express';
import { Public, Roles } from '../common/auth';
import { MediaService } from './media.service';

type OptionalUserRequest = Request & { user?: User };

@ApiTags('media')
@Controller('media/images')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Roles(Role.ADMIN)
  @Get('orphans')
  orphanReport() {
    return this.media.orphanReport();
  }

  @Public()
  @Get(':id/content')
  async content(
    @Param('id') id: string,
    @Req() request: OptionalUserRequest,
    @Res() response: Response,
  ) {
    await this.media.sendContent(id, request.user, response);
  }
}
