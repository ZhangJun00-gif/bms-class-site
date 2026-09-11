import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentSession, CurrentUser, Public } from '../common/auth';
import { sessionCookieName } from '../common/guards';
import { Session, User } from '@prisma/client';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, RegisterDto } from './auth.dto';

function sessionCookieOptions(expires?: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    ...(expires ? { expires } : {}),
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(dto);
    response.cookie(
      sessionCookieName,
      result.token,
      sessionCookieOptions(result.expiresAt),
    );
    return { csrfToken: result.csrfToken, user: result.user };
  }

  @Get('me')
  me(@CurrentUser() user: User, @CurrentSession() session: Session) {
    return { user: this.auth.serializeUser(user), csrfToken: session.csrfToken };
  }

  @HttpCode(204)
  @Post('logout')
  async logout(
    @CurrentUser() user: User,
    @CurrentSession() session: Session,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(session.id, user.id);
    response.clearCookie(sessionCookieName, sessionCookieOptions());
  }

  @Post('change-password')
  changePassword(
    @CurrentUser() user: User,
    @CurrentSession() session: Session,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user, session.id, dto);
  }
}
