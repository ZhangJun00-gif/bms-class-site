import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import {
  decodeTimeIdCursor,
  encodeTimeIdCursor,
} from '../common/keyset-cursor';
import { PrismaService } from '../database/prisma.service';

const CONVERSATION_MESSAGE_LIMIT = 200;

@Injectable()
export class AiConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string, cursorValue?: string, pageSize = 20) {
    const cursor = cursorValue ? decodeTimeIdCursor(cursorValue) : null;
    const rows = await this.prisma.aiConversation.findMany({
      where: {
        userId,
        ...(cursor
          ? {
              OR: [
                { updatedAt: { lt: cursor.timestamp } },
                { updatedAt: cursor.timestamp, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        title: true,
        subjectId: true,
        knowledgeMode: true,
        createdAt: true,
        updatedAt: true,
        subject: { select: { id: true, name: true } },
        libraries: {
          orderBy: { createdAt: 'asc' },
          select: {
            library: { select: { id: true, name: true, scope: true } },
          },
        },
        _count: { select: { messages: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
    });
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const items = page.map(({ libraries, _count, ...conversation }) => ({
      ...conversation,
      libraries: libraries.map((item) => item.library),
      messageCount: _count.messages,
    }));
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeTimeIdCursor(last.updatedAt, last.id)
          : null,
    };
  }

  async detail(userId: string, id: string) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id, userId },
      select: {
        id: true,
        title: true,
        subjectId: true,
        knowledgeMode: true,
        createdAt: true,
        updatedAt: true,
        subject: { select: { id: true, name: true } },
        libraries: {
          orderBy: { createdAt: 'asc' },
          select: {
            library: { select: { id: true, name: true, scope: true } },
          },
        },
        libraryChapters: {
          orderBy: { createdAt: 'asc' },
          select: {
            libraryChapter: {
              select: { id: true, name: true, libraryId: true },
            },
          },
        },
        _count: { select: { messages: true } },
      },
    });
    if (!conversation) throw new NotFoundException('问答会话不存在');
    const messages = await this.prisma.aiMessage.findMany({
      where: { conversationId: id },
      select: {
        id: true,
        role: true,
        content: true,
        citations: true,
        attachments: true,
        model: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CONVERSATION_MESSAGE_LIMIT + 1,
    });
    const hasEarlierMessages = messages.length > CONVERSATION_MESSAGE_LIMIT;
    const visibleMessages = messages
      .slice(0, CONVERSATION_MESSAGE_LIMIT)
      .reverse();
    const { libraries, libraryChapters, _count, ...base } = conversation;
    return {
      ...base,
      libraries: libraries.map((item) => item.library),
      libraryChapters: libraryChapters.map((item) => item.libraryChapter),
      messages: visibleMessages,
      messageCount: _count.messages,
      hasEarlierMessages,
    };
  }

  async remove(userId: string, id: string) {
    return this.prisma.$transaction(async (transaction) => {
      const conversation = await transaction.aiConversation.findFirst({
        where: { id, userId },
        select: { id: true },
      });
      if (!conversation) throw new NotFoundException('问答会话不存在');
      const deleted = await transaction.aiConversation.deleteMany({
        where: { id, userId },
      });
      if (deleted.count !== 1) throw new NotFoundException('问答会话不存在');
      await this.audit.record(
        userId,
        'ai.conversation.delete',
        'AiConversation',
        id,
        undefined,
        transaction,
      );
      return { id, deleted: true as const };
    });
  }
}
