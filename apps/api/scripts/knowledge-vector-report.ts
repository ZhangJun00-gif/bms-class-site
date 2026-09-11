import {
  deterministicUuid,
  KNOWLEDGE_VECTOR_SCHEMA_VERSION,
} from '@bmc3/knowledge-core';
import { PrismaClient } from '@prisma/client';
import { QdrantClient } from '@qdrant/js-client-rest';

const prisma = new PrismaClient();
const url = required('QDRANT_URL');
const apiKey = required('QDRANT_API_KEY');
const collection = process.env.QDRANT_COLLECTION?.trim() ||
  'bmc3_knowledge_embedding3_1024_v1';
const alias = process.env.QDRANT_COLLECTION_ALIAS?.trim() ||
  'bmc3_knowledge_active';
const qdrant = new QdrantClient({ url, apiKey });
const schemaVersion = KNOWLEDGE_VECTOR_SCHEMA_VERSION;
const embeddingModel = required('EMBEDDING_MODEL');
const sampleLimit = 100;

async function main() {
  const [collectionInfo, aliases, qdrantPoints] = await Promise.all([
    qdrant.getCollection(collection),
    qdrant.getAliases(),
    readQdrantPoints(),
  ]);
  const qdrantById = new Map(
    qdrantPoints.map((point) => [String(point.id), point.payload ?? {}]),
  );
  const expectedIds = new Set<string>();
  const missing: Array<{ pointId: string; chunkId: string }> = [];
  const payloadMismatches: Array<{ pointId: string; chunkId: string }> = [];
  let mysqlPointCount = 0;
  let cursor: string | undefined;
  do {
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { documentVersionId: { not: null } },
      select: {
        id: true,
        contentHash: true,
        documentVersionId: true,
        document: {
          select: {
            id: true,
            subjectId: true,
            libraryId: true,
            activeVersionId: true,
            library: { select: { scope: true, ownerId: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const chunk of chunks) {
      const pointId = deterministicUuid(
        schemaVersion,
        chunk.id,
        chunk.contentHash ?? '',
      );
      expectedIds.add(pointId);
      mysqlPointCount += 1;
      const payload = qdrantById.get(pointId);
      if (!payload) {
        if (missing.length < sampleLimit) missing.push({ pointId, chunkId: chunk.id });
        continue;
      }
      const mismatch =
        payload.chunkId !== chunk.id ||
        payload.documentVersionId !== chunk.documentVersionId ||
        payload.documentId !== chunk.document.id ||
        payload.libraryId !== chunk.document.libraryId ||
        payload.subjectId !== chunk.document.subjectId ||
        payload.scope !== chunk.document.library.scope ||
        payload.ownerId !== chunk.document.library.ownerId ||
        payload.contentHash !== chunk.contentHash ||
        payload.schemaVersion !== schemaVersion ||
        payload.embeddingModel !== embeddingModel ||
        payload.active !==
          (chunk.document.activeVersionId === chunk.documentVersionId);
      if (mismatch && payloadMismatches.length < sampleLimit) {
        payloadMismatches.push({ pointId, chunkId: chunk.id });
      }
    }
    cursor = chunks.at(-1)?.id;
    if (chunks.length < 500) break;
  } while (cursor);

  const unknown = [...qdrantById.keys()]
    .filter((pointId) => !expectedIds.has(pointId))
    .slice(0, sampleLimit);
  const [
    readyVersions,
    activeVersions,
    counters,
    staleImports,
    staleIndexJobs,
    failedCleanupJobs,
  ] =
    await Promise.all([
      prisma.knowledgeDocumentVersion.count({ where: { indexStatus: 'READY' } }),
      prisma.knowledgeDocument.count({ where: { activeVersionId: { not: null } } }),
      prisma.knowledgeCapacityCounter.findMany({ orderBy: { key: 'asc' } }),
      prisma.knowledgeImportJob.count({
        where: {
          status: { in: ['PREFLIGHTING', 'PROCESSING'] },
          OR: [{ leasedUntil: null }, { leasedUntil: { lt: new Date() } }],
        },
      }),
      prisma.indexJob.count({
        where: {
          status: 'PROCESSING',
          OR: [{ leasedUntil: null }, { leasedUntil: { lt: new Date() } }],
        },
      }),
      prisma.indexJob.findMany({
        where: {
          status: 'FAILED',
          operation: {
            in: ['DELETE_VERSION_VECTORS', 'DELETE_DOCUMENT_VECTORS'],
          },
        },
        select: {
          id: true,
          operation: true,
          documentId: true,
          documentVersionId: true,
          error: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
        take: 100,
      }),
    ]);
  const capacityComparison = await calculateCapacityComparison(counters);
  const aliasTarget = (aliases.aliases ?? []).find(
    (item) => item.alias_name === alias,
  )?.collection_name ?? null;
  const collectionDetails = collectionInfo as unknown as {
    status?: string;
    config?: {
      params?: { vectors?: { size?: number; distance?: string } };
    };
    payload_schema?: Record<string, unknown>;
  };
  const expectedDimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);
  const collectionSchemaConsistent =
    collectionDetails.status !== 'red' &&
    collectionDetails.config?.params?.vectors?.size === expectedDimensions &&
    String(collectionDetails.config?.params?.vectors?.distance).toLowerCase() ===
      'cosine' &&
    [
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
    ].every(
      (field) => field in (collectionDetails.payload_schema ?? {}),
    );

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    collection,
    alias,
    aliasTarget,
    aliasConsistent: aliasTarget === collection,
    collectionStatus: collectionInfo.status,
    collectionSchemaConsistent,
    mysqlPointCount,
    qdrantPointCount: qdrantById.size,
    readyVersions,
    activeVersions,
    missing,
    unknown,
    payloadMismatches,
    counters: counters.map((counter) => ({
      ...counter,
      mediaBytes: Number(counter.mediaBytes),
      reservedMediaBytes: Number(counter.reservedMediaBytes),
    })),
    capacityComparison,
    staleImports,
    staleIndexJobs,
    failedCleanupJobs,
    consistent:
      missing.length === 0 &&
      unknown.length === 0 &&
      payloadMismatches.length === 0 &&
      capacityComparison.every((item) => item.matches) &&
      failedCleanupJobs.length === 0 &&
      staleImports === 0 &&
      staleIndexJobs === 0 &&
      aliasTarget === collection &&
      collectionSchemaConsistent,
  }, null, 2));
}

type CapacityValue = {
  activeLibraries: number;
  activeDocuments: number;
  activeChunks: number;
  livePoints: number;
  imageCount: number;
  mediaBytes: bigint;
  reservedChunks: number;
  reservedPoints: number;
  reservedImages: number;
  reservedMediaBytes: bigint;
};

async function calculateCapacityComparison(
  counters: Awaited<ReturnType<typeof prisma.knowledgeCapacityCounter.findMany>>,
) {
  const actual = new Map<string, CapacityValue>();
  const ensure = (key: string) => {
    let value = actual.get(key);
    if (!value) {
      value = {
        activeLibraries: 0,
        activeDocuments: 0,
        activeChunks: 0,
        livePoints: 0,
        imageCount: 0,
        mediaBytes: 0n,
        reservedChunks: 0,
        reservedPoints: 0,
        reservedImages: 0,
        reservedMediaBytes: 0n,
      };
      actual.set(key, value);
    }
    return value;
  };
  const keysFor = (scope: 'SHARED' | 'PRIVATE', ownerId: string | null) =>
    scope === 'PRIVATE'
      ? ['GLOBAL', 'PRIVATE_GLOBAL', `USER:${ownerId}`]
      : ['GLOBAL'];
  const [libraries, documents, versions, photos, imports, rebuilds] =
    await Promise.all([
      prisma.knowledgeLibrary.findMany({
        where: { deletedAt: null },
        select: { scope: true, ownerId: true },
      }),
      prisma.knowledgeDocument.findMany({
        where: { deletedAt: null },
        select: { library: { select: { scope: true, ownerId: true } } },
      }),
      prisma.knowledgeDocumentVersion.findMany({
        where: { indexStatus: 'READY' },
        select: {
          chunkCount: true,
          vectorCount: true,
          document: {
            select: { library: { select: { scope: true, ownerId: true } } },
          },
        },
      }),
      prisma.photo.findMany({
        where: {
          knowledgeImages: {
            some: { documentVersion: { indexStatus: 'READY' } },
          },
        },
        select: {
          size: true,
          knowledgeImages: {
            where: { documentVersion: { indexStatus: 'READY' } },
            select: {
              documentVersion: {
                select: {
                  document: {
                    select: {
                      library: { select: { scope: true, ownerId: true } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.knowledgeImportJob.findMany({
        where: {
          OR: [
            { reservedChunks: { gt: 0 } },
            { reservedPoints: { gt: 0 } },
            { reservedImages: { gt: 0 } },
            { reservedMediaBytes: { gt: 0 } },
          ],
        },
        select: {
          reservedChunks: true,
          reservedPoints: true,
          reservedImages: true,
          reservedMediaBytes: true,
          library: { select: { scope: true, ownerId: true } },
        },
      }),
      prisma.indexJob.findMany({
        where: { operation: 'INDEX_VERSION', stage: 'CAPACITY_RESERVED' },
        select: {
          documentVersion: { select: { chunkCount: true } },
          document: {
            select: { library: { select: { scope: true, ownerId: true } } },
          },
        },
      }),
    ]);

  for (const library of libraries) {
    for (const key of keysFor(library.scope, library.ownerId)) {
      ensure(key).activeLibraries += 1;
    }
  }
  for (const document of documents) {
    for (const key of keysFor(document.library.scope, document.library.ownerId)) {
      ensure(key).activeDocuments += 1;
    }
  }
  for (const version of versions) {
    for (const key of keysFor(
      version.document.library.scope,
      version.document.library.ownerId,
    )) {
      ensure(key).activeChunks += version.chunkCount;
      ensure(key).livePoints += version.vectorCount;
    }
  }
  for (const photo of photos) {
    const photoKeys = new Set(['GLOBAL']);
    for (const link of photo.knowledgeImages) {
      const library = link.documentVersion.document.library;
      for (const key of keysFor(library.scope, library.ownerId)) photoKeys.add(key);
    }
    for (const key of photoKeys) {
      ensure(key).imageCount += 1;
      ensure(key).mediaBytes += BigInt(photo.size);
    }
  }
  for (const job of imports) {
    for (const key of keysFor(job.library.scope, job.library.ownerId)) {
      const value = ensure(key);
      value.reservedChunks += job.reservedChunks;
      value.reservedPoints += job.reservedPoints;
      value.reservedImages += job.reservedImages;
      value.reservedMediaBytes += job.reservedMediaBytes;
    }
  }
  for (const job of rebuilds) {
    const chunks = job.documentVersion?.chunkCount ?? 0;
    for (const key of keysFor(job.document.library.scope, job.document.library.ownerId)) {
      ensure(key).reservedChunks += chunks;
      ensure(key).reservedPoints += chunks;
    }
  }

  const counterByKey = new Map(counters.map((counter) => [counter.key, counter]));
  const allKeys = [...new Set([...actual.keys(), ...counterByKey.keys()])].sort();
  return allKeys.map((key) => {
    const expected = ensure(key);
    const cached = counterByKey.get(key);
    const cachedValue: CapacityValue = cached
      ? {
          activeLibraries: cached.activeLibraries,
          activeDocuments: cached.activeDocuments,
          activeChunks: cached.activeChunks,
          livePoints: cached.livePoints,
          imageCount: cached.imageCount,
          mediaBytes: cached.mediaBytes,
          reservedChunks: cached.reservedChunks,
          reservedPoints: cached.reservedPoints,
          reservedImages: cached.reservedImages,
          reservedMediaBytes: cached.reservedMediaBytes,
        }
      : {
          activeLibraries: 0,
          activeDocuments: 0,
          activeChunks: 0,
          livePoints: 0,
          imageCount: 0,
          mediaBytes: 0n,
          reservedChunks: 0,
          reservedPoints: 0,
          reservedImages: 0,
          reservedMediaBytes: 0n,
        };
    const difference = {
      activeLibraries: cachedValue.activeLibraries - expected.activeLibraries,
      activeDocuments: cachedValue.activeDocuments - expected.activeDocuments,
      activeChunks: cachedValue.activeChunks - expected.activeChunks,
      livePoints: cachedValue.livePoints - expected.livePoints,
      imageCount: cachedValue.imageCount - expected.imageCount,
      mediaBytes: Number(cachedValue.mediaBytes - expected.mediaBytes),
      reservedChunks: cachedValue.reservedChunks - expected.reservedChunks,
      reservedPoints: cachedValue.reservedPoints - expected.reservedPoints,
      reservedImages: cachedValue.reservedImages - expected.reservedImages,
      reservedMediaBytes: Number(
        cachedValue.reservedMediaBytes - expected.reservedMediaBytes,
      ),
    };
    return {
      key,
      actual: {
        ...expected,
        mediaBytes: Number(expected.mediaBytes),
        reservedMediaBytes: Number(expected.reservedMediaBytes),
      },
      cached: {
        ...cachedValue,
        mediaBytes: Number(cachedValue.mediaBytes),
        reservedMediaBytes: Number(cachedValue.reservedMediaBytes),
      },
      difference,
      matches: Object.values(difference).every((value) => value === 0),
    };
  });
}

async function readQdrantPoints() {
  const points: Array<{
    id: string | number;
    payload?: Record<string, unknown> | null;
  }> = [];
  let offset: string | number | Record<string, unknown> | undefined;
  do {
    const page = await qdrant.scroll(collection, {
      limit: 500,
      offset,
      with_payload: true,
      with_vector: false,
    });
    points.push(...page.points);
    offset = page.next_page_offset ?? undefined;
  } while (offset !== undefined && offset !== null);
  return points;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main()
  .finally(() => prisma.$disconnect());
