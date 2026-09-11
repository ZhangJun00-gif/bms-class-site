import { createHash } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  estimateTokens,
  QUESTION_GENERATION_PROMPT_VERSION,
  strategyForQuestionComplexity,
} from '@bmc3/ai-core';
import {
  AiQuestionGenerationComplexity,
  ContentStatus,
  IndexStatus,
  KnowledgeKind,
  KnowledgeLibraryScope,
  KnowledgeRenderStatus,
  Prisma,
  QuestionType,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AiGatewayService } from './ai-gateway.service';

export const QUESTION_GENERATION_MAX_CHAPTERS = 20;
export const QUESTION_GENERATION_MAX_NODES = 20;
export const QUESTION_GENERATION_MAX_CHUNKS = 80;
export const QUESTION_GENERATION_MAX_EVIDENCE_TOKENS = 24_000;
export const QUESTION_GENERATION_MAX_DEDUP_CANDIDATES = 5_000;
const KNOWLEDGE_NODE_PATH_SEPARATOR = ' > ';

export interface QuestionGenerationInput {
  subjectId: string;
  chapterIds: string[];
  knowledgeNodeIds: string[];
  gradingType: QuestionType;
  typeLabel: string;
  complexity: AiQuestionGenerationComplexity;
  requestedCount: number;
}

export interface QuestionGenerationSourceSnapshot {
  ordinal: number;
  knowledgeNodeId: string;
  libraryId: string;
  documentId: string;
  documentVersionId: string;
  libraryChapterId: string;
  nodeTitle: string;
  nodeTitleMarkdown: string;
  breadcrumb: string;
  nodePath: string;
  pathHash: string;
  contentHash: string;
  chunkManifest: Array<{
    id: string;
    contentHash: string;
    tokenCount: number;
  }>;
  evidenceContent: string;
  chunkCount: number;
  tokenCount: number;
}

