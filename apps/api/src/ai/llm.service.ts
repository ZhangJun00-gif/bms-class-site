import {
  BadGatewayException,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  AiClient,
  AiClientError,
  readAiRuntimeConfig,
  type AiRequest,
} from '@bmc3/ai-core';
import {
  AiGatewayService,
  type AiInvocationContext,
} from './ai-gateway.service';

export interface RetrievedSource {
  id: string;
  libraryName: string;
  breadcrumb: string;
  content: string;
}

@Injectable()
export class LlmService {
  private readonly config = readAiRuntimeConfig(process.env);
  private readonly client = new AiClient(this.config);

  constructor(
    @Optional() private readonly gateway?: AiGatewayService,
  ) {}

  get model() {
    return this.gateway?.model('FLASH_NO_THINKING') ??
      this.client.model('FLASH_NO_THINKING');
  }

  async *stream(
    question: string,
    sources: RetrievedSource[],
    signal?: AbortSignal,
    context?: Partial<AiInvocationContext>,
  ): AsyncGenerator<string> {
    const evidence = sources
      .map(
        (source, index) =>
          `[${index + 1}] ${source.libraryName} > ${source.breadcrumb}\n${source.content}`,
      )
      .join('\n\n');
    const mockContent = `根据所选知识库中的资料，关于“${question}”可以先从以下内容理解：\n\n${sources
      .map(
        (source, index) =>
          `资料 ${index + 1}（${source.libraryName} > ${source.breadcrumb}）：${source.content.slice(0, 180)}`,
      )
      .join('\n')}\n\n请结合课程教材核对原文；本回答仅供学习，不构成诊疗建议。`;
    const request: AiRequest = {
      taskType: 'CHAT_QA',
      strategy: 'FLASH_NO_THINKING',
      promptVersion: 'knowledge-chat-v2',
      maxOutputTokens: 2_000,
      timeoutMs: readTimeout('AI_CHAT_TIMEOUT_MS', 'LLM_REQUEST_TIMEOUT_MS', 60_000),
      temperature: 0.2,
      signal,
      mockContent,
      messages: [
        {
          role: 'system',
          content:
            '你是班级知识库助手。只能依据给定资料回答并标注[序号]；证据不足时明确拒答。不要提供诊断或治疗建议。不要输出思考过程。',
        },
        { role: 'user', content: `资料：\n${evidence}\n\n问题：${question}` },
      ],
    };
    try {
      const stream = this.gateway
        ? this.gateway.stream(request, {
            correlationType: context?.correlationType ?? 'AiConversation',
            correlationId: context?.correlationId ?? 'untracked-chat',
            requestedById: context?.requestedById,
            attempt: context?.attempt,
          })
        : this.client.stream(request);
      for await (const event of stream) {
        if (event.type === 'token') yield event.text;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof BadGatewayException) throw error;
      if (error instanceof AiClientError) {
        throw new BadGatewayException(error.message);
      }
      throw new BadGatewayException('模型服务暂时不可用');
    }
  }
}

function readTimeout(primary: string, legacy: string, fallback: number) {
  const value = Number(process.env[primary] ?? process.env[legacy] ?? fallback);
  return Number.isInteger(value) && value >= 1_000 && value <= 120_000
    ? value
    : fallback;
}
