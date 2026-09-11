import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AccountStatus, Prisma, Role, User } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { randomBytes, createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import type { Response } from 'express';
import { CurrentUser, Roles } from '../common/auth';
import { AuditService } from '../common/audit.service';
import {
  decodeTimeIdCursor,
  encodeTimeIdCursor,
} from '../common/keyset-cursor';
import { PrismaService } from '../database/prisma.service';

class CreateInviteDto {
  @IsString() @Length(1, 120) label!: string;
  @IsInt() @Min(1) @Max(500) maxUses!: number;
  @IsDateString() expiresAt!: string;
}

class UpdateUserDto {
  @IsOptional() @IsEnum(AccountStatus) status?: AccountStatus;
  @IsOptional() @IsEnum(Role) role?: Role;
}

class AuditLogFilterDto {
  @IsOptional() @IsString() @Length(1, 191) actorId?: string;
  @IsOptional() @IsString() @Length(1, 100) action?: string;
  @IsOptional() @IsString() @Length(1, 80) targetType?: string;
  @IsOptional() @IsString() @Length(1, 64) targetId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

class AuditLogQueryDto extends AuditLogFilterDto {
  @IsOptional() @IsString() @Length(1, 512) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize = 100;
}

class AuditLogExportQueryDto extends AuditLogFilterDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5_000)
  limit = 5_000;
}

@ApiTags('users')
@Roles(Role.ADMIN)
@Controller()
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('users')
  async users() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        displayName: true,
        role: true,
        status: true,
        createdAt: true,
        approvedAt: true,
      },
    });
    return { items: users, total: users.length };
  }

  @Patch('users/:id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: User,
  ) {
    return this.runSerializable(async (tx) => {
      const existing = await tx.user.findUniqueOrThrow({ where: { id } });
      if (id === actor.id && dto.status === AccountStatus.SUSPENDED) {
        throw new ForbiddenException('不能停用当前登录账号');
      }
      if (id === actor.id && dto.role && dto.role !== existing.role) {
        throw new ForbiddenException('不能修改当前登录账号的角色');
      }

      const nextRole = dto.role ?? existing.role;
      const nextStatus = dto.status ?? existing.status;
      const removesActiveAdmin =
        existing.role === Role.ADMIN &&
        existing.status === AccountStatus.ACTIVE &&
        (nextRole !== Role.ADMIN || nextStatus !== AccountStatus.ACTIVE);

      if (removesActiveAdmin) {
        const activeAdminCount = await tx.user.count({
          where: { role: Role.ADMIN, status: AccountStatus.ACTIVE },
        });
        if (activeAdminCount <= 1) {
          throw new ConflictException('系统必须至少保留一个正常状态的管理员');
        }
      }

      const data: { role?: Role; status?: AccountStatus; approvedAt?: Date } =
        {};
      if (dto.role) data.role = dto.role;
      if (dto.status) {
        data.status = dto.status;
        if (dto.status === AccountStatus.ACTIVE) data.approvedAt = new Date();
      }
      const user = await tx.user.update({ where: { id }, data });
      if (dto.status === AccountStatus.SUSPENDED) {
        await tx.session.deleteMany({ where: { userId: id } });
      }
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'user.update',
          targetType: 'User',
          targetId: id,
          metadata: dto as unknown as Prisma.InputJsonValue,
        },
      });
      return {
        id: user.id,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
      };
    });
  }

  @Post('invites')
  async createInvite(@Body() dto: CreateInviteDto, @CurrentUser() actor: User) {
    const expiresAt = new Date(dto.expiresAt);
    if (expiresAt <= new Date()) {
      throw new BadRequestException('邀请码有效期必须晚于当前时间');
    }
    const code = randomBytes(12).toString('base64url');
    const invite = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invite.create({
        data: {
          codeHash: createHash('sha256')
            .update(code.toLowerCase())
            .digest('hex'),
          label: dto.label,
          maxUses: dto.maxUses,
          expiresAt,
        },
      });
      await this.audit.record(
        actor.id,
        'invite.create',
        'Invite',
        created.id,
        undefined,
        tx,
      );
      return created;
    });
    return {
      id: invite.id,
      code,
      label: invite.label,
      expiresAt: invite.expiresAt,
      maxUses: invite.maxUses,
      usedCount: invite.usedCount,
    };
  }

  @Get('invites')
  async invites() {
    const rows = await this.prisma.invite.findMany({
      select: {
        id: true,
        label: true,
        active: true,
        maxUses: true,
        usedCount: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { items: rows.map(serializeInvite), total: rows.length };
  }

  @Post('invites/:id/revoke')
  async revokeInvite(@Param('id') id: string, @CurrentUser() actor: User) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.invite.findUniqueOrThrow({
        where: { id },
        select: { id: true },
      });
      const changed = await tx.invite.updateMany({
        where: { id, active: true },
        data: { active: false, revokedAt: now },
      });
      const invite = await tx.invite.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          label: true,
          active: true,
          maxUses: true,
          usedCount: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
        },
      });
      if (changed.count === 1) {
        await this.audit.record(
          actor.id,
          'invite.revoke',
          'Invite',
          id,
          undefined,
          tx,
        );
      }
      return serializeInvite(invite);
    });
  }

  @Post('users/:id/reset-password')
  async resetPassword(@Param('id') id: string, @CurrentUser() actor: User) {
    if (id === actor.id)
      throw new ForbiddenException('不能重置当前登录账号的密码');
    const temporaryPassword = `${randomBytes(8).toString('base64url')}7a`;
    const passwordHash = await hash(temporaryPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { passwordHash },
      });
      await tx.session.deleteMany({ where: { userId: id } });
      await this.audit.record(
        actor.id,
        'user.password.reset',
        'User',
        id,
        undefined,
        tx,
      );
    });
    return {
      temporaryPassword,
      message: '临时密码仅显示一次，请通过可信渠道交给成员',
    };
  }

  @Get('admin/audit-logs')
  async logs(@Query() query: AuditLogQueryDto = new AuditLogQueryDto()) {
    const pageSize = query.pageSize ?? 100;
    const cursor = query.cursor ? decodeTimeIdCursor(query.cursor) : null;
    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...auditLogWhere(query),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.timestamp } },
                { createdAt: cursor.timestamp, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      take: pageSize + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { actor: { select: { id: true, displayName: true } } },
    });
    const hasMore = rows.length > pageSize;
    const items = rows.slice(0, pageSize);
    const last = items.at(-1);
    return {
      items,
      total: items.length,
      nextCursor:
        hasMore && last ? encodeTimeIdCursor(last.createdAt, last.id) : null,
    };
  }

  @Get('admin/audit-logs.csv')
  async exportLogs(
    @Query() query: AuditLogExportQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const limit = query.limit ?? 5_000;
    const rows = await this.prisma.auditLog.findMany({
      where: auditLogWhere(query),
      take: limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { actor: { select: { id: true, displayName: true } } },
    });
    const truncated = rows.length > limit;
    const csv = auditLogCsv(rows.slice(0, limit));
    response.type('text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="audit-logs.csv"',
    );
    response.setHeader('X-Result-Limit', String(limit));
    response.setHeader('X-Result-Truncated', String(truncated));
    return csv;
  }

  private async runSerializable<T>(
    task: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(task, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (caught) {
        const retryable =
          caught instanceof Prisma.PrismaClientKnownRequestError &&
          caught.code === 'P2034' &&
          attempt < 2;
        if (!retryable) throw caught;
      }
    }
    throw new ConflictException('管理员状态发生并发变更，请重试');
  }
}

