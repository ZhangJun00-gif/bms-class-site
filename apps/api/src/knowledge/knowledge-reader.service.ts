import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ContentStatus,
  IndexStatus,
  KnowledgeKind,
  KnowledgeLibraryScope,
  KnowledgeRenderStatus,
  Prisma,
  type User,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { KnowledgeAccessService } from './knowledge-access.service';

export const READER_OUTLINE_DEFAULT_LIMIT = 100;
export const READER_OUTLINE_MAX_LIMIT = 200;
export const READER_RANGE_DEFAULT_BEFORE = 8;
export const READER_RANGE_DEFAULT_AFTER = 16;
export const READER_RANGE_MAX_DIRECTION = 40;
export const READER_RANGE_MAX_ITEMS = 60;
export const READER_RANGE_MAX_MARKDOWN_BYTES = 256 * 1024;

interface ReaderSnapshot {
  library: {
    id: string;
    name: string;
    scope: KnowledgeLibraryScope;
    ownerId: string | null;
    subject: { id: string; name: string; slug: string };
  };
  documents: Array<{
    id: string;
    createdAt: Date;
    activeVersionId: string;
    version: {
      id: string;
      renderBlockVersion: string | null;
      renderBlockCount: number;
      imageCount: number;
    };
  }>;
  revision: string;
  preview?: {
    documentId: string;
    versionId: string;
    title: string;
    titleMarkdown: string;
  };
}

interface ReaderNode {
  id: string;
  parentId: string | null;
  documentVersionId: string;
  level: number;
  title: string;
  titleMarkdown: string | null;
  sortOrder: number;
  renderBlocks: Array<{
    id: string;
    blockIndex: number;
    markdownBytes: number;
  }>;
}

type ReaderDescriptor =
  | {
      kind: 'HEADING';
      anchorId: string;
      sequenceKey: string;
      node: ReaderNode;
      markdownBytes: 0;
    }
  | {
      kind: 'BLOCK';
      anchorId: string;
      sequenceKey: string;
      node: ReaderNode;
      block: ReaderNode['renderBlocks'][number];
      markdownBytes: number;
    };

