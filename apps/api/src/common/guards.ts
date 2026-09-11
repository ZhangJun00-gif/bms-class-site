import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountStatus, Role } from '@prisma/client';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AuthenticatedRequest, IS_PUBLIC, REQUIRED_ROLES } from './auth';

const SESSION_COOKIE = 'bmc3_session';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) {
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const session = await this.prisma.session.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (session && session.expiresAt > new Date() && session.user.status === AccountStatus.ACTIVE) {
        request.session = session;
        request.user = session.user;
      }
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    if (!request.user) throw new UnauthorizedException('请先登录');
    return true;
  }
}

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<Role[]>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user || !roles.includes(request.user.role)) {
      throw new ForbiddenException('当前账号无权执行此操作');
    }
    return true;
  }
}

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const actual = request.header('x-csrf-token') ?? '';
    const expected = request.session?.csrfToken ?? '';
    const valid = actual.length === expected.length && actual.length > 0 &&
      timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
    if (!valid) throw new ForbiddenException('CSRF 校验失败，请刷新页面后重试');
    return true;
  }
}

export const sessionCookieName = SESSION_COOKIE;