@Injectable()
export class QuestionGenerationSourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
  ) {}

  async libraries(subjectId: string) {
    await this.assertSubject(subjectId);
    const libraries = await this.prisma.knowledgeLibrary.findMany({
      where: {
        subjectId,
        scope: KnowledgeLibraryScope.SHARED,
        active: true,
        deletedAt: null,
        documents: {
          some: {
            kind: KnowledgeKind.MARKDOWN,
            status: ContentStatus.PUBLISHED,
            deletedAt: null,
            activeVersion: {
              is: {
                indexStatus: IndexStatus.READY,
                renderStatus: KnowledgeRenderStatus.READY,
              },
            },
          },
        },
      },
      select: {
        id: true,
        name: true,
        subjectId: true,
        documents: {
          where: {
            kind: KnowledgeKind.MARKDOWN,
            status: ContentStatus.PUBLISHED,
            deletedAt: null,
            activeVersion: {
              is: {
                indexStatus: IndexStatus.READY,
                renderStatus: KnowledgeRenderStatus.READY,
              },
            },
          },
          select: {
            activeVersion: { select: { nodeCount: true, chunkCount: true } },
          },
        },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      items: libraries.map(({ documents, ...library }) => ({
        ...library,
        nodeCount: documents.reduce(
          (total, document) => total + (document.activeVersion?.nodeCount ?? 0),
          0,
        ),
        chunkCount: documents.reduce(
          (total, document) => total + (document.activeVersion?.chunkCount ?? 0),
          0,
        ),
      })),
      total: libraries.length,
    };
  }

  async nodes(
    subjectId: string,
    libraryId: string,
    query: string | undefined,
    page: number,
    pageSize: number,
  ) {
    const library = await this.prisma.knowledgeLibrary.findFirst({
      where: {
        id: libraryId,
        subjectId,
        scope: KnowledgeLibraryScope.SHARED,
        active: true,
        deletedAt: null,
      },
      select: { id: true, name: true, subjectId: true },
    });
    if (!library) {
      generationError(
        'AI_GENERATION_SCOPE_INVALID',
        '所选共享知识库不存在、已停用或不属于该学科',
      );
    }
    const where = validNodeWhere(subjectId, libraryId, query);
    const [nodes, leafNodes, total] = await Promise.all([
      this.prisma.knowledgeNode.findMany({
        where,
        select: {
          id: true,
          parentId: true,
          documentVersionId: true,
          level: true,
          title: true,
          titleMarkdown: true,
          path: true,
          breadcrumb: true,
          sortOrder: true,
          libraryChapterId: true,
          documentVersion: {
            select: {
              id: true,
              documentId: true,
              activeForDocument: {
                select: { id: true, title: true, libraryId: true },
              },
            },
          },
          chunks: {
            select: { tokenCount: true, content: true },
          },
          _count: { select: { children: true } },
        },
        orderBy: [
          { documentVersion: { activeForDocument: { createdAt: 'asc' } } },
          { sortOrder: 'asc' },
          { id: 'asc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.knowledgeNode.findMany({
        where: {
          ...validNodeWhere(subjectId, libraryId),
          children: { none: {} },
        },
        select: {
          id: true,
          documentVersionId: true,
          path: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.knowledgeNode.count({ where }),
    ]);
    return {
      library,
      items: nodes.map(({ chunks, documentVersion, _count, ...node }) => {
        const leafNodeIds = leafNodes
          .filter(
            (leaf) =>
              leaf.documentVersionId === node.documentVersionId &&
              (leaf.id === node.id ||
                leaf.path.startsWith(
                  `${node.path}${KNOWLEDGE_NODE_PATH_SEPARATOR}`,
                )),
          )
          .map((leaf) => leaf.id);
        return {
          ...node,
          hasChildren: _count.children > 0,
          leafNodeCount: leafNodeIds.length,
          leafNodeIds:
            leafNodeIds.length <= QUESTION_GENERATION_MAX_NODES
              ? leafNodeIds
              : [],
          titleMarkdown: node.titleMarkdown ?? node.title,
          documentId: documentVersion.documentId,
          documentVersionId: documentVersion.id,
          chunkCount: chunks.length,
          tokenCount: chunks.reduce(
            (sum, chunk) =>
              sum + (chunk.tokenCount ?? estimateTokens(chunk.content)),
            0,
          ),
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  async preflight(input: QuestionGenerationInput) {
    const normalized = await this.validateInput(input);
    const sources = await this.snapshotSources(
      normalized.subjectId,
      normalized.knowledgeNodeIds,
    );
    const chunkCount = sources.reduce(
      (total, source) => total + source.chunkCount,
      0,
    );
    const evidenceTokens = sources.reduce(
      (total, source) => total + source.tokenCount,
      0,
    );
    if (chunkCount > QUESTION_GENERATION_MAX_CHUNKS) {
      generationError(
        'AI_GENERATION_EVIDENCE_TOO_LARGE',
        `所选节点共 ${chunkCount} 个分片，超过 ${QUESTION_GENERATION_MAX_CHUNKS} 个上限`,
        { chunkCount, maximum: QUESTION_GENERATION_MAX_CHUNKS },
      );
    }
    const maxEvidenceTokens = configuredMaximum(
      'AI_QUESTION_GENERATION_MAX_EVIDENCE_TOKENS',
      QUESTION_GENERATION_MAX_EVIDENCE_TOKENS,
    );
    if (evidenceTokens > maxEvidenceTokens) {
      generationError(
        'AI_GENERATION_EVIDENCE_TOO_LARGE',
        `所选证据约 ${evidenceTokens} token，超过 ${maxEvidenceTokens} 上限`,
        { evidenceTokens, maximum: maxEvidenceTokens },
      );
    }
    const dedupCandidates = await this.prisma.quizQuestion.count({
      where: {
        subjectId: normalized.subjectId,
        chapters: {
          some: { chapterId: { in: normalized.chapterIds } },
        },
      },
    });
    if (dedupCandidates > QUESTION_GENERATION_MAX_DEDUP_CANDIDATES) {
      generationError(
        'AI_GENERATION_DEDUP_SCOPE_TOO_BROAD',
        '当前学科/章节的去重候选超过 5000 道，请缩小章节范围',
        {
          dedupCandidates,
          maximum: QUESTION_GENERATION_MAX_DEDUP_CANDIDATES,
        },
      );
    }
    const strategy = strategyForQuestionComplexity(normalized.complexity);
    const sourceRevision = sha256(
      JSON.stringify({
        subjectId: normalized.subjectId,
        chapterIds: normalized.chapterIds,
        promptVersion: QUESTION_GENERATION_PROMPT_VERSION,
        strategy,
        sources: sources.map((source) => ({
          knowledgeNodeId: source.knowledgeNodeId,
          documentVersionId: source.documentVersionId,
          contentHash: source.contentHash,
        })),
      }),
    );
    return {
      input: normalized,
      sources,
      summary: {
        chapterCount: normalized.chapterIds.length,
        nodeCount: sources.length,
        chunkCount,
        evidenceTokens,
        dedupCandidates,
        requestedCount: normalized.requestedCount,
        strategy,
        model: this.gateway.model(strategy),
        sourceRevision,
        promptVersion: QUESTION_GENERATION_PROMPT_VERSION,
        maxOutputTokens: configuredMaximum(
          'AI_QUESTION_GENERATION_MAX_OUTPUT_TOKENS',
          8_000,
        ),
      },
    };
  }

  async snapshotSources(subjectId: string, knowledgeNodeIds: string[]) {
    const nodes = await this.prisma.knowledgeNode.findMany({
      where: {
        id: { in: knowledgeNodeIds },
        ...validNodeWhere(subjectId),
        children: { none: {} },
      },
      select: {
        id: true,
        title: true,
        titleMarkdown: true,
        path: true,
        pathHash: true,
        breadcrumb: true,
        libraryChapterId: true,
        documentVersion: {
          select: {
            id: true,
            documentId: true,
            activeForDocument: {
              select: { id: true, libraryId: true },
            },
          },
        },
        chunks: {
          select: {
            id: true,
            content: true,
            contentHash: true,
            tokenCount: true,
          },
          orderBy: { chunkIndex: 'asc' },
        },
        body: true,
      },
    });
    if (nodes.length !== knowledgeNodeIds.length) {
      generationError(
        'AI_GENERATION_UNKNOWN_NODE',
        '知识证据必须全部是同学科活动共享库已发布 READY 版本中的末级标题',
      );
    }
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return knowledgeNodeIds.map((id, ordinal): QuestionGenerationSourceSnapshot => {
      const node = nodeById.get(id)!;
      const chunks = node.chunks.length
        ? node.chunks
        : [
            {
              id: `${node.id}:body`,
              content: node.body,
              contentHash: sha256(node.body),
              tokenCount: estimateTokens(node.body),
            },
          ];
      const chunkManifest = chunks.map((chunk) => ({
        id: chunk.id,
        contentHash: chunk.contentHash ?? sha256(chunk.content),
        tokenCount: chunk.tokenCount ?? estimateTokens(chunk.content),
      }));
      const evidenceContent = chunks
        .map((chunk) => chunk.content.trim())
        .filter(Boolean)
        .join('\n\n');
      if (!evidenceContent) {
        generationError(
          'AI_GENERATION_SCOPE_INVALID',
          `知识节点“${node.title}”没有可用于出题的正文`,
        );
      }
      return {
        ordinal,
        knowledgeNodeId: node.id,
        libraryId: node.documentVersion.activeForDocument!.libraryId,
        documentId: node.documentVersion.documentId,
        documentVersionId: node.documentVersion.id,
        libraryChapterId: node.libraryChapterId,
        nodeTitle: node.title,
        nodeTitleMarkdown: node.titleMarkdown ?? node.title,
        breadcrumb: node.breadcrumb,
        nodePath: node.path,
        pathHash: node.pathHash,
        contentHash: sha256(
          JSON.stringify({ chunkManifest, evidenceContent }),
        ),
        chunkManifest,
        evidenceContent,
        chunkCount: chunks.length,
        tokenCount: chunkManifest.reduce(
          (total, chunk) => total + chunk.tokenCount,
          0,
        ),
      };
    });
  }

  async expandKnowledgeNodeIds(subjectId: string, value: unknown) {
    const selectedIds = uniqueIds(
      value,
      'knowledgeNodeIds',
      QUESTION_GENERATION_MAX_NODES,
    );
    const selectedNodes = await this.prisma.knowledgeNode.findMany({
      where: {
        id: { in: selectedIds },
        ...validNodeWhere(subjectId),
      },
      select: {
        id: true,
        documentVersionId: true,
        path: true,
      },
    });
    if (selectedNodes.length !== selectedIds.length) {
      generationError(
        'AI_GENERATION_UNKNOWN_NODE',
        '知识节点必须全部来自同学科活动共享库的已发布 READY 版本',
      );
    }
    const selectedById = new Map(selectedNodes.map((node) => [node.id, node]));
    const leaves = await this.prisma.knowledgeNode.findMany({
      where: {
        ...validNodeWhere(subjectId),
        children: { none: {} },
        OR: selectedNodes.map((node) => ({
          documentVersionId: node.documentVersionId,
          OR: [
            { id: node.id },
            {
              path: {
                startsWith: `${node.path}${KNOWLEDGE_NODE_PATH_SEPARATOR}`,
              },
            },
          ],
        })),
      },
      select: {
        id: true,
        documentVersionId: true,
        path: true,
        sortOrder: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const leafIds = selectedIds.flatMap((selectedId) => {
      const selected = selectedById.get(selectedId)!;
      return leaves
        .filter(
          (leaf) =>
            leaf.documentVersionId === selected.documentVersionId &&
            (leaf.id === selected.id ||
              leaf.path.startsWith(
                `${selected.path}${KNOWLEDGE_NODE_PATH_SEPARATOR}`,
              )),
        )
        .map((leaf) => leaf.id);
    });
    const uniqueLeafIds = [...new Set(leafIds)];
    if (!uniqueLeafIds.length) {
      generationError(
        'AI_GENERATION_UNKNOWN_NODE',
        '所选标题下没有可用于出题的末级知识证据',
      );
    }
    if (uniqueLeafIds.length > QUESTION_GENERATION_MAX_NODES) {
      generationError(
        'AI_GENERATION_SCOPE_INVALID',
        `所选标题共包含 ${uniqueLeafIds.length} 条末级证据，超过 ${QUESTION_GENERATION_MAX_NODES} 条上限`,
        {
          nodeCount: uniqueLeafIds.length,
          maximum: QUESTION_GENERATION_MAX_NODES,
        },
      );
    }
    return uniqueLeafIds;
  }

  private async validateInput(input: QuestionGenerationInput) {
    const subjectId = requiredText(input.subjectId, 'subjectId', 191);
    await this.assertSubject(subjectId);
    const chapterIds = uniqueIds(
      input.chapterIds,
      'chapterIds',
      QUESTION_GENERATION_MAX_CHAPTERS,
    );
    const knowledgeNodeIds = await this.expandKnowledgeNodeIds(
      subjectId,
      input.knowledgeNodeIds,
    );
    if (!Object.values(QuestionType).includes(input.gradingType)) {
      generationError('AI_GENERATION_SCOPE_INVALID', '请选择有效判分类型');
    }
    if (
      !Object.values(AiQuestionGenerationComplexity).includes(input.complexity)
    ) {
      generationError('AI_GENERATION_SCOPE_INVALID', '请选择有效复杂度');
    }
    const typeLabel = requiredText(input.typeLabel, 'typeLabel', 100);
    if (typeLabel === '往年真题') {
      generationError(
        'AI_GENERATION_SCOPE_INVALID',
        'AI 出题不能使用保留标签“往年真题”',
      );
    }
    if (
      !Number.isInteger(input.requestedCount) ||
      input.requestedCount < 1 ||
      input.requestedCount > 20
    ) {
      generationError(
        'AI_GENERATION_SCOPE_INVALID',
        'requestedCount 必须是 1-20 的整数',
      );
    }
    const chapters = await this.prisma.subjectChapter.count({
      where: { id: { in: chapterIds }, subjectId, active: true },
    });
    if (chapters !== chapterIds.length) {
      generationError(
        'AI_GENERATION_UNKNOWN_CHAPTER',
        '题库目标章节必须全部启用且属于所选学科',
      );
    }
    return {
      subjectId,
      chapterIds,
      knowledgeNodeIds,
      gradingType: input.gradingType,
      typeLabel,
      complexity: input.complexity,
      requestedCount: input.requestedCount,
    };
  }

  private async assertSubject(subjectId: string) {
    const subject = await this.prisma.subject.findFirst({
      where: { id: subjectId, active: true },
      select: { id: true },
    });
    if (!subject) {
      generationError(
        'AI_GENERATION_SCOPE_INVALID',
        '所选学科不存在或已停用',
      );
    }
  }
}

export function validNodeWhere(
  subjectId: string,
  libraryId?: string,
  query?: string,
): Prisma.KnowledgeNodeWhereInput {
  return {
    ...(query?.trim()
      ? {
          OR: [
            { title: { contains: query.trim() } },
            { breadcrumb: { contains: query.trim() } },
          ],
        }
      : {}),
    libraryChapter: {
      active: true,
      library: {
        id: libraryId,
        subjectId,
        scope: KnowledgeLibraryScope.SHARED,
        active: true,
        deletedAt: null,
      },
    },
    documentVersion: {
      indexStatus: IndexStatus.READY,
      renderStatus: KnowledgeRenderStatus.READY,
      activeForDocument: {
        is: {
          kind: KnowledgeKind.MARKDOWN,
          status: ContentStatus.PUBLISHED,
          deletedAt: null,
          library: {
            id: libraryId,
            subjectId,
            scope: KnowledgeLibraryScope.SHARED,
            active: true,
            deletedAt: null,
          },
        },
      },
    },
  };
}

export function generationError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new BadRequestException({ statusCode: 400, code, message, ...details });
}

function uniqueIds(value: unknown, field: string, maximum: number) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maximum ||
    value.some(
      (item) =>
        typeof item !== 'string' || !item.trim() || item.length > 191,
    )
  ) {
    generationError(
      'AI_GENERATION_SCOPE_INVALID',
      `${field} 必须包含 1-${maximum} 个有效 ID`,
    );
  }
  const normalized = value.map((item) => (item as string).trim());
  if (new Set(normalized).size !== normalized.length) {
    generationError(
      'AI_GENERATION_SCOPE_INVALID',
      `${field} 不能包含重复 ID`,
    );
  }
  return normalized;
}

function requiredText(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'string') {
    generationError('AI_GENERATION_SCOPE_INVALID', `${field} 必须是字符串`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    generationError(
      'AI_GENERATION_SCOPE_INVALID',
      `${field} 长度必须是 1-${maximum}`,
    );
  }
  return normalized;
}

function configuredMaximum(name: string, hardMaximum: number) {
  const value = Number(process.env[name] ?? hardMaximum);
  if (!Number.isInteger(value) || value < 1 || value > hardMaximum) {
    generationError(
      'AI_GENERATION_SCOPE_INVALID',
      `${name} 必须是 1-${hardMaximum} 的整数`,
    );
  }
  return value;
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
