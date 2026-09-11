import {
  KNOWLEDGE_RENDER_BLOCK_VERSION,
  deterministicUuid,
  parseKnowledgeMarkdown,
  type KnowledgeParseResult,
} from '@bmc3/knowledge-core';
import {
  IndexStatus,
  KnowledgeKind,
  KnowledgeRenderStatus,
  type PrismaClient,
} from '@prisma/client';

interface RenderVersion {
  id: string;
  contentHash: string;
}

async function readerMetadataUpdates(
  prisma: PrismaClient,
  versionId: string,
  parse: KnowledgeParseResult,
) {
  const [nodes, chunks, renderBlocks] = await Promise.all([
    prisma.knowledgeNode.findMany({
      where: { documentVersionId: versionId },
      select: { id: true, pathHash: true },
    }),
    prisma.knowledgeChunk.findMany({
      where: { documentVersionId: versionId },
      select: { id: true, nodeId: true, chunkIndex: true },
    }),
    prisma.knowledgeRenderBlock.findMany({
      where: { documentVersionId: versionId },
      select: { id: true, nodeId: true, blockIndex: true },
    }),
  ]);
  const nodeIdByPathHash = new Map(
    nodes.map((node) => [node.pathHash, node.id]),
  );
  if (
    nodes.length !== parse.nodes.length ||
    parse.nodes.some((node) => !nodeIdByPathHash.has(node.pathHash))
  ) {
    throw new Error('READER_METADATA_NODE_MISMATCH');
  }
  const chunkByIndex = new Map(
    chunks.map((chunk) => [chunk.chunkIndex, chunk]),
  );
  if (chunks.length !== parse.chunkCount) {
    throw new Error('READER_METADATA_CHUNK_MISMATCH');
  }
  const renderBlockByNodeAndIndex = new Map(
    renderBlocks.map((block) => [
      `${block.nodeId}\0${block.blockIndex}`,
      block.id,
    ]),
  );
  const chunkUpdates = parse.nodes.flatMap((node) => {
    const nodeId = nodeIdByPathHash.get(node.pathHash)!;
    return node.chunks.map((chunk) => {
      const stored = chunkByIndex.get(chunk.chunkIndex);
      const primaryRenderBlockId = renderBlockByNodeAndIndex.get(
        `${nodeId}\0${chunk.primaryRenderBlockIndex}`,
      );
      if (!stored || stored.nodeId !== nodeId || !primaryRenderBlockId) {
        throw new Error('READER_METADATA_ANCHOR_MISMATCH');
      }
      return { id: stored.id, primaryRenderBlockId };
    });
  });
  return {
    nodeUpdates: parse.nodes.map((node) => ({
      id: nodeIdByPathHash.get(node.pathHash)!,
      titleMarkdown: node.titleMarkdown,
    })),
    chunkUpdates,
  };
}

function renderBlockId(
  versionId: string,
  nodePathHash: string,
  blockIndex: number,
) {
  return deterministicUuid(
    'knowledge-render-block',
    versionId,
    nodePathHash,
    String(blockIndex),
  );
}

