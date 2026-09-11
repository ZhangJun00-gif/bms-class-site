import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  KnowledgeLibraryScope,
  Prisma,
  Role,
  type User,
} from '@prisma/client';
import { normalizeKnowledgeName } from '@bmc3/knowledge-core';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { markQuestionSourcesReviewRequired } from '../quiz/question-source-lifecycle';
import { readKnowledgeLimits } from './knowledge-limits';

export interface CreateKnowledgeLibraryInput {
  name: string;
  subjectId: string;
  scope: KnowledgeLibraryScope;
}

export interface UpdateKnowledgeLibraryInput {
  name?: string;
  active?: boolean;
}

@Injectable()
export class KnowledgeAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listAccessible(user: User) {
    const libraries = await this.prisma.knowledgeLibrary.findMany({
      where: {
        deletedAt: null,
        OR: [
          { scope: KnowledgeLibraryScope.SHARED, active: true },
          { scope: KnowledgeLibraryScope.PRIVATE, ownerId: user.id },
        ],
        subject: { active: true },
      },
      select: librarySelect,
      orderBy: [
        { scope: 'asc' },
        { subject: { sortOrder: 'asc' } },
        { name: 'asc' },
      ],
    });
    return { items: libraries.map(serializeLibrary), total: libraries.length };
  }

  async getAccessible(user: User, id: string) {
    const library = await this.prisma.knowledgeLibrary.findFirst({
      where: {
        id,
        deletedAt: null,
        subject: { active: true },
        OR: [
          { scope: KnowledgeLibraryScope.SHARED, active: true },
          { scope: KnowledgeLibraryScope.PRIVATE, ownerId: user.id },
        ],
      },
      select: librarySelect,
    });
    if (!library) throw new NotFoundException('知识库不存在');
    return serializeLibrary(library);
  }

  async create(user: User, input: CreateKnowledgeLibraryInput) {
    const limits = readKnowledgeLimits();
    const name = normalizeKnowledgeName(input.name);
    if (name.length < 2 || name.length > 160) {
      throw new BadRequestException('知识库名称必须为 2-160 字');
    }
    const subject = await this.prisma.subject.findFirst({
      where: { id: input.subjectId, active: true },
      select: { id: true },
    });
    if (!subject) throw new BadRequestException('请选择有效学科');
    if (
      input.scope === KnowledgeLibraryScope.SHARED &&
      user.role === Role.MEMBER
    ) {
      throw new ForbiddenException('普通成员只能创建私有知识库');
    }
    const ownerId =
      input.scope === KnowledgeLibraryScope.PRIVATE ? user.id : null;
    const counterKeys = ['GLOBAL'];
    if (ownerId) counterKeys.push('PRIVATE_GLOBAL', `USER:${ownerId}`);
    const library = await this.prisma.$transaction(
      async (transaction) => {
        for (const key of counterKeys) {
          await transaction.knowledgeCapacityCounter.upsert({
            where: { key },
            create: { key },
            update: {},
          });
        }
        await transaction.$queryRaw(
          Prisma.sql`
            SELECT ${Prisma.raw('`key`')} FROM KnowledgeCapacityCounter
            WHERE ${Prisma.raw('`key`')} IN (${Prisma.join(counterKeys)}) FOR UPDATE
          `,
        );
        if (ownerId) {
          const count = await transaction.knowledgeLibrary.count({
            where: {
              ownerId,
              scope: KnowledgeLibraryScope.PRIVATE,
              deletedAt: null,
            },
          });
          if (count >= limits.privateMaxLibrariesPerUser) {
            throw new BadRequestException(
              `每人最多创建 ${limits.privateMaxLibrariesPerUser} 个私有知识库`,
            );
          }
        }
        const duplicate = await transaction.knowledgeLibrary.findFirst({
          where: {
            name,
            subjectId: subject.id,
            ownerId,
            scope: input.scope,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (duplicate) {
          throw new BadRequestException('同学科下已存在同名知识库');
        }
        const created = await transaction.knowledgeLibrary.create({
          data: {
            name,
            scope: input.scope,
            ownerId,
            subjectId: subject.id,
            aiEnabled: input.scope === KnowledgeLibraryScope.SHARED,
            aiEnabledAt:
              input.scope === KnowledgeLibraryScope.SHARED ? new Date() : null,
          },
          select: librarySelect,
        });
        for (const key of counterKeys) {
          await transaction.knowledgeCapacityCounter.update({
            where: { key },
            data: { activeLibraries: { increment: 1 } },
          });
        }
        await this.audit.record(
          user.id,
          'knowledge.library.create',
          'KnowledgeLibrary',
          created.id,
          { scope: input.scope, subjectId: subject.id },
          transaction,
        );
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return serializeLibrary(library);
  }

  async update(user: User, id: string, input: UpdateKnowledgeLibraryInput) {
    const library = await this.assertManage(user, id);
    const name =
      input.name === undefined ? undefined : normalizeKnowledgeName(input.name);
    if (name !== undefined && (name.length < 2 || name.length > 160)) {
      throw new BadRequestException('知识库名称必须为 2-160 字');
    }
    const updated = await this.prisma.$transaction(async (transaction) => {
      if (input.active === false) {
        await markQuestionSourcesReviewRequired(transaction, { libraryId: id });
      }
      // Keep the suspension check in the write so a concurrent admin disable wins.
      const changed = await transaction.knowledgeLibrary.updateMany({
        where: {
          id: library.id,
          deletedAt: null,
          ...(input.active === true ? { adminDisabledAt: null } : {}),
        },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
      if (!changed.count) {
        throw new ForbiddenException('知识库已被管理员停用或删除，不能重新启用');
      }
      const result = await transaction.knowledgeLibrary.findUniqueOrThrow({
        where: { id: library.id },
        select: librarySelect,
      });
      await this.audit.record(
        user.id,
        'knowledge.library.update',
        'KnowledgeLibrary',
        id,
        { active: input.active, renamed: name !== undefined },
        transaction,
      );
      return result;
    });
    return serializeLibrary(updated);
  }

  async setPrivateAi(user: User, id: string, enabled: boolean) {
    const library = await this.prisma.knowledgeLibrary.findFirst({
      where: {
        id,
        ownerId: user.id,
        scope: KnowledgeLibraryScope.PRIVATE,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!library) throw new NotFoundException('私有知识库不存在');
    const updated = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.knowledgeLibrary.update({
        where: { id },
        data: {
          aiEnabled: enabled,
          aiEnabledAt: enabled ? new Date() : null,
        },
        select: librarySelect,
      });
      await this.audit.record(
        user.id,
        'knowledge.library.ai-setting',
        'KnowledgeLibrary',
        id,
        { enabled },
        transaction,
      );
      return result;
    });
    return serializeLibrary(updated);
  }

  async privateMetadata(page: number, pageSize: number) {
    const where: Prisma.KnowledgeLibraryWhereInput = {
      scope: KnowledgeLibraryScope.PRIVATE,
      deletedAt: null,
    };
    const [items, total] = await Promise.all([
      this.prisma.knowledgeLibrary.findMany({
        where,
        select: {
          id: true,
          name: true,
          owner: { select: { id: true, displayName: true, status: true } },
          subject: { select: { id: true, name: true } },
          active: true,
          adminDisabledAt: true,
          aiEnabled: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { documents: true, importJobs: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.knowledgeLibrary.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async setPrivateStatus(admin: User, id: string, active: boolean) {
    if (admin.role !== Role.ADMIN) throw new ForbiddenException('仅管理员可执行此操作');
    const changed = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.knowledgeLibrary.updateMany({
        where: {
          id,
          scope: KnowledgeLibraryScope.PRIVATE,
          deletedAt: null,
        },
        data: { active, adminDisabledAt: active ? null : new Date() },
      });
      if (!result.count) throw new NotFoundException('私有知识库不存在');
      if (!active) {
        await markQuestionSourcesReviewRequired(transaction, { libraryId: id });
      }
      await this.audit.record(
        admin.id,
        'knowledge.library.admin-status',
        'KnowledgeLibrary',
        id,
        { active },
        transaction,
      );
      return result;
    });
    return { id, active, updated: changed.count === 1 };
  }

  async remove(user: User, id: string) {
    const library = await this.assertManage(user, id);
    const counterKeys = ['GLOBAL'];
    if (library.scope === KnowledgeLibraryScope.PRIVATE) {
      counterKeys.push('PRIVATE_GLOBAL', `USER:${library.ownerId}`);
    }
    const documents = await this.prisma.knowledgeDocument.findMany({
      where: { libraryId: id, deletedAt: null },
      select: { id: true },
    });
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      await markQuestionSourcesReviewRequired(transaction, { libraryId: id });
      for (const key of counterKeys) {
        await transaction.knowledgeCapacityCounter.upsert({
          where: { key },
          create: { key },
          update: {},
        });
      }
      await transaction.$queryRaw(
        Prisma.sql`
          SELECT ${Prisma.raw('`key`')} FROM KnowledgeCapacityCounter
          WHERE ${Prisma.raw('`key`')} IN (${Prisma.join(counterKeys)}) FOR UPDATE
        `,
      );
      await transaction.knowledgeLibrary.update({
        where: { id },
        data: { active: false, deletedAt: now },
      });
      await transaction.knowledgeDocument.updateMany({
        where: { libraryId: id, deletedAt: null },
        data: {
          status: 'ARCHIVED',
          activeVersionId: null,
          deletedAt: now,
        },
      });
      await transaction.knowledgeImportJob.updateMany({
        where: {
          libraryId: id,
          status: {
            in: [
              'PREFLIGHT_PENDING',
              'PREFLIGHTING',
              'AWAITING_CONFIRMATION',
              'INDEX_PENDING',
              'PROCESSING',
            ],
          },
        },
        data: {
          cancelRequestedAt: now,
          expiresAt: now,
          errorCode: 'LIBRARY_DELETED',
          errorMessage: '知识库已删除',
        },
      });
      for (const document of documents) {
        await transaction.indexJob.upsert({
          where: { idempotencyKey: `delete-document:${document.id}` },
          create: {
            documentId: document.id,
            operation: 'DELETE_DOCUMENT_VECTORS',
            idempotencyKey: `delete-document:${document.id}`,
          },
          update: { status: 'PENDING', leasedUntil: null, error: null },
        });
      }
      await transaction.$executeRaw(
        Prisma.sql`
          UPDATE KnowledgeCapacityCounter
          SET activeLibraries = GREATEST(activeLibraries - 1, 0)
          WHERE ${Prisma.raw('`key`')} IN (${Prisma.join(counterKeys)})
        `,
      );
      await this.audit.record(
        user.id,
        'knowledge.library.delete',
        'KnowledgeLibrary',
        id,
        { scope: library.scope, documentCount: documents.length },
        transaction,
      );
    });
    return { id, deleted: true as const, cleanupPending: documents.length > 0 };
  }

  async assertManage(user: User, id: string) {
    const library = await this.prisma.knowledgeLibrary.findFirst({
      where: { id, deletedAt: null },
    });
    if (!library) throw new NotFoundException('知识库不存在');
    if (library.scope === KnowledgeLibraryScope.PRIVATE) {
      if (library.ownerId !== user.id) {
        throw new ForbiddenException('无权管理该私有知识库');
      }
    } else if (user.role === Role.MEMBER) {
      throw new ForbiddenException('普通成员不能管理共享知识库');
    }
    return library;
  }
}

const librarySelect = {
  id: true,
  name: true,
  scope: true,
  ownerId: true,
  subjectId: true,
  subject: {
    select: { id: true, name: true, slug: true, sortOrder: true, active: true },
  },
  aiEnabled: true,
  aiEnabledAt: true,
  active: true,
  adminDisabledAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { documents: true, chapters: true } },
} satisfies Prisma.KnowledgeLibrarySelect;

function serializeLibrary<T extends { aiEnabledAt: Date | null; adminDisabledAt: Date | null; createdAt: Date; updatedAt: Date }>(library: T) {
  return {
    ...library,
    aiEnabledAt: library.aiEnabledAt?.toISOString() ?? null,
    adminDisabledAt: library.adminDisabledAt?.toISOString() ?? null,
    createdAt: library.createdAt.toISOString(),
    updatedAt: library.updatedAt.toISOString(),
  };
}
