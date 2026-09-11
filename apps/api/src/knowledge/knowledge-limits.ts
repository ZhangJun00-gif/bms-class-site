const MIB = 1024 * 1024;

export interface KnowledgeLimits {
  importMaxMarkdownBytes: number;
  importMaxZipBytes: number;
  importUnconfirmedPerUser: number;
  activeImportsGlobal: number;
  privateActiveImportsPerUser: number;
  privateActiveImportsGlobal: number;
  importMinFreeBytes: bigint;
  maxActiveChunks: number;
  maxPrivateActiveChunks: number;
  maxLiveQdrantPoints: number;
  privateMaxLibrariesPerUser: number;
  privateMaxActiveDocumentsPerUser: number;
  privateMaxActiveChunksPerUser: number;
  privateMaxImagesPerUser: number;
  privateMaxMediaBytesPerUser: bigint;
}

export function readKnowledgeLimits(
  env: Record<string, string | undefined> = process.env,
): KnowledgeLimits {
  return {
    importMaxMarkdownBytes: readInteger(env, 'KNOWLEDGE_IMPORT_MAX_MARKDOWN_BYTES', 10 * MIB, 1, 10 * MIB),
    importMaxZipBytes: readInteger(env, 'KNOWLEDGE_IMPORT_MAX_ZIP_BYTES', 200 * MIB, 1, 200 * MIB),
    importUnconfirmedPerUser: readInteger(env, 'KNOWLEDGE_IMPORT_UNCONFIRMED_PER_USER', 2, 1, 2),
    activeImportsGlobal: readInteger(env, 'KNOWLEDGE_ACTIVE_IMPORTS_GLOBAL', 10, 1, 10),
    privateActiveImportsPerUser: readInteger(env, 'KNOWLEDGE_PRIVATE_ACTIVE_IMPORTS_PER_USER', 1, 1, 1),
    privateActiveImportsGlobal: readInteger(env, 'KNOWLEDGE_PRIVATE_ACTIVE_IMPORTS_GLOBAL', 5, 1, 5),
    importMinFreeBytes: BigInt(
      readInteger(env, 'KNOWLEDGE_IMPORT_MIN_FREE_BYTES', 5 * 1024 * MIB, 0, 5 * 1024 * MIB),
    ),
    maxActiveChunks: readInteger(env, 'KNOWLEDGE_MAX_ACTIVE_CHUNKS', 100_000, 1, 100_000),
    maxPrivateActiveChunks: readInteger(env, 'KNOWLEDGE_MAX_PRIVATE_ACTIVE_CHUNKS', 50_000, 1, 50_000),
    maxLiveQdrantPoints: readInteger(env, 'KNOWLEDGE_MAX_LIVE_QDRANT_POINTS', 120_000, 1, 120_000),
    privateMaxLibrariesPerUser: readInteger(env, 'KNOWLEDGE_PRIVATE_MAX_LIBRARIES_PER_USER', 2, 1, 2),
    privateMaxActiveDocumentsPerUser: readInteger(env, 'KNOWLEDGE_PRIVATE_MAX_ACTIVE_DOCUMENTS_PER_USER', 10, 1, 10),
    privateMaxActiveChunksPerUser: readInteger(env, 'KNOWLEDGE_PRIVATE_MAX_ACTIVE_CHUNKS_PER_USER', 2_000, 1, 2_000),
    privateMaxImagesPerUser: readInteger(env, 'KNOWLEDGE_PRIVATE_MAX_IMAGES_PER_USER', 200, 0, 200),
    privateMaxMediaBytesPerUser: BigInt(
      readInteger(env, 'KNOWLEDGE_PRIVATE_MAX_MEDIA_BYTES_PER_USER', 50 * MIB, 0, 50 * MIB),
    ),
  };
}

function readInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}
