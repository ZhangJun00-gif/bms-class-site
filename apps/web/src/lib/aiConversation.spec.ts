import { describe, expect, it } from 'vitest';
import type { AiConversationMessage } from '../types';
import { conversationMessages } from './aiConversation';

function message(
  id: string,
  role: string,
  content: string,
  overrides: Partial<AiConversationMessage> = {},
): AiConversationMessage {
  return {
    id,
    role,
    content,
    citations: null,
    attachments: null,
    model: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('conversationMessages', () => {
  it('restores only renderable roles and validated citation/image payloads', () => {
    const restored = conversationMessages([
      message('system-1', 'system', 'internal prompt'),
      message('user-1', 'user', '请解释心动周期'),
      message('assistant-1', 'assistant', '心动周期包括多个阶段。', {
        citations: [
          {
            index: 1,
            libraryId: 'library-1',
            libraryName: '生理学教材',
            documentId: 'document-1',
            documentVersionId: 'version-1',
            libraryChapterId: 'chapter-1',
            nodeId: 'node-1',
            nodeTitle: '心动周期',
            nodeTitleMarkdown: '心动周期',
            renderBlockId: 'block-1',
            headingPath: [{
              level: 2,
              nodeId: 'node-1',
              title: '心动周期',
              titleMarkdown: '心动周期',
            }],
          },
          { index: 2, libraryName: '字段不完整' },
        ],
        attachments: [
          {
            type: 'image',
            photoId: 'photo-1',
            url: '/api/v1/media/images/photo-1/content',
            altText: '心动周期示意图',
            documentId: 'document-1',
            citationIndex: 1,
          },
          { type: 'file', url: '/unsafe' },
        ],
      }),
    ]);

    expect(restored).toHaveLength(2);
    expect(restored[0]).toEqual({ role: 'user', content: '请解释心动周期' });
    expect(restored[1]).toMatchObject({
      role: 'assistant',
      content: '心动周期包括多个阶段。',
      status: 'done',
    });
    expect(restored[1]?.citations).toHaveLength(1);
    expect(restored[1]?.images).toHaveLength(1);
  });

  it('treats malformed persisted JSON as empty optional rendering data', () => {
    const restored = conversationMessages([
      message('assistant-1', 'assistant', '历史回答', {
        citations: { unexpected: true },
        attachments: ['invalid'],
      }),
    ]);

    expect(restored).toEqual([{
      role: 'assistant',
      content: '历史回答',
      status: 'done',
    }]);
  });
});
