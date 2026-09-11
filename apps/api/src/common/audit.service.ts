import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    actorId: string | null,
    action: string,
    targetType: string,
    targetId?: string,
    metadata?: Prisma.InputJsonValue,
    client: Pick<Prisma.TransactionClient, 'auditLog'> = this.prisma,
  ) {
    await client.auditLog.create({
      data: { actorId, action, targetType, targetId, metadata },
    });
  }
}
