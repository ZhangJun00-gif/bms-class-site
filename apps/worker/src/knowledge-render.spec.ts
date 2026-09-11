import { parseKnowledgeMarkdown } from '@bmc3/knowledge-core';
import {
  knowledgeRenderInternals,
  persistKnowledgeRenderBlocks,
} from './knowledge-render';

describe('knowledge render block persistence', () => {
  it('writes deterministic blocks and links image occurrences before READY', async () => {
    const parse = parseKnowledgeMarkdown(
      '# 组织学\n\n## 肝脏\n\n肝小叶。\n\n![结构图](image/lobule.png)',
      { allowImages: true },
    );
    const nodeId = 'node-1';
    const expectedBlockId = knowledgeRenderInternals.renderBlockId(
      'version-1',
      parse.nodes[0]!.pathHash,
      0,
    );
    const versionUpdate = jest.fn().mockResolvedValue({});
    const referenceUpdate = jest.fn().mockResolvedValue({});
    const chunkUpdate = jest.fn().mockResolvedValue({});
    const transaction = {
      knowledgeRenderBlock: {
        count: jest.fn().mockResolvedValue(parse.renderBlockCount),
      },
      knowledgeImageReference: { update: referenceUpdate },
      knowledgeNode: { update: jest.fn().mockResolvedValue({}) },
      knowledgeChunk: { update: chunkUpdate },
      knowledgeDocumentVersion: { update: versionUpdate },
    };
    const prisma = {
      knowledgeNode: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: nodeId, pathHash: parse.nodes[0]!.pathHash },
          ]),
      },
      knowledgeDocumentVersion: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeRenderBlock: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([
          { id: expectedBlockId, nodeId, blockIndex: 0 },
        ]),
      },
      knowledgeChunk: {
        findMany: jest.fn().mockResolvedValue(
          parse.nodes[0]!.chunks.map((chunk) => ({
            id: `chunk-${chunk.chunkIndex}`,
            nodeId,
            chunkIndex: chunk.chunkIndex,
          })),
        ),
      },
      knowledgeImageReference: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'reference-1',
            nodeId,
            occurrenceIndex: 0,
            altText: '结构图',
            versionImage: { entryPath: 'image/lobule.png' },
          },
        ]),
      },
      $transaction: jest.fn(
        (action: (tx: typeof transaction) => Promise<unknown>) =>
          action(transaction),
      ),
    };

    await persistKnowledgeRenderBlocks(
      prisma as never,
      { id: 'version-1', contentHash: parse.contentHash },
      parse,
    );

    expect(prisma.knowledgeRenderBlock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: expectedBlockId },
        create: expect.objectContaining({
          id: expectedBlockId,
          markdown: expect.stringContaining('![结构图](image/lobule.png)'),
          imageCount: 1,
        }),
      }),
    );
    expect(referenceUpdate).toHaveBeenCalledWith({
      where: { id: 'reference-1' },
      data: { renderBlockId: expectedBlockId },
    });
    expect(chunkUpdate).toHaveBeenCalledWith({
      where: { id: 'chunk-0' },
      data: { primaryRenderBlockId: expectedBlockId },
    });
    expect(versionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          renderStatus: 'READY',
          renderBlockCount: parse.renderBlockCount,
        }),
      }),
    );
  });

  it('marks a version FAILED without writing blocks when its source hash differs', async () => {
    const parse = parseKnowledgeMarkdown('# 标题\n\n## 章节\n\n正文', {
      allowImages: false,
    });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const blockUpsert = jest.fn();
    const prisma = {
      knowledgeDocumentVersion: { updateMany },
      knowledgeRenderBlock: { upsert: blockUpsert },
    };

    await expect(
      persistKnowledgeRenderBlocks(
        prisma as never,
        { id: 'version-1', contentHash: 'different' },
        parse,
      ),
    ).rejects.toThrow('RENDER_SOURCE_INVALID');
    expect(blockUpsert).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ renderStatus: 'FAILED' }),
      }),
    );
  });
});