@Injectable()
export class KnowledgeReaderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: KnowledgeAccessService,
  ) {}

  async directory(
    user: User,
    query: {
      scope?: KnowledgeLibraryScope;
      subjectId?: string;
      query?: string;
      page: number;
      pageSize: number;
    },
  ) {
    const where: Prisma.KnowledgeLibraryWhereInput = {
      deletedAt: null,
      active: true,
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.query ? { name: { contains: query.query.trim() } } : {}),
      OR: [
        { scope: KnowledgeLibraryScope.SHARED },
        { scope: KnowledgeLibraryScope.PRIVATE, ownerId: user.id },
      ],
      subject: { active: true },
    };
    const [libraries, total] = await Promise.all([
      this.prisma.knowledgeLibrary.findMany({
        where,
        select: {
          id: true,
          name: true,
          scope: true,
          ownerId: true,
          subjectId: true,
          subject: {
            select: {
              id: true,
              name: true,
              slug: true,
              sortOrder: true,
              active: true,
            },
          },
          aiEnabled: true,
          aiEnabledAt: true,
          active: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { documents: true, chapters: true } },
          documents: {
            where: {
              deletedAt: null,
              kind: KnowledgeKind.MARKDOWN,
              status: ContentStatus.PUBLISHED,
              activeVersionId: { not: null },
              activeVersion: {
                is: {
                  indexStatus: IndexStatus.READY,
                  renderStatus: KnowledgeRenderStatus.READY,
                },
              },
            },
            select: {
              updatedAt: true,
              activeVersion: {
                select: {
                  activatedAt: true,
                  nodes: {
                    where: { level: 2 },
                    select: { id: true },
                  },
                },
              },
            },
          },
        },
        orderBy: [
          { subject: { sortOrder: 'asc' } },
          { scope: 'asc' },
          { name: 'asc' },
          { id: 'asc' },
        ],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.knowledgeLibrary.count({ where }),
    ]);
    return {
      items: libraries.map(({ documents, ...library }) => ({
        ...library,
        aiEnabledAt: library.aiEnabledAt?.toISOString() ?? null,
        createdAt: library.createdAt.toISOString(),
        updatedAt: library.updatedAt.toISOString(),
        reader: {
          documentCount: documents.length,
          h2Count: documents.reduce(
            (totalH2, document) =>
              totalH2 + (document.activeVersion?.nodes.length ?? 0),
            0,
          ),
          contentUpdatedAt:
            documents
              .map(
                (document) =>
                  document.activeVersion?.activatedAt ?? document.updatedAt,
              )
              .sort((left, right) => right.getTime() - left.getTime())[0]
              ?.toISOString() ?? null,
        },
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async chapters(
    user: User,
    libraryId: string,
    page: number,
    pageSize: number,
  ) {
    await this.access.getAccessible(user, libraryId);
    const where = { libraryId, active: true };
    const [items, total] = await Promise.all([
      this.prisma.knowledgeLibraryChapter.findMany({
        where,
        select: {
          id: true,
          libraryId: true,
          name: true,
          slug: true,
          sortOrder: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.knowledgeLibraryChapter.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async manifest(user: User, libraryId: string) {
    const snapshot = await this.resolveSnapshot(user, libraryId);
    const nodes = await this.loadNodes(snapshot);
    const blockCount = nodes.reduce(
      (total, node) => total + node.renderBlocks.length,
      0,
    );
    return {
      body: {
        libraryId: snapshot.library.id,
        libraryName: snapshot.library.name,
        scope: snapshot.library.scope,
        subject: snapshot.library.subject,
        readerRevision: snapshot.revision,
        headingCount: nodes.length,
        blockCount,
        imageCount: snapshot.documents.reduce(
          (total, document) => total + document.version.imageCount,
          0,
        ),
        firstAnchor: nodes[0]?.id ?? null,
        hasContent: nodes.length > 0,
      },
      cache: this.cacheFor(snapshot),
    };
  }

  async outline(
    user: User,
    libraryId: string,
    revision: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const snapshot = await this.resolveSnapshot(user, libraryId, revision);
    const nodes = await this.loadNodes(snapshot);
    let start = 0;
    if (cursor) {
      start = this.resolveOutlineCursor(snapshot.revision, cursor, nodes.length);
    }
    const selected = nodes.slice(start, start + limit);
    const nextIndex = start + selected.length;
    return {
      body: {
        readerRevision: snapshot.revision,
        items: selected.map((node, index) => ({
          nodeId: node.id,
          parentId: node.parentId,
          level: node.level,
          title: node.title,
          titleMarkdown: node.titleMarkdown ?? node.title,
          sequenceKey: this.sequenceKey(
            snapshot.revision,
            'HEADING',
            node.id,
          ),
          previousNodeId:
            nodes[start + index - 1]?.id ?? null,
          nextNodeId: nodes[start + index + 1]?.id ?? null,
        })),
        nextCursor:
          nextIndex < nodes.length
            ? this.outlineCursor(snapshot.revision, nextIndex)
            : null,
        total: nodes.length,
      },
      cache: this.cacheFor(snapshot),
    };
  }

  async range(
    user: User,
    libraryId: string,
    revision: string,
    anchor: string | undefined,
    before: number,
    after: number,
  ) {
    const snapshot = await this.resolveSnapshot(user, libraryId, revision);
    return {
      body: await this.rangeForSnapshot(snapshot, anchor, before, after),
      cache: this.cacheFor(snapshot),
    };
  }

  async context(
    user: User,
    libraryId: string,
    input: { revision?: string; nodeId?: string; blockId?: string },
  ) {
    if (!input.nodeId && !input.blockId) {
      throw new BadRequestException('nodeId 或 blockId 至少提供一个');
    }
    const snapshot = await this.resolveSnapshot(
      user,
      libraryId,
      input.revision,
    );
    const descriptors = await this.loadDescriptors(snapshot);
    const target = descriptors.find(
      (descriptor) =>
        descriptor.node.id === input.nodeId ||
        (descriptor.kind === 'BLOCK' && descriptor.block.id === input.blockId),
    );
    if (!target) throw new NotFoundException('阅读定位目标不存在');
    const nodes = descriptors
      .filter(
        (descriptor): descriptor is Extract<ReaderDescriptor, { kind: 'HEADING' }> =>
          descriptor.kind === 'HEADING',
      )
      .map((descriptor) => descriptor.node);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const breadcrumb: ReaderNode[] = [];
    let current: ReaderNode | undefined = target.node;
    while (current) {
      breadcrumb.unshift(current);
      current = current.parentId ? nodeById.get(current.parentId) : undefined;
    }
    return {
      body: {
        readerRevision: snapshot.revision,
        anchor: target.anchorId,
        nodeId: target.node.id,
        renderBlockId:
          target.kind === 'BLOCK' ? target.block.id : input.blockId ?? null,
        sequenceKey: target.sequenceKey,
        headingPath: breadcrumb.map((node) => ({
          nodeId: node.id,
          level: node.level,
          title: node.title,
          titleMarkdown: node.titleMarkdown ?? node.title,
        })),
      },
      cache: this.cacheFor(snapshot),
    };
  }

  async previewManifest(user: User, documentId: string, versionId: string) {
    const snapshot = await this.resolvePreview(user, documentId, versionId);
    const nodes = await this.loadNodes(snapshot);
    return {
      body: {
        documentId,
        versionId,
        libraryId: snapshot.library.id,
        libraryName: snapshot.library.name,
        previewRevision: snapshot.revision,
        title: snapshot.preview!.title,
        titleMarkdown: snapshot.preview!.titleMarkdown,
        headingCount: nodes.length,
        blockCount: nodes.reduce(
          (total, node) => total + node.renderBlocks.length,
          0,
        ),
        imageCount: snapshot.documents[0]?.version.imageCount ?? 0,
        firstAnchor: nodes[0]?.id ?? null,
      },
      cache: { control: 'private, no-store' },
    };
  }

  async previewRange(
    user: User,
    documentId: string,
    versionId: string,
    revision: string,
    anchor: string | undefined,
    before: number,
    after: number,
  ) {
    const snapshot = await this.resolvePreview(
      user,
      documentId,
      versionId,
      revision,
    );
    return {
      body: await this.rangeForSnapshot(snapshot, anchor, before, after),
      cache: { control: 'private, no-store' },
    };
  }

  private async resolveSnapshot(
    user: User,
    libraryId: string,
    expectedRevision?: string,
  ): Promise<ReaderSnapshot> {
    const library = await this.prisma.knowledgeLibrary.findFirst({
      where: {
        id: libraryId,
        active: true,
        deletedAt: null,
        subject: { active: true },
        OR: [
          { scope: KnowledgeLibraryScope.SHARED },
          { scope: KnowledgeLibraryScope.PRIVATE, ownerId: user.id },
        ],
      },
      select: {
        id: true,
        name: true,
        scope: true,
        ownerId: true,
        subject: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!library) throw new NotFoundException('知识库不存在');
    if (
      library.scope === KnowledgeLibraryScope.PRIVATE &&
      library.ownerId !== user.id
    ) {
      throw new ForbiddenException('无权读取该私有知识库');
    }
    const documents = await this.prisma.knowledgeDocument.findMany({
      where: {
        libraryId,
        deletedAt: null,
        kind: KnowledgeKind.MARKDOWN,
        status: ContentStatus.PUBLISHED,
        activeVersionId: { not: null },
        activeVersion: {
          is: {
            indexStatus: IndexStatus.READY,
            renderStatus: KnowledgeRenderStatus.READY,
          },
        },
      },
      select: {
        id: true,
        createdAt: true,
        activeVersionId: true,
        activeVersion: {
          select: {
            id: true,
            renderBlockVersion: true,
            renderBlockCount: true,
            imageCount: true,
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const normalizedDocuments = documents.flatMap((document) =>
      document.activeVersionId && document.activeVersion
        ? [
            {
              id: document.id,
              createdAt: document.createdAt,
              activeVersionId: document.activeVersionId,
              version: document.activeVersion,
            },
          ]
        : [],
    );
    const revision = this.readerRevision(
      library.id,
      library.scope,
      normalizedDocuments,
    );
    if (expectedRevision && expectedRevision !== revision) {
      throw new ConflictException({
        statusCode: 409,
        code: 'LIBRARY_READER_CHANGED',
        message: '知识库内容已更新',
        readerRevision: revision,
      });
    }
    return { library, documents: normalizedDocuments, revision };
  }

  private async resolvePreview(
    user: User,
    documentId: string,
    versionId: string,
    expectedRevision?: string,
  ): Promise<ReaderSnapshot> {
    const document = await this.prisma.knowledgeDocument.findFirst({
      where: { id: documentId, deletedAt: null, kind: KnowledgeKind.MARKDOWN },
      select: { id: true, libraryId: true, createdAt: true },
    });
    if (!document) throw new NotFoundException('知识文档不存在');
    const library = await this.access.assertManage(user, document.libraryId);
    const version = await this.prisma.knowledgeDocumentVersion.findFirst({
      where: {
        id: versionId,
        documentId,
        indexStatus: IndexStatus.READY,
        renderStatus: KnowledgeRenderStatus.READY,
      },
      select: {
        id: true,
        title: true,
        titleMarkdown: true,
        renderBlockVersion: true,
        renderBlockCount: true,
        imageCount: true,
        document: {
          select: {
            library: {
              select: {
                id: true,
                name: true,
                scope: true,
                ownerId: true,
                subject: { select: { id: true, name: true, slug: true } },
              },
            },
          },
        },
      },
    });
    if (!version) throw new NotFoundException('候选知识版本不可预览');
    if (
      version.document.library.scope === KnowledgeLibraryScope.PRIVATE &&
      version.document.library.ownerId !== user.id
    ) {
      throw new ForbiddenException('无权预览该私有知识版本');
    }
    const revision = `p1.${this.hash(
      [
        documentId,
        version.id,
        version.renderBlockVersion ?? '',
        String(version.renderBlockCount),
      ].join('\0'),
    )}`;
    if (expectedRevision && expectedRevision !== revision) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PREVIEW_READER_CHANGED',
        message: '候选预览已变化',
        previewRevision: revision,
      });
    }
    return {
      library: version.document.library,
      documents: [
        {
          id: document.id,
          createdAt: document.createdAt,
          activeVersionId: version.id,
          version: {
            id: version.id,
            renderBlockVersion: version.renderBlockVersion,
            renderBlockCount: version.renderBlockCount,
            imageCount: version.imageCount,
          },
        },
      ],
      revision,
      preview: {
        documentId,
        versionId,
        title: version.title,
        titleMarkdown: version.titleMarkdown ?? version.title,
      },
    };
  }

  private async loadNodes(snapshot: ReaderSnapshot): Promise<ReaderNode[]> {
    const versionIds = snapshot.documents.map((document) => document.version.id);
    if (!versionIds.length) return [];
    const nodes = await this.prisma.knowledgeNode.findMany({
      where: { documentVersionId: { in: versionIds } },
      select: {
        id: true,
        parentId: true,
        documentVersionId: true,
        level: true,
        title: true,
        titleMarkdown: true,
        sortOrder: true,
        renderBlocks: {
          select: { id: true, blockIndex: true, markdownBytes: true },
          orderBy: { blockIndex: 'asc' },
        },
      },
    });
    const documentOrder = new Map(
      snapshot.documents.map((document, index) => [document.version.id, index]),
    );
    return nodes.sort(
      (left, right) =>
        (documentOrder.get(left.documentVersionId) ?? Number.MAX_SAFE_INTEGER) -
          (documentOrder.get(right.documentVersionId) ??
            Number.MAX_SAFE_INTEGER) ||
        left.sortOrder - right.sortOrder ||
        left.id.localeCompare(right.id),
    );
  }

  private async loadDescriptors(snapshot: ReaderSnapshot) {
    const nodes = await this.loadNodes(snapshot);
    return nodes.flatMap<ReaderDescriptor>((node) => [
      {
        kind: 'HEADING',
        anchorId: node.id,
        sequenceKey: this.sequenceKey(snapshot.revision, 'HEADING', node.id),
        node,
        markdownBytes: 0,
      },
      ...node.renderBlocks.map((block) => ({
        kind: 'BLOCK' as const,
        anchorId: block.id,
        sequenceKey: this.sequenceKey(snapshot.revision, 'BLOCK', block.id),
        node,
        block,
        markdownBytes: block.markdownBytes,
      })),
    ]);
  }

  private async rangeForSnapshot(
    snapshot: ReaderSnapshot,
    anchor: string | undefined,
    before: number,
    after: number,
  ) {
    const descriptors = await this.loadDescriptors(snapshot);
    if (!descriptors.length) {
      return {
        readerRevision: snapshot.revision,
        items: [],
        hasBefore: false,
        hasAfter: false,
        beforeAnchor: null,
        afterAnchor: null,
      };
    }
    const anchorIndex = anchor
      ? descriptors.findIndex(
          (descriptor) =>
            descriptor.anchorId === anchor || descriptor.sequenceKey === anchor,
        )
      : 0;
    if (anchorIndex < 0) throw new NotFoundException('阅读锚点不存在');
    let start = Math.max(0, anchorIndex - before);
    let end = Math.min(
      descriptors.length - 1,
      anchorIndex + after,
      start + READER_RANGE_MAX_ITEMS - 1,
    );
    let markdownBytes = descriptors
      .slice(start, end + 1)
      .reduce((total, descriptor) => total + descriptor.markdownBytes, 0);
    while (markdownBytes > READER_RANGE_MAX_MARKDOWN_BYTES && start < end) {
      const trimStart = anchorIndex - start > end - anchorIndex;
      const removed = trimStart ? descriptors[start++]! : descriptors[end--]!;
      markdownBytes -= removed.markdownBytes;
    }
    const selected = descriptors.slice(start, end + 1);
    const blockIds = selected.flatMap((descriptor) =>
      descriptor.kind === 'BLOCK' ? [descriptor.block.id] : [],
    );
    const blocks = blockIds.length
      ? await this.prisma.knowledgeRenderBlock.findMany({
          where: { id: { in: blockIds } },
          select: {
            id: true,
            markdown: true,
            sourceHash: true,
            blockIndex: true,
            markdownBytes: true,
            mathCount: true,
            imageReferences: {
              select: {
                occurrenceIndex: true,
                altText: true,
                versionImage: {
                  select: {
                    entryPath: true,
                    photoId: true,
                    photo: { select: { width: true, height: true } },
                  },
                },
              },
              orderBy: { occurrenceIndex: 'asc' },
            },
          },
        })
      : [];
    const blockById = new Map(blocks.map((block) => [block.id, block]));
    return {
      readerRevision: snapshot.revision,
      items: selected.map((descriptor) => {
        if (descriptor.kind === 'HEADING') {
          return {
            kind: descriptor.kind,
            sequenceKey: descriptor.sequenceKey,
            nodeId: descriptor.node.id,
            parentId: descriptor.node.parentId,
            level: descriptor.node.level,
            title: descriptor.node.title,
            titleMarkdown:
              descriptor.node.titleMarkdown ?? descriptor.node.title,
          };
        }
        const block = blockById.get(descriptor.block.id);
        if (!block) throw new ConflictException('阅读块已变化，请刷新重试');
        return {
          kind: descriptor.kind,
          sequenceKey: descriptor.sequenceKey,
          nodeId: descriptor.node.id,
          renderBlockId: block.id,
          blockIndex: block.blockIndex,
          markdown: block.markdown,
          sourceHash: block.sourceHash,
          markdownBytes: block.markdownBytes,
          mathCount: block.mathCount,
          images: block.imageReferences.map((reference) => ({
            sourcePath: reference.versionImage.entryPath,
            occurrenceIndex: reference.occurrenceIndex,
            photoId: reference.versionImage.photoId,
            contentUrl: `/api/v1/media/images/${reference.versionImage.photoId}/content`,
            altText: reference.altText,
            width: reference.versionImage.photo.width,
            height: reference.versionImage.photo.height,
          })),
        };
      }),
      hasBefore: start > 0,
      hasAfter: end < descriptors.length - 1,
      beforeAnchor: start > 0 ? descriptors[start - 1]!.anchorId : null,
      afterAnchor:
        end < descriptors.length - 1 ? descriptors[end + 1]!.anchorId : null,
    };
  }

  private readerRevision(
    libraryId: string,
    scope: KnowledgeLibraryScope,
    documents: ReaderSnapshot['documents'],
  ) {
    return `r1.${this.hash(
      JSON.stringify({
        libraryId,
        scope,
        documents: documents.map((document) => [
          document.id,
          document.activeVersionId,
          document.version.renderBlockVersion,
          document.version.renderBlockCount,
        ]),
      }),
    )}`;
  }

  private sequenceKey(revision: string, kind: string, id: string) {
    return `s1.${this.hash(`${revision}\0${kind}\0${id}`)}`;
  }

  private outlineCursor(revision: string, index: number) {
    return `o1.${this.hash(`${revision}\0${index}`)}`;
  }

  private resolveOutlineCursor(revision: string, cursor: string, total: number) {
    for (let index = 0; index <= total; index += 1) {
      if (this.outlineCursor(revision, index) === cursor) return index;
    }
    throw new BadRequestException('大纲游标无效');
  }

  private cacheFor(snapshot: ReaderSnapshot) {
    return snapshot.library.scope === KnowledgeLibraryScope.PRIVATE
      ? { control: 'private, no-store' }
      : {
          control: 'private, must-revalidate',
          etag: `"${snapshot.revision}"`,
        };
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('base64url');
  }
}
