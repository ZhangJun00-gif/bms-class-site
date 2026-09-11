import { Body, Controller, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { KnowledgeConversationMode, type User } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import type { Response } from 'express';
import { CurrentUser } from '../common/auth';
import {
  AiKnowledgeService,
  type KnowledgeChatInput,
} from './ai-knowledge.service';

class ChatDto implements KnowledgeChatInput {
  @IsString() @Length(2, 2_000) question!: string;
  @IsOptional() @IsString() @Length(1, 191) conversationId?: string;
  @IsOptional() @IsString() @Length(1, 191) subjectId?: string;
  @IsOptional() @IsEnum(KnowledgeConversationMode)
  knowledgeMode?: KnowledgeConversationMode;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  libraryIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true })
  libraryChapterIds?: string[];
}

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly knowledge: AiKnowledgeService) {}

  @Post('chat')
  async chat(
    @Body() dto: ChatDto,
    @CurrentUser() user: User,
    @Res() response: Response,
  ) {
    const controller = new AbortController();
    let completed = false;
    const onClose = () => {
      if (!completed) controller.abort();
    };
    response.once('close', onClose);
    try {
      const prepared = await this.knowledge.prepare(
        dto,
        user,
        controller.signal,
      );
      await this.knowledge.revalidate(prepared, user);
      throwIfAborted(controller.signal);
      response.status(200);
      response.setHeader('content-type', 'text/event-stream; charset=utf-8');
      response.setHeader('cache-control', 'no-cache, no-transform');
      response.setHeader('x-accel-buffering', 'no');
      response.flushHeaders?.();
      response.write(
        sse('meta', {
          conversationId: prepared.scope.conversationId,
          citations: prepared.citations,
          images: prepared.images,
        }),
      );
      let answer = '';
      for await (const token of this.knowledge.stream(
        prepared,
        user,
        controller.signal,
      )) {
        throwIfAborted(controller.signal);
        answer += token;
        response.write(sse('token', { text: token }));
      }
      throwIfAborted(controller.signal);
      if (!answer.trim()) throw new Error('AI_EMPTY_RESPONSE');
      await this.knowledge.persistAssistant(prepared, answer);
      throwIfAborted(controller.signal);
      completed = true;
      response.end(sse('done', {}));
    } catch (error) {
      if (isAbortError(error)) {
        if (!response.writableEnded) response.end();
        return;
      }
      if (!response.headersSent) throw error;
      completed = true;
      response.end(
        sse('error', {
          code: 'AI_STREAM_FAILED',
          message: '回答生成失败，请稍后重试',
        }),
      );
    } finally {
      response.off('close', onClose);
    }
  }
}

function sse(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  }
}

function isAbortError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}
