import { KnowledgeReaderService } from './knowledge-reader.service';

const user = { id: 'member-1', role: 'MEMBER' } as never;

function fixtures() {
  const library = {
    id: 'library-1',
    name: '组织学知识库',
    scope: 'SHARED',
    ownerId: null,
    subject: { id: 'subject-1', name: '组织学', slug: 'histology' },
  };
  const documents = [
    {
      id: 'document-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      activeVersionId: 'version-1',
      activeVersion: {
        id: 'version-1',
        renderBlockVersion: 'mdast-render-v1',
        renderBlockCount: 1,
        imageCount: 0,
      },
    },
    {
      id: 'document-2',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
      activeVersionId: 'version-2',
      activeVersion: {
        id: 'version-2',
        renderBlockVersion: 'mdast-render-v1',
        renderBlockCount: 1,
        imageCount: 0,
      },
    },
  ];
  const nodes = [
    {
      id: 'node-2',
      parentId: null,
      documentVersionId: 'version-2',
      level: 2,
      title: '肾脏',
      titleMarkdown: '肾脏',
      sortOrder: 0,
      renderBlocks: [
        { id: 'block-2', blockIndex: 0, markdownBytes: 5 },
      ],
    },
    {
      id: 'node-1',
      parentId: null,
      documentVersionId: 'version-1',
      level: 2,
      title: '肝脏 H_2O',
      titleMarkdown: '肝脏 $H_2O$',
      sortOrder: 0,
      renderBlocks: [
        { id: 'block-1', blockIndex: 0, markdownBytes: 5 },
      ],
    },
  ];
  return { library, documents, nodes };
}

function createService() {
  const data = fixtures();
  const prisma = {
    knowledgeLibrary: {
      findFirst: jest.fn().mockResolvedValue(data.library),
    },
    knowledgeDocument: {
      findMany: jest.fn().mockResolvedValue(data.documents),
    },
    knowledgeNode: {
      findMany: jest.fn().mockResolvedValue(data.nodes),
    },
    knowledgeRenderBlock: {
      findMany: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          (where.id.in as string[]).map((id) => ({
            id,
            markdown: id === 'block-1' ? '肝小叶。' : '肾单位。',
            sourceHash: `hash-${id}`,
            blockIndex: 0,
            markdownBytes: 5,
            mathCount: 0,
            imageReferences: [],
          })),
        ),
      ),
    },
  };
  return {
    data,
    prisma,
    service: new KnowledgeReaderService(prisma as never, {} as never),
  };
}

describe('KnowledgeReaderService', () => {
  it('orders the virtual document by logical document creation and never emits H1', async () => {
    const { service, prisma } = createService();
    const manifest = await service.manifest(user, 'library-1');
    const range = await service.range(
      user,
      'library-1',
      manifest.body.readerRevision,
      'node-1',
      0,
      1,
    );

    expect(range.body.items).toEqual([
      expect.objectContaining({
        kind: 'HEADING',
        nodeId: 'node-1',
        level: 2,
        titleMarkdown: '肝脏 $H_2O$',
      }),
      expect.objectContaining({
        kind: 'BLOCK',
        renderBlockId: 'block-1',
        markdown: '肝小叶。',
      }),
    ]);
    expect(range.body.items.every((item) => !('documentId' in item))).toBe(true);
    expect(prisma.knowledgeDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(prisma.knowledgeRenderBlock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['block-1'] } } }),
    );
  });

  it('rejects a stale revision without returning old body content', async () => {
    const { service, prisma, data } = createService();
    const manifest = await service.manifest(user, 'library-1');
    prisma.knowledgeDocument.findMany.mockResolvedValue([
      {
        ...data.documents[0],
        activeVersionId: 'version-new',
        activeVersion: {
          ...data.documents[0]!.activeVersion,
          id: 'version-new',
        },
      },
    ]);

    await expect(
      service.outline(
        user,
        'library-1',
        manifest.body.readerRevision,
        undefined,
        100,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
