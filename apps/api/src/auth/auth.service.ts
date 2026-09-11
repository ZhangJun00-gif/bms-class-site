import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AccountStatus, Prisma, User } from '@prisma/client';
import { hash, verify } from '@node-rs/argon2';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { ChangePasswordDto, LoginDto, RegisterDto } from './auth.dto';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private digest(value: string) {
    return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  }

  private encryptStudentNumber(value: string) {
    const configured = process.env.STUDENT_DATA_KEY;
    const key = configured
      ? Buffer.from(configured, 'base64')
      : createHash('sha256').update('development-only-key').digest();
    if (key.length !== 32) throw new Error('STUDENT_DATA_KEY 必须是 32 字节 Base64 密钥');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  async register(dto: RegisterDto) {
    const inviteHash = this.digest(dto.inviteCode);
    const studentNumberHash = this.digest(dto.studentNumber);
    const invite = await this.prisma.invite.findUnique({ where: { codeHash: inviteHash } });
    if (!invite || !invite.active || invite.expiresAt <= new Date() || invite.usedCount >= invite.maxUses) {
      throw new UnauthorizedException('邀请码无效、已过期或已用完');
    }
    const existing = await this.prisma.user.findUnique({ where: { studentNumberHash } });
    if (existing) throw new ConflictException('该学号已提交过申请');

    const passwordHash = await hash(dto.password);
    let user: User;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const consumed = await tx.invite.updateMany({
          where: {
            id: invite.id,
            active: true,
            expiresAt: { gt: new Date() },
            usedCount: { lt: invite.maxUses },
          },
          data: { usedCount: { increment: 1 } },
        });
        if (consumed.count !== 1) throw new UnauthorizedException('邀请码已被用完');
        const created = await tx.user.create({
          data: {
            displayName: dto.displayName.trim(),
            studentNumberHash,
            studentNumberEncrypted: this.encryptStudentNumber(dto.studentNumber.trim()),
            passwordHash,
          },
        });
        await this.audit.record(
          created.id,
          'auth.register',
          'User',
          created.id,
          undefined,
          tx,
        );
        return created;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('该学号已提交过申请');
      }
      throw error;
    }
    return { id: user.id, status: user.status, message: '申请已提交，请等待管理员审核' };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { studentNumberHash: this.digest(dto.studentNumber) },
    });
    if (!user || !(await verify(user.passwordHash, dto.password))) {
      throw new UnauthorizedException('学号或密码错误');
    }
    if (user.status === AccountStatus.PENDING) throw new UnauthorizedException('账号仍在等待审核');
    if (user.status === AccountStatus.SUSPENDED) throw new UnauthorizedException('账号已被停用');

    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const days = Math.max(1, Number(process.env.SESSION_DAYS ?? 30));
    const session = await this.prisma.$transaction(async (tx) => {
      const created = await tx.session.create({
        data: {
          tokenHash: createHash('sha256').update(token).digest('hex'),
          csrfToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + days * 86_400_000),
        },
      });
      await this.audit.record(
        user.id,
        'auth.login',
        'Session',
        created.id,
        undefined,
        tx,
      );
      return created;
    });
    return { token, csrfToken, user: this.serializeUser(user), expiresAt: session.expiresAt };
  }

  async logout(sessionId: string, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.session.deleteMany({ where: { id: sessionId, userId } });
      await this.audit.record(
        userId,
        'auth.logout',
        'Session',
        sessionId,
        undefined,
        tx,
      );
    });
  }

  async changePassword(user: User, sessionId: string, dto: ChangePasswordDto) {
    if (!(await verify(user.passwordHash, dto.currentPassword))) {
      throw new UnauthorizedException('当前密码错误');
    }
    const passwordHash = await hash(dto.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.session.deleteMany({
        where: { userId: user.id, id: { not: sessionId } },
      });
      await this.audit.record(
        user.id,
        'auth.password.change',
        'User',
        user.id,
        undefined,
        tx,
      );
    });
    return { message: '密码已更新，其他设备的会话已退出' };
  }

  serializeUser(user: User) {
    return {
      id: user.id,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    };
  }
}
