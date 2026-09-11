import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { KNOWLEDGE_VECTOR_SCHEMA_VERSION } from '@bmc3/knowledge-core';
import { QdrantClient } from '@qdrant/js-client-rest';
import { KnowledgeConversationMode, KnowledgeLibraryScope } from '@prisma/client';

const DEFAULT_COLLECTION = 'bmc3_knowledge_embedding3_1024_v1';

export interface KnowledgeVectorSearchScope {
  subjectId: string;
  mode: KnowledgeConversationMode;
  libraryIds: string[];
  libraryChapterIds: string[];
  userId: string;
  embeddingModel: string;
}

export interface KnowledgeVectorCandidate {
  chunkId: string;
  contentHash: string;
  score: number;
}

@Injectable()
export class KnowledgeVectorService {
  private client: QdrantClient | null = null;

  async setVersionActive(versionId: string, active: boolean) {
    const { client, collection } = this.runtime();
    try {
      await client.setPayload(collection, {
        wait: true,
        payload: { active },
        filter: {
          must: [
            { key: 'documentVersionId', match: { value: versionId } },
          ],
        },
      });
    } catch {
      throw new ServiceUnavailableException('向量索引暂时不可用，请稍后重试');
    }
  }

  async deleteVersion(versionId: string) {
    const { client, collection } = this.runtime();
    await client.delete(collection, {
      wait: true,
      filter: {
        must: [
          { key: 'documentVersionId', match: { value: versionId } },
        ],
      },
    });
  }

  async collectionInfo() {
    const { client, collection } = this.runtime();
    const [info, count, aliases] = await Promise.all([
      client.getCollection(collection),
      client.count(collection, { exact: true }),
      client.getAliases(),
    ]);
    return { collection, info, count: count.count, aliases: aliases.aliases ?? [] };
  }

