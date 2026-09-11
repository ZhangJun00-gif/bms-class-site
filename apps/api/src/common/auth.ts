import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role, User, Session } from '@prisma/client';
import { Request } from 'express';

export const IS_PUBLIC = 'isPublic';
export const REQUIRED_ROLES = 'requiredRoles';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(REQUIRED_ROLES, roles);

export type AuthenticatedRequest = Request & {
  user?: User;
  session?: Session;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user!,
);

export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Session =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().session!,
);