export async function persistKnowledgeRenderBlocks(
  prisma: PrismaClient,
  version: RenderVersion,
  parse: KnowledgeParseResult,
) {
  try {
    if (
      parse.contentHash !== version.contentHash ||
      parse.issues.some((issue) => issue.severity === 'ERROR')
    ) {
      throw new Error('RENDER_SOURCE_INVALID');
    }
    const nodes = await prisma.knowledgeNode.findMany({
      where: { documentVersionId: version.id },
      select: { id: true, pathHash: true },
    });
    const nodeIdByPathHash = new Map(
      nodes.map((node) => [node.pathHash, node.id]),
    );
    if (
      nodes.length !== parse.nodes.length ||
      parse.nodes.some((node) => !nodeIdByPathHash.has(node.pathHash))
    ) {
      throw new Error('RENDER_NODE_MISMATCH');
    }

    const planned = parse.nodes.flatMap((node) => {
      const nodeId = nodeIdByPathHash.get(node.pathHash)!;
      return node.renderBlocks.map((block) => ({
        ...block,
        id: renderBlockId(version.id, node.pathHash, block.blockIndex),
        nodeId,
        nodePathHash: node.pathHash,
      }));
    });

    await prisma.knowledgeDocumentVersion.update({
      where: { id: version.id },
      data: {
        renderStatus: KnowledgeRenderStatus.PENDING,
        renderBlockVersion: KNOWLEDGE_RENDER_BLOCK_VERSION,
        renderBlockCount: 0,
        mathCount: 0,
        renderError: null,
      },
    });
    await prisma.knowledgeRenderBlock.deleteMany({
      where: { documentVersionId: version.id },
    });
    for (const block of planned) {
      await prisma.knowledgeRenderBlock.upsert({
        where: { id: block.id },
        create: {
          id: block.id,
          documentVersionId: version.id,
          nodeId: block.nodeId,
          blockIndex: block.blockIndex,
          markdown: block.markdown,
          sourceHash: block.sourceHash,
          plainTextLength: block.plainTextLength,
          markdownBytes: block.markdownBytes,
          imageCount: block.imageOccurrenceIndexes.length,
          mathCount: block.mathCount,
        },
        update: {
          nodeId: block.nodeId,
          markdown: block.markdown,
          sourceHash: block.sourceHash,
          plainTextLength: block.plainTextLength,
          markdownBytes: block.markdownBytes,
          imageCount: block.imageOccurrenceIndexes.length,
          mathCount: block.mathCount,
        },
      });
    }

    const references = await prisma.knowledgeImageReference.findMany({
      where: { versionImage: { documentVersionId: version.id } },
      select: {
        id: true,
        nodeId: true,
        occurrenceIndex: true,
        altText: true,
        versionImage: { select: { entryPath: true } },
      },
    });
    const referenceByOccurrence = new Map(
      references.map((reference) => [reference.occurrenceIndex, reference]),
    );
    const blockByOccurrence = new Map<number, (typeof planned)[number]>();
    for (const block of planned) {
      for (const occurrenceIndex of block.imageOccurrenceIndexes) {
        blockByOccurrence.set(occurrenceIndex, block);
      }
    }
    if (references.length !== parse.images.length) {
      throw new Error('RENDER_IMAGE_REFERENCE_MISMATCH');
    }
    const referenceUpdates = parse.images.map((image) => {
      const reference = referenceByOccurrence.get(image.occurrenceIndex);
      const nodeId = nodeIdByPathHash.get(image.nodePathHash);
      const block = blockByOccurrence.get(image.occurrenceIndex);
      if (
        !reference ||
        !nodeId ||
        !block ||
        block.nodePathHash !== image.nodePathHash ||
        block.blockIndex !== image.renderBlockIndex ||
        reference.nodeId !== nodeId ||
        reference.altText !== image.altText ||
        reference.versionImage.entryPath !== image.entryPath
      ) {
        throw new Error('RENDER_IMAGE_REFERENCE_MISMATCH');
      }
      return { id: reference.id, renderBlockId: block.id };
    });
    const metadata = await readerMetadataUpdates(prisma, version.id, parse);

    await prisma.$transaction(async (transaction) => {
      const storedCount = await transaction.knowledgeRenderBlock.count({
        where: { documentVersionId: version.id },
      });
      if (storedCount !== planned.length) {
        throw new Error('RENDER_BLOCK_COUNT_MISMATCH');
      }
      for (const reference of referenceUpdates) {
        await transaction.knowledgeImageReference.update({
          where: { id: reference.id },
          data: { renderBlockId: reference.renderBlockId },
        });
      }
      for (const node of metadata.nodeUpdates) {
        await transaction.knowledgeNode.update({
          where: { id: node.id },
          data: { titleMarkdown: node.titleMarkdown },
        });
      }
      for (const chunk of metadata.chunkUpdates) {
        await transaction.knowledgeChunk.update({
          where: { id: chunk.id },
          data: { primaryRenderBlockId: chunk.primaryRenderBlockId },
        });
      }
      await transaction.knowledgeDocumentVersion.update({
        where: { id: version.id },
        data: {
          titleMarkdown: parse.titleMarkdown,
          renderStatus: KnowledgeRenderStatus.READY,
          renderBlockVersion: KNOWLEDGE_RENDER_BLOCK_VERSION,
          renderBlockCount: planned.length,
          mathCount: parse.mathCount,
          renderError: null,
        },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.knowledgeDocumentVersion.updateMany({
      where: { id: version.id },
      data: {
        renderStatus: KnowledgeRenderStatus.FAILED,
        renderBlockVersion: KNOWLEDGE_RENDER_BLOCK_VERSION,
        renderBlockCount: 0,
        mathCount: 0,
        renderError: message.slice(0, 2_000),
      },
    });
    throw error;
  }
}

export async function processNextKnowledgeRenderBackfill(prisma: PrismaClient) {
  const version = await prisma.knowledgeDocumentVersion.findFirst({
    where: {
      indexStatus: IndexStatus.READY,
      document: { kind: KnowledgeKind.MARKDOWN, deletedAt: null },
      OR: [
        { renderStatus: KnowledgeRenderStatus.PENDING },
        { titleMarkdown: null },
        { nodes: { some: { titleMarkdown: null } } },
        { chunks: { some: { primaryRenderBlockId: null } } },
      ],
    },
    select: {
      id: true,
      markdown: true,
      contentHash: true,
      imageCount: true,
      renderStatus: true,
      renderBlockVersion: true,
      renderBlockCount: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!version) return false;
  try {
    const parse = parseKnowledgeMarkdown(version.markdown, {
      allowImages: version.imageCount > 0,
    });
    if (
      version.renderStatus !== KnowledgeRenderStatus.READY ||
      version.renderBlockVersion !== KNOWLEDGE_RENDER_BLOCK_VERSION ||
      version.renderBlockCount !== parse.renderBlockCount
    ) {
      await persistKnowledgeRenderBlocks(prisma, version, parse);
    } else {
      if (
        parse.contentHash !== version.contentHash ||
        parse.issues.some((issue) => issue.severity === 'ERROR')
      ) {
        throw new Error('READER_METADATA_SOURCE_INVALID');
      }
      const metadata = await readerMetadataUpdates(prisma, version.id, parse);
      await prisma.$transaction(async (transaction) => {
        for (const node of metadata.nodeUpdates) {
          await transaction.knowledgeNode.update({
            where: { id: node.id },
            data: { titleMarkdown: node.titleMarkdown },
          });
        }
        for (const chunk of metadata.chunkUpdates) {
          await transaction.knowledgeChunk.update({
            where: { id: chunk.id },
            data: { primaryRenderBlockId: chunk.primaryRenderBlockId },
          });
        }
        await transaction.knowledgeDocumentVersion.update({
          where: { id: version.id },
          data: { titleMarkdown: parse.titleMarkdown },
        });
      });
    }
    console.log(
      `Backfilled ${version.id}: ${parse.renderBlockCount} render blocks`,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (version.renderStatus !== KnowledgeRenderStatus.READY) {
      await prisma.knowledgeDocumentVersion.updateMany({
        where: { id: version.id },
        data: {
          renderStatus: KnowledgeRenderStatus.FAILED,
          renderBlockVersion: KNOWLEDGE_RENDER_BLOCK_VERSION,
          renderBlockCount: 0,
          mathCount: 0,
          renderError: message.slice(0, 2_000),
        },
      });
    }
    throw error;
  }
}

export const knowledgeRenderInternals = {
  readerMetadataUpdates,
  renderBlockId,
};
