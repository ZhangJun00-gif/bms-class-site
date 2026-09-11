import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { AccountStatus, Prisma, Role, type User } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '../common/keyset-cursor';
import { PrismaService } from '../database/prisma.service';
import {
  AdminAnnouncementPageQuery, AnnouncementDraftDto, AnnouncementPageQuery, AnnouncementUpdateDto,
} from './announcements.dto';

const summarySelect = {
  id: true, title: true, status: true, revision: true,
  createdAt: true, updatedAt: true, publishedAt: true, withdrawnAt: true,
} satisfies Prisma.AnnouncementSelect;
const detailSelect = { ...summarySelect, body: true } satisfies Prisma.AnnouncementSelect;

@Injectable()
export class AnnouncementsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async status(user: User) {
    const latest = await this.prisma.announcement.findFirst({
      where: { status: 'PUBLISHED' }, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      select: { ...detailSelect, reads: { where: { userId: user.id }, select: { readAt: true } } },
    });
    return { latest: latest ? this.memberResult(latest) : null };
  }

  async history(user: User, query: AnnouncementPageQuery) {
    const cursor = query.cursor ? decodeTimeIdCursor(query.cursor) : null;
    const rows = await this.prisma.announcement.findMany({
      where: {
        status: 'PUBLISHED',
        ...(cursor ? { OR: [
          { publishedAt: { lt: cursor.timestamp } },
          { publishedAt: cursor.timestamp, id: { lt: cursor.id } },
        ] } : {}),
      },
      select: { ...summarySelect, reads: { where: { userId: user.id }, select: { readAt: true } } },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], take: query.pageSize + 1,
    });
    const items = rows.slice(0, query.pageSize);
    const last = items.at(-1);
    return {
      items: items.map((item) => this.memberResult(item)),
      nextCursor: rows.length > query.pageSize && last?.publishedAt ? encodeTimeIdCursor(last.publishedAt, last.id) : null,
    };
  }

  async detail(user: User, id: string) {
    const item = await this.prisma.announcement.findFirst({
      where: { id, status: 'PUBLISHED' },
      select: { ...detailSelect, reads: { where: { userId: user.id }, select: { readAt: true } } },
    });
    if (!item) throw new NotFoundException('公告不存在或已撤回');
    return this.memberResult(item);
  }

  async acknowledge(user: User, id: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`SELECT id FROM Announcement WHERE id = ${id} FOR UPDATE`);
      const item = await transaction.announcement.findFirst({ where: { id, status: 'PUBLISHED' }, select: { id: true } });
      if (!item) throw new NotFoundException('公告不存在或已撤回，请刷新最新公告');
      const receipt = await transaction.announcementRead.upsert({
        where: { userId_announcementId: { userId: user.id, announcementId: id } },
        create: { userId: user.id, announcementId: id }, update: {}, select: { readAt: true },
      });
      return { id, readAt: receipt.readAt };
    });
  }

  async adminList(user: User, query: AdminAnnouncementPageQuery) {
    this.assertAdmin(user);
    const cursor = query.cursor ? decodeTimeIdCursor(query.cursor) : null;
    const rows = await this.prisma.announcement.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.keyword?.trim() ? { title: { contains: query.keyword.trim() } } : {}),
        ...(cursor ? { OR: [
          { createdAt: { lt: cursor.timestamp } },
          { createdAt: cursor.timestamp, id: { lt: cursor.id } },
        ] } : {}),
      },
      select: summarySelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.pageSize + 1,
    });
    const items = rows.slice(0, query.pageSize);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > query.pageSize && last ? encodeTimeIdCursor(last.createdAt, last.id) : null };
  }

  async adminDetail(user: User, id: string) {
    this.assertAdmin(user);
    const item = await this.prisma.announcement.findUnique({ where: { id }, select: detailSelect });
    if (!item) throw new NotFoundException('公告不存在');
    return item;
  }

  async create(user: User, dto: AnnouncementDraftDto) {
    this.assertAdmin(user);
    const content = this.content(dto);
    return this.prisma.$transaction(async (transaction) => {
      const item = await transaction.announcement.create({ data: { ...content, createdById: user.id }, select: detailSelect });
      await this.audit.record(user.id, 'announcement.create', 'Announcement', item.id, {}, transaction);
      return item;
    });
  }

  async update(user: User, id: string, dto: AnnouncementUpdateDto) {
    this.assertAdmin(user);
    const content = this.content(dto);
    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.announcement.updateMany({
        where: { id, status: 'DRAFT', revision: dto.expectedRevision },
        data: { ...content, revision: { increment: 1 } },
      });
      if (!changed.count) throw this.conflict();
      await this.audit.record(user.id, 'announcement.update', 'Announcement', id, { revision: dto.expectedRevision + 1 }, transaction);
      return transaction.announcement.findUniqueOrThrow({ where: { id }, select: detailSelect });
    });
  }

  async publish(user: User, id: string, expectedRevision: number) {
    this.assertAdmin(user);
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`SELECT id FROM Announcement WHERE id = ${id} FOR UPDATE`);
      const item = await transaction.announcement.findUnique({ where: { id }, select: detailSelect });
      if (!item) throw new NotFoundException('公告不存在');
      if (item.status === 'PUBLISHED' && item.revision === expectedRevision + 1) return item;
      if (item.status !== 'DRAFT' || item.revision !== expectedRevision) throw this.conflict();
      this.content(item);
      const updated = await transaction.announcement.update({
        where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: user.id, revision: { increment: 1 } },
        select: detailSelect,
      });
      await this.audit.record(user.id, 'announcement.publish', 'Announcement', id, { revision: updated.revision }, transaction);
      return updated;
    });
  }

  async withdraw(user: User, id: string, expectedRevision: number) {
    this.assertAdmin(user);
    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.announcement.updateMany({
        where: { id, status: 'PUBLISHED', revision: expectedRevision },
        data: { status: 'WITHDRAWN', withdrawnAt: new Date(), revision: { increment: 1 } },
      });
      if (!changed.count) throw this.conflict();
      await this.audit.record(user.id, 'announcement.withdraw', 'Announcement', id, {}, transaction);
      return transaction.announcement.findUniqueOrThrow({ where: { id }, select: detailSelect });
    });
  }

  async deleteDraft(user: User, id: string, expectedRevision: number) {
    this.assertAdmin(user);
    return this.prisma.$transaction(async (transaction) => {
      const deleted = await transaction.announcement.deleteMany({ where: { id, status: 'DRAFT', revision: expectedRevision } });
      if (!deleted.count) throw this.conflict();
      await this.audit.record(user.id, 'announcement.delete-draft', 'Announcement', id, {}, transaction);
      return { id, deleted: true };
    });
  }

  private memberResult<T extends { reads: Array<{ readAt: Date }> }>(item: T) {
    const { reads, ...rest } = item;
    return { ...rest, readAt: reads[0]?.readAt ?? null };
  }

  private content(dto: AnnouncementDraftDto) {
    const title = dto.title.trim();
    const body = dto.body.trim();
    if (!title || title.length > 160 || !body || body.length > 20_000) {
      throw new BadRequestException('公告标题须为 1-160 字，正文须为 1-20000 字');
    }
    return { title, body };
  }

  private assertAdmin(user: User) {
    if (user.role !== Role.ADMIN || user.status !== AccountStatus.ACTIVE) throw new ForbiddenException('仅管理员可管理公告');
  }

  private conflict() {
    return new ConflictException('公告已被修改或状态已改变，请刷新后重试');
  }
}
