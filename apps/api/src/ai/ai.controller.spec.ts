import { EventEmitter } from 'node:events';
import { AiController } from './ai.controller';

function responseMock() {
  return Object.assign(new EventEmitter(), {
    headersSent: false,
    writableEnded: false,
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(function (this: { headersSent: boolean }) {
      this.headersSent = true;
    }),
    write: jest.fn(function (this: { headersSent: boolean }) {
      this.headersSent = true;
      return true;
    }),
    end: jest.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
  });
}

const prepared = {
  scope: {
    conversationId: 'conversation-1',
    subjectId: 'subject-1',
    mode: 'SHARED',
    libraryIds: ['library-1'],
    libraryChapterIds: [],
  },
  question: '问题',
  evidence: [],
  citations: [],
  images: [],
};

describe('AiController SSE lifecycle', () => {
  it('persists the complete answer before emitting done', async () => {
    const events: string[] = [];
    const knowledge = {
      prepare: jest.fn().mockResolvedValue(prepared),
      revalidate: jest.fn().mockResolvedValue(undefined),
      async *stream() {
        yield '第一段';
        yield '第二段';
      },
      persistAssistant: jest.fn(async () => {
        events.push('persist');
      }),
    };
    const response = responseMock();
    response.write.mockImplementation((value?: string) => {
      events.push(String(value).includes('event: token') ? 'token' : 'meta');
      response.headersSent = true;
      return true;
    });
    response.end.mockImplementation((value?: string) => {
      if (value?.includes('event: done')) events.push('done');
      response.writableEnded = true;
    });
    const controller = new AiController(knowledge as never);

    await controller.chat(
      {
        question: '问题',
        subjectId: 'subject-1',
        knowledgeMode: 'SHARED',
        libraryIds: ['library-1'],
      },
      { id: 'user-1' } as never,
      response as never,
    );

    expect(knowledge.persistAssistant).toHaveBeenCalledWith(
      prepared,
      '第一段第二段',
    );
    expect(events).toEqual(['meta', 'token', 'token', 'persist', 'done']);
  });

  it('does not persist a partial assistant after the client disconnects', async () => {
    const response = responseMock();
    const knowledge = {
      prepare: jest.fn().mockResolvedValue(prepared),
      revalidate: jest.fn().mockResolvedValue(undefined),
      async *stream() {
        yield '部分内容';
        response.emit('close');
        yield '不应继续';
      },
      persistAssistant: jest.fn(),
    };
    const controller = new AiController(knowledge as never);

    await controller.chat(
      { question: '问题', conversationId: 'conversation-1' },
      { id: 'user-1' } as never,
      response as never,
    );

    expect(knowledge.persistAssistant).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalledWith();
  });

  it('emits a stable error event when upstream streaming fails', async () => {
    const response = responseMock();
    const knowledge = {
      prepare: jest.fn().mockResolvedValue(prepared),
      revalidate: jest.fn().mockResolvedValue(undefined),
      async *stream() {
        throw new Error('provider secret response');
        yield '';
      },
      persistAssistant: jest.fn(),
    };
    const controller = new AiController(knowledge as never);

    await controller.chat(
      { question: '问题', conversationId: 'conversation-1' },
      { id: 'user-1' } as never,
      response as never,
    );

    expect(response.end).toHaveBeenCalledWith(
      expect.stringContaining('"code":"AI_STREAM_FAILED"'),
    );
    expect(response.end).not.toHaveBeenCalledWith(
      expect.stringContaining('provider secret response'),
    );
    expect(knowledge.persistAssistant).not.toHaveBeenCalled();
  });
});
