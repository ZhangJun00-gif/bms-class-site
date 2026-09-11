import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  createKnowledgeEmbeddingProvider,
  type KnowledgeEmbeddingProvider,
} from '@bmc3/knowledge-core';

@Injectable()
export class EmbeddingService {
  private provider: KnowledgeEmbeddingProvider | null = null;

  get model() {
    return this.runtime().model;
  }

  get dimensions() {
    return this.runtime().dimensions;
  }

  async embedQuestion(question: string, signal?: AbortSignal) {
    try {
      const [vector] = await this.runtime().embed([question], { signal });
      if (!vector) throw new Error('EMBEDDING_COUNT_MISMATCH');
      return vector;
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ServiceUnavailableException(
        '问题向量服务暂时不可用，请稍后重试',
      );
    }
  }

  private runtime() {
    this.provider ??= createKnowledgeEmbeddingProvider({
      provider: process.env.EMBEDDING_PROVIDER?.trim() || 'mock',
      model: process.env.EMBEDDING_MODEL?.trim() || 'embedding-3',
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1_024),
      baseUrl: process.env.EMBEDDING_BASE_URL,
      apiKey: process.env.EMBEDDING_API_KEY,
      timeoutMs: Number(process.env.EMBEDDING_REQUEST_TIMEOUT_MS ?? 30_000),
    });
    return this.provider;
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