  async readiness() {
    const { collection, info, aliases } = await this.collectionInfo();
    const expectedAlias = process.env.QDRANT_COLLECTION_ALIAS?.trim();
    if (!expectedAlias) throw new Error('QDRANT_ALIAS_NOT_CONFIGURED');
    const alias = aliases.find(
      (item) =>
        item.alias_name === expectedAlias ||
        ('aliasName' in item && item.aliasName === expectedAlias),
    ) as
      | { collection_name?: string; collectionName?: string }
      | undefined;
    const aliasCollection = alias?.collection_name ?? alias?.collectionName;
    const details = info as unknown as {
      status?: string;
      config?: {
        params?: { vectors?: { size?: number; distance?: string } };
      };
      payload_schema?: Record<string, unknown>;
    };
    const expectedDimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);
    const requiredPayloadIndexes = [
      'active',
      'documentVersionId',
      'schemaVersion',
      'embeddingModel',
      'subjectId',
      'libraryId',
      'scope',
      'ownerId',
      'libraryChapterId',
      'documentId',
    ];
    const payloadSchema = details.payload_schema ?? {};
    const ready =
      aliasCollection === collection &&
      details.status !== 'red' &&
      details.config?.params?.vectors?.size === expectedDimensions &&
      String(details.config?.params?.vectors?.distance).toLowerCase() ===
        'cosine' &&
      requiredPayloadIndexes.every((field) => field in payloadSchema);
    if (!ready) throw new Error('QDRANT_COLLECTION_NOT_READY');
    return {
      collection,
      alias: expectedAlias,
      status: details.status ?? 'unknown',
      dimensions: expectedDimensions,
    };
  }

  async search(
    vector: number[],
    scope: KnowledgeVectorSearchScope,
    signal?: AbortSignal,
  ): Promise<KnowledgeVectorCandidate[]> {
    const runtime = this.searchRuntime();
    const must: Array<Record<string, unknown>> = [
      { key: 'subjectId', match: { value: scope.subjectId } },
      { key: 'libraryId', match: { any: scope.libraryIds } },
      { key: 'active', match: { value: true } },
      {
        key: 'schemaVersion',
        match: { value: KNOWLEDGE_VECTOR_SCHEMA_VERSION },
      },
      { key: 'embeddingModel', match: { value: scope.embeddingModel } },
    ];
    if (scope.libraryChapterIds.length) {
      must.push({
        key: 'libraryChapterId',
        match: { any: scope.libraryChapterIds },
      });
    }
    if (scope.mode === KnowledgeConversationMode.SHARED) {
      must.push({
        key: 'scope',
        match: { value: KnowledgeLibraryScope.SHARED },
      });
    } else if (scope.mode === KnowledgeConversationMode.PRIVATE) {
      must.push(
        { key: 'scope', match: { value: KnowledgeLibraryScope.PRIVATE } },
        { key: 'ownerId', match: { value: scope.userId } },
      );
    }
    const filter: Record<string, unknown> = { must };
    if (scope.mode === KnowledgeConversationMode.COMBINED) {
      filter.should = [
        {
          must: [
            { key: 'scope', match: { value: KnowledgeLibraryScope.SHARED } },
          ],
        },
        {
          must: [
            { key: 'scope', match: { value: KnowledgeLibraryScope.PRIVATE } },
            { key: 'ownerId', match: { value: scope.userId } },
          ],
        },
      ];
      filter.min_should = { conditions: filter.should, min_count: 1 };
      delete filter.should;
    }

    const request = linkedAbortSignal(signal, runtime.timeout);
    try {
      const response = await fetch(
        `${runtime.url}/collections/${encodeURIComponent(runtime.collection)}/points/search`,
        {
          method: 'POST',
          headers: {
            'api-key': runtime.apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            vector,
            filter,
            limit: 30,
            with_payload: ['chunkId', 'contentHash'],
            with_vector: false,
          }),
          signal: request.signal,
        },
      );
      if (!response.ok) throw new Error(`QDRANT_SEARCH_HTTP_${response.status}`);
      const body = (await response.json()) as {
        result?: Array<{
          score?: number;
          payload?: Record<string, unknown> | null;
        }>;
      };
      if (!Array.isArray(body.result)) throw new Error('QDRANT_SEARCH_INVALID');
      return body.result.map((point) => {
        const chunkId = point.payload?.chunkId;
        const contentHash = point.payload?.contentHash;
        if (
          typeof chunkId !== 'string' ||
          typeof contentHash !== 'string' ||
          !Number.isFinite(point.score)
        ) {
          throw new Error('QDRANT_PAYLOAD_INVALID');
        }
        return { chunkId, contentHash, score: point.score! };
      });
    } catch (error) {
      if (isAbortError(error) && signal?.aborted) throw error;
      throw new ServiceUnavailableException(
        '向量索引暂时不可用，请稍后重试',
      );
    } finally {
      request.dispose();
    }
  }

  private runtime() {
    const url = process.env.QDRANT_URL?.trim();
    const apiKey = process.env.QDRANT_API_KEY?.trim();
    if (!url || !apiKey) {
      throw new ServiceUnavailableException('向量索引运行时配置不完整');
    }
    this.client ??= new QdrantClient({
      url,
      apiKey,
      timeout: Number(process.env.QDRANT_REQUEST_TIMEOUT_MS ?? 10_000),
    });
    return {
      client: this.client,
      collection: process.env.QDRANT_COLLECTION?.trim() || DEFAULT_COLLECTION,
    };
  }

  private searchRuntime() {
    const url = process.env.QDRANT_URL?.trim().replace(/\/+$/u, '');
    const apiKey = process.env.QDRANT_API_KEY?.trim();
    if (!url || !apiKey) {
      throw new ServiceUnavailableException('向量索引运行时配置不完整');
    }
    const timeout = Number(process.env.QDRANT_REQUEST_TIMEOUT_MS ?? 10_000);
    return {
      url,
      apiKey,
      timeout,
      collection:
        process.env.QDRANT_COLLECTION_ALIAS?.trim() ||
        process.env.QDRANT_COLLECTION?.trim() ||
        DEFAULT_COLLECTION,
    };
  }
}

function linkedAbortSignal(source: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(source?.reason);
  if (source?.aborted) abort();
  else source?.addEventListener('abort', abort, { once: true });
  const safeTimeout =
    Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 60_000
      ? timeoutMs
      : 10_000;
  const timeout = setTimeout(() => controller.abort(), safeTimeout);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      source?.removeEventListener('abort', abort);
    },
  };
}

function isAbortError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}