function serializeInvite(invite: {
  id: string;
  label: string;
  active: boolean;
  maxUses: number;
  usedCount: number;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}) {
  const state = invite.revokedAt
    ? 'REVOKED'
    : invite.expiresAt <= new Date()
      ? 'EXPIRED'
      : invite.usedCount >= invite.maxUses
        ? 'EXHAUSTED'
        : invite.active
          ? 'ACTIVE'
          : 'REVOKED';
  return { ...invite, state };
}

function auditLogWhere(query: AuditLogFilterDto): Prisma.AuditLogWhereInput {
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if (from && to && from > to) {
    throw new BadRequestException('审计日志开始时间不能晚于结束时间');
  }
  return {
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.targetType ? { targetType: query.targetType } : {}),
    ...(query.targetId ? { targetId: query.targetId } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
  };
}

function auditLogCsv(
  rows: Array<{
    id: string;
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    metadata: Prisma.JsonValue | null;
    createdAt: Date;
    actor: { id: string; displayName: string } | null;
  }>,
) {
  const header = [
    'id',
    'createdAt',
    'actorId',
    'actorDisplayName',
    'action',
    'targetType',
    'targetId',
    'metadata',
  ];
  const records = rows.map((row) => [
    row.id,
    row.createdAt.toISOString(),
    row.actorId ?? '',
    row.actor?.displayName ?? '',
    row.action,
    row.targetType,
    row.targetId ?? '',
    row.metadata === null ? '' : JSON.stringify(row.metadata),
  ]);
  return `\uFEFF${[header, ...records]
    .map((record) => record.map(csvCell).join(','))
    .join('\r\n')}\r\n`;
}

function csvCell(value: string) {
  const spreadsheetSafe = /^(?:[=+\-@\t\r]|\s+[=+\-@])/.test(value)
    ? `'${value}`
    : value;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}
