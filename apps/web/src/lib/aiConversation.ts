import type {
  AiConversationMessage,
  ChatMessage,
  KnowledgeCitation,
  KnowledgeImageAttachment,
} from '../types';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, key: string) {
  return typeof value[key] === 'string';
}

function knowledgeCitation(value: unknown): value is KnowledgeCitation {
  const item = record(value);
  if (!item || typeof item.index !== 'number') return false;
  const required = [
    'libraryId',
    'libraryName',
    'documentId',
    'documentVersionId',
    'libraryChapterId',
    'nodeId',
    'nodeTitle',
    'nodeTitleMarkdown',
    'renderBlockId',
  ];
  if (!required.every((key) => stringField(item, key))) return false;
  if (!Array.isArray(item.headingPath)) return false;
  return item.headingPath.every((heading) => {
    const path = record(heading);
    return Boolean(
      path
      && typeof path.level === 'number'
      && stringField(path, 'nodeId')
      && stringField(path, 'title')
      && stringField(path, 'titleMarkdown'),
    );
  });
}

function imageAttachment(value: unknown): value is KnowledgeImageAttachment {
  const item = record(value);
  return Boolean(
    item
    && item.type === 'image'
    && stringField(item, 'photoId')
    && stringField(item, 'url')
    && stringField(item, 'altText')
    && stringField(item, 'documentId')
    && (item.citationIndex === undefined || typeof item.citationIndex === 'number'),
  );
}

/** Converts persisted JSON fields into the narrower live chat rendering model. */
export function conversationMessages(messages: AiConversationMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const citations = Array.isArray(message.citations)
      ? message.citations.filter(knowledgeCitation)
      : [];
    const images = Array.isArray(message.attachments)
      ? message.attachments.filter(imageAttachment)
      : [];
    return [{
      role: message.role,
      content: message.content,
      ...(citations.length ? { citations } : {}),
      ...(images.length ? { images } : {}),
      ...(message.role === 'assistant' ? { status: 'done' as const } : {}),
    }];
  });
}
