import { NotFoundException } from '@nestjs/common';
import { AiConversationsService } from './ai-conversations.service';

const updatedAt = new Date('2026-08-11T04:00:00.000Z');

function setup(overrides: Record<string, unknown> = {}) {
  const transaction = {
    aiConversation: {
      findFirst: jest.fn().mockResolvedValue({ id: 'conversation-1' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const prisma = {
    aiConversation: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
    aiMessage: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (action) => action(transaction)),
    ...overrides,
  };
  const audit = {
    record: jest.fn(async (...args: unknown[]) => {
      await transaction.auditLog.create({ data: args });
    }),
  };
  return {
    prisma,
    transaction,
    audit,
    service: new AiConversationsService(prisma as never, audit as never),
  };
}

describe('AiConversationsService', () => {
  it('lists only the current user with bounded keyset pagination', async () => {
    const row = {
      id: 'conversation-1',
      title: '细胞膜运输',
      subjectId: 'subject-1',
      knowledgeMode: 'SHARED',
      createdAt: updatedAt,
      updatedAt,
      subject: { id: 'subject-1', name: '细胞生物学' },
      libraries: [
        { library: { id: 'library-1', name: '教材', scope: 'SHARED' } },
      ],
      _count: { messages: 2 },
    };
    const { prisma, service } = setup();
    prisma.aiConversation.findMany.mockResolvedValue([
      row,
      { ...row, id: 'conversation-overflow' },
    ]);

    const result = await service.list('user-1', undefined, 1);

    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'conversation-1',
        messageCount: 2,
        libraries: [expect.objectContaining({ id: 'library-1' })],
      }),
    ]);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(prisma.aiConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        take: 2,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('returns a bounded owner-only message history', async () => {
    const { prisma, service } = setup();
    prisma.aiConversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      title: '会话',
      subjectId: null,
      knowledgeMode: null,
      createdAt: updatedAt,
      updatedAt,
      subject: null,
      libraries: [],
      libraryChapters: [],
      _count: { messages: 1 },
    });
    prisma.aiMessage.findMany.mockResolvedValue([
      {
        id: 'message-1',
        role: 'user',
        content: '问题',
        citations: null,
        attachments: null,
        model: null,
        createdAt: updatedAt,
      },
    ]);

    await expect(service.detail('user-1', 'conversation-1')).resolves.toEqual(
      expect.objectContaining({
        id: 'conversation-1',
        messages: [expect.objectContaining({ id: 'message-1' })],
        hasEarlierMessages: false,
      }),
    );
    expect(prisma.aiConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conversation-1', userId: 'user-1' },
      }),
    );
    expect(prisma.aiMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 201 }),
    );
  });

  it('deletes only an owned conversation and records the mutation atomically', async () => {
    const { service, transaction, audit } = setup();

    await expect(
      service.remove('user-1', 'conversation-1'),
    ).resolves.toEqual({ id: 'conversation-1', deleted: true });
    expect(transaction.aiConversation.deleteMany).toHaveBeenCalledWith({
      where: { id: 'conversation-1', userId: 'user-1' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      'user-1',
      'ai.conversation.delete',
      'AiConversation',
      'conversation-1',
      undefined,
      transaction,
    );
  });

  it('does not reveal or delete another user conversation', async () => {
    const { service, transaction } = setup();
    transaction.aiConversation.findFirst.mockResolvedValue(null);

    await expect(
      service.remove('user-1', 'conversation-foreign'),
    ).rejects.toThrow(NotFoundException);
    expect(transaction.aiConversation.deleteMany).not.toHaveBeenCalled();
  });
});
