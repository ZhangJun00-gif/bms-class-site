import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  ContentStatus,
  IndexStatus,
  KnowledgeConversationMode,
  KnowledgeKind,
  KnowledgeLibraryScope,
  KnowledgeRenderStatus,
  Prisma,
  type User,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  KnowledgeVectorService,
  type KnowledgeVectorCandidate,
} from '../knowledge/knowledge-vector.service';
import { EmbeddingService } from './embedding.service';
import { LlmService, type RetrievedSource } from './llm.service';

const REFUSAL =
  '当前所选知识范围中没有足够证据回答这个问题。请调整问题或更换知识范围。';
const MAX_EVIDENCE = 4;

export interface KnowledgeChatInput {
  question: string;
  conversationId?: string;
  subjectId?: string;
  knowledgeMode?: KnowledgeConversationMode;
  libraryIds?: string[];
  libraryChapterIds?: string[];
}

interface ConversationScope {
  conversationId: string;
  subjectId: string;
  mode: KnowledgeConversationMode;
  libraryIds: string[];
  libraryChapterIds: string[];
}

interface VerifiedEvidence {
  id: string;
  candidateRank: number;
  score: number;
  content: string;
  contentHash: string;
  documentId: string;
  documentVersionId: string;
  libraryId: string;
  libraryName: string;
  libraryChapterId: string;
  nodeId: string;
  nodeParentId: string | null;
  nodeLevel: number;
  nodeTitle: string;
  nodeTitleMarkdown: string;
  breadcrumb: string;
  renderBlockId: string;
}

export interface PreparedKnowledgeAnswer {
  scope: ConversationScope;
  question: string;
  evidence: VerifiedEvidence[];
  citations: Array<{
    index: number;
    libraryId: string;
    libraryName: string;
    documentId: string;
    documentVersionId: string;
    libraryChapterId: string;
    nodeId: string;
    nodeTitle: string;
    nodeTitleMarkdown: string;
    headingPath: Array<{
      nodeId: string;
      level: number;
      title: string;
      titleMarkdown: string;
    }>;
    renderBlockId: string;
  }>;
  images: Array<{
    type: 'image';
    photoId: string;
    url: string;
    altText: string;
    documentId: string;
    nodeId: string;
    renderBlockId: string;
    citationIndex: number;
  }>;
}

@Injectable()
export class AiKnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    private readonly vectors: KnowledgeVectorService,
    private readonly llm: LlmService,
  ) {}

  async prepare(
    input: KnowledgeChatInput,
    user: User,
    signal?: AbortSignal,
  ): Promise<PreparedKnowledgeAnswer> {
    const scope = await this.resolveScopeAndPersistQuestion(input, user);
    await this.assertLiveScope(scope, user);
    const vector = await this.embedding.embedQuestion(input.question, signal);
    const candidates = await this.vectors.search(
      vector,
      {
        subjectId: scope.subjectId,
        mode: scope.mode,
        libraryIds: scope.libraryIds,
        libraryChapterIds: scope.libraryChapterIds,
        userId: user.id,
        embeddingModel: this.embedding.model,
      },
      signal,
    );
    const evidence = await this.verifyAndRerank(
      input.question,
      scope,
      user,
      candidates,
    );
    const headingPaths = await this.loadHeadingPaths(evidence);
    const citations = evidence.map((item, index) => ({
      index: index + 1,
      libraryId: item.libraryId,
      libraryName: item.libraryName,
      documentId: item.documentId,
      documentVersionId: item.documentVersionId,
      libraryChapterId: item.libraryChapterId,
      nodeId: item.nodeId,
      nodeTitle: item.nodeTitle,
      nodeTitleMarkdown: item.nodeTitleMarkdown,
      headingPath: headingPaths.get(item.nodeId) ?? [],
      renderBlockId: item.renderBlockId,
    }));
    const images = await this.loadImages(evidence, citations);
    return { scope, question: input.question, evidence, citations, images };
  }

  async *stream(
    prepared: PreparedKnowledgeAnswer,
    user: User,
    signal?: AbortSignal,
  ) {
    if (!prepared.evidence.length) {
      for (const part of REFUSAL.match(/.{1,24}/gu) ?? [REFUSAL]) yield part;
      return;
    }
    await this.assertLiveScope(prepared.scope, user);
    const sources: RetrievedSource[] = prepared.evidence.map((item) => ({
      id: item.id,
      libraryName: item.libraryName,
      breadcrumb: item.breadcrumb,
      content: item.content,
    }));
    for await (const token of this.llm.stream(
      prepared.question,
      sources,
      signal,
      {
        correlationType: 'AiConversation',
        correlationId: prepared.scope.conversationId,
        requestedById: user.id,
      },
    )) {
      yield token;
    }
  }

  revalidate(prepared: PreparedKnowledgeAnswer, user: User) {
    return this.assertLiveScope(prepared.scope, user);
  }

  async persistAssistant(prepared: PreparedKnowledgeAnswer, content: string) {
    const model = prepared.evidence.length
      ? this.llm.model
      : 'retrieval-refusal-v1';
    await this.prisma.$transaction([
      this.prisma.aiMessage.create({
        data: {
          conversationId: prepared.scope.conversationId,
          role: 'assistant',
          content,
          citations: prepared.citations as Prisma.InputJsonValue,
          attachments: prepared.images as Prisma.InputJsonValue,
          model,
        },
      }),
      this.prisma.aiConversation.update({
        where: { id: prepared.scope.conversationId },
        data: { updatedAt: new Date() },
      }),
    ]);
  }

  private async resolveScopeAndPersistQuestion(
    input: KnowledgeChatInput,
    user: User,
  ): Promise<ConversationScope> {
    if (input.conversationId) {
      if (
        input.subjectId !== undefined ||
        input.knowledgeMode !== undefined ||
        input.libraryIds !== undefined ||
        input.libraryChapterIds !== undefined
      ) {
        throw conflict(
          'CONVERSATION_SCOPE_IMMUTABLE',
          '续聊不能修改知识范围，请新建会话',
        );
      }
      const conversation = await this.prisma.aiConversation.findFirst({
        where: { id: input.conversationId, userId: user.id },
        select: {
          id: true,
          subjectId: true,
          knowledgeMode: true,
          libraries: { select: { libraryId: true } },
          libraryChapters: { select: { libraryChapterId: true } },
        },
      });
      if (!conversation) throw new NotFoundException('问答会话不存在');
      if (
        !conversation.subjectId ||
        !conversation.knowledgeMode ||
        !conversation.libraries.length
      ) {
        throw conflict(
          'LEGACY_CONVERSATION_READ_ONLY',
          '旧会话缺少固定知识范围，请新建会话',
        );
      }
      const scope: ConversationScope = {
        conversationId: conversation.id,
        subjectId: conversation.subjectId,
        mode: conversation.knowledgeMode,
        libraryIds: conversation.libraries.map((item) => item.libraryId).sort(),
        libraryChapterIds: conversation.libraryChapters
          .map((item) => item.libraryChapterId)
          .sort(),
      };
      await this.assertLiveScope(scope, user);
      await this.prisma.aiMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'user',
          content: input.question,
        },
      });
      return scope;
    }

    if (
      !input.subjectId ||
      !input.knowledgeMode ||
      !input.libraryIds
    ) {
      throw new BadRequestException('新会话必须选择学科、模式和知识库');
    }
    const maximumLibraries = readBoundedInteger(
      'AI_MAX_LIBRARIES_PER_CONVERSATION',
      20,
      1,
      20,
    );
    const libraryIds = uniqueIds(input.libraryIds, '知识库');
    const libraryChapterIds = uniqueIds(
      input.libraryChapterIds ?? [],
      '知识库章节',
    );
    if (libraryIds.length < 1 || libraryIds.length > maximumLibraries) {
      throw new BadRequestException(
        `每个会话必须选择 1-${maximumLibraries} 个知识库`,
      );
    }
    const requested = {
      conversationId: '',
      subjectId: input.subjectId,
      mode: input.knowledgeMode,
      libraryIds: libraryIds.sort(),
      libraryChapterIds: libraryChapterIds.sort(),
    };
    await this.assertLiveScope(requested, user);
    const conversation = await this.prisma.$transaction((transaction) =>
      transaction.aiConversation.create({
        data: {
          userId: user.id,
          subjectId: requested.subjectId,
          knowledgeMode: requested.mode,
          title: input.question.slice(0, 80),
          libraries: {
            create: requested.libraryIds.map((libraryId) => ({ libraryId })),
          },
          libraryChapters: {
            create: requested.libraryChapterIds.map((libraryChapterId) => ({
              libraryChapterId,
            })),
          },
          messages: {
            create: { role: 'user', content: input.question },
          },
        },
        select: { id: true },
      }),
    );
    return { ...requested, conversationId: conversation.id };
  }

  private async assertLiveScope(scope: ConversationScope, user: User) {
    if (user.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException('账号当前不可用');
    }
    const [subject, libraries, chapters] = await Promise.all([
      this.prisma.subject.findFirst({
        where: { id: scope.subjectId, active: true },
        select: { id: true },
      }),
      this.prisma.knowledgeLibrary.findMany({
        where: { id: { in: scope.libraryIds } },
        select: {
          id: true,
          subjectId: true,
          scope: true,
          ownerId: true,
          aiEnabled: true,
          active: true,
          deletedAt: true,
        },
      }),
      scope.libraryChapterIds.length
        ? this.prisma.knowledgeLibraryChapter.findMany({
            where: { id: { in: scope.libraryChapterIds } },
            select: { id: true, libraryId: true, active: true },
          })
        : Promise.resolve([]),
    ]);
    if (!subject || libraries.length !== scope.libraryIds.length) {
      throw new ForbiddenException('会话知识范围当前不可用');
    }
    const selected = new Set(scope.libraryIds);
    let shared = 0;
    let privateOwned = 0;
    for (const library of libraries) {
      if (
        !library.active ||
        library.deletedAt ||
        library.subjectId !== scope.subjectId
      ) {
        throw new ForbiddenException('会话知识范围当前不可用');
      }
      if (library.scope === KnowledgeLibraryScope.SHARED) shared += 1;
      else if (library.ownerId === user.id && library.aiEnabled) privateOwned += 1;
      else throw new ForbiddenException('会话知识范围当前不可用');
    }
    const modeValid =
      (scope.mode === KnowledgeConversationMode.SHARED &&
        shared === libraries.length) ||
      (scope.mode === KnowledgeConversationMode.PRIVATE &&
        privateOwned === libraries.length) ||
      (scope.mode === KnowledgeConversationMode.COMBINED &&
        shared > 0 &&
        privateOwned > 0 &&
        shared + privateOwned === libraries.length);
    if (!modeValid) throw new BadRequestException('知识库与问答模式不匹配');
    if (
      chapters.length !== scope.libraryChapterIds.length ||
      chapters.some(
        (chapter) => !chapter.active || !selected.has(chapter.libraryId),
      )
    ) {
      throw new BadRequestException('所选章节不属于当前知识库范围');
    }
  }

  private async verifyAndRerank(
    question: string,
    scope: ConversationScope,
    user: User,
    candidates: KnowledgeVectorCandidate[],
  ): Promise<VerifiedEvidence[]> {
    if (!candidates.length) return [];
    const candidateById = new Map(
      candidates.map((item, candidateRank) => [
        item.chunkId,
        { ...item, candidateRank },
      ]),
    );
    const rows = await this.prisma.knowledgeChunk.findMany({
      where: { id: { in: candidates.map((item) => item.chunkId) } },
      select: {
        id: true,
        content: true,
        contentHash: true,
        embeddingStatus: true,
        documentVersionId: true,
        nodeId: true,
        primaryRenderBlockId: true,
        primaryRenderBlock: {
          select: { id: true, nodeId: true, documentVersionId: true },
        },
        node: {
          select: {
            id: true,
            parentId: true,
            level: true,
            title: true,
            titleMarkdown: true,
            breadcrumb: true,
            documentVersionId: true,
            libraryChapterId: true,
            libraryChapter: {
              select: { libraryId: true, active: true },
            },
          },
        },
        documentVersion: {
          select: {
            id: true,
            indexStatus: true,
            renderStatus: true,
            embeddingModel: true,
            embeddingDimensions: true,
          },
        },
        document: {
          select: {
            id: true,
            kind: true,
            status: true,
            deletedAt: true,
            subjectId: true,
            libraryId: true,
            activeVersionId: true,
            library: {
              select: {
                id: true,
                name: true,
                subjectId: true,
                scope: true,
                ownerId: true,
                aiEnabled: true,
                active: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    });
    const libraryIds = new Set(scope.libraryIds);
    const chapterIds = new Set(scope.libraryChapterIds);
    const minimumScore = readMinimumScore();
    const verified: VerifiedEvidence[] = [];
    for (const row of rows) {
      const candidate = candidateById.get(row.id);
      const node = row.node;
      const version = row.documentVersion;
      const block = row.primaryRenderBlock;
      const document = row.document;
      const library = document.library;
      if (
        !candidate ||
        candidate.score < minimumScore ||
        !row.contentHash ||
        row.contentHash !== candidate.contentHash ||
        row.embeddingStatus !== IndexStatus.READY ||
        !node ||
        !version ||
        !block ||
        !row.documentVersionId ||
        !row.primaryRenderBlockId ||
        block.id !== row.primaryRenderBlockId ||
        block.nodeId !== node.id ||
        block.documentVersionId !== row.documentVersionId ||
        node.documentVersionId !== row.documentVersionId ||
        !node.libraryChapter.active ||
        node.libraryChapter.libraryId !== document.libraryId ||
        document.kind !== KnowledgeKind.MARKDOWN ||
        document.status !== ContentStatus.PUBLISHED ||
        document.deletedAt ||
        document.subjectId !== scope.subjectId ||
        !libraryIds.has(document.libraryId) ||
        document.activeVersionId !== row.documentVersionId ||
        version.id !== row.documentVersionId ||
        version.indexStatus !== IndexStatus.READY ||
        version.renderStatus !== KnowledgeRenderStatus.READY ||
        version.embeddingModel !== this.embedding.model ||
        version.embeddingDimensions !== this.embedding.dimensions ||
        library.id !== document.libraryId ||
        library.subjectId !== scope.subjectId ||
        !library.active ||
        library.deletedAt ||
        (scope.mode === KnowledgeConversationMode.SHARED &&
          library.scope !== KnowledgeLibraryScope.SHARED) ||
        (scope.mode === KnowledgeConversationMode.PRIVATE &&
          library.scope !== KnowledgeLibraryScope.PRIVATE) ||
        (chapterIds.size > 0 && !chapterIds.has(node.libraryChapterId)) ||
        (library.scope === KnowledgeLibraryScope.PRIVATE &&
          (library.ownerId !== user.id || !library.aiEnabled))
      ) {
        continue;
      }
      verified.push({
        id: row.id,
        candidateRank: candidate.candidateRank,
        score: candidate.score,
        content: row.content,
        contentHash: row.contentHash,
        documentId: document.id,
        documentVersionId: row.documentVersionId,
        libraryId: library.id,
        libraryName: library.name,
        libraryChapterId: node.libraryChapterId,
        nodeId: node.id,
        nodeParentId: node.parentId,
        nodeLevel: node.level,
        nodeTitle: node.title,
        nodeTitleMarkdown: node.titleMarkdown ?? node.title,
        breadcrumb: node.breadcrumb,
        renderBlockId: block.id,
      });
    }
    return diversifiedRanking(question, verified).slice(0, MAX_EVIDENCE);
  }

  private async loadHeadingPaths(evidence: VerifiedEvidence[]) {
    const nodes = new Map<
      string,
      {
        id: string;
        parentId: string | null;
        level: number;
        title: string;
        titleMarkdown: string | null;
        documentVersionId: string;
      }
    >();
    for (const item of evidence) {
      nodes.set(item.nodeId, {
        id: item.nodeId,
        parentId: item.nodeParentId,
        level: item.nodeLevel,
        title: item.nodeTitle,
        titleMarkdown: item.nodeTitleMarkdown,
        documentVersionId: item.documentVersionId,
      });
    }
    let pending = [
      ...new Set(
        [...nodes.values()]
          .map((node) => node.parentId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    for (let depth = 0; depth < 5 && pending.length; depth += 1) {
      const rows = await this.prisma.knowledgeNode.findMany({
        where: { id: { in: pending } },
        select: {
          id: true,
          parentId: true,
          level: true,
          title: true,
          titleMarkdown: true,
          documentVersionId: true,
        },
      });
      pending = [];
      for (const row of rows) {
        nodes.set(row.id, row);
        if (row.parentId && !nodes.has(row.parentId)) pending.push(row.parentId);
      }
      pending = [...new Set(pending)];
    }
    const result = new Map<
      string,
      Array<{
        nodeId: string;
        level: number;
        title: string;
        titleMarkdown: string;
      }>
    >();
    for (const item of evidence) {
      const path: Array<{
        nodeId: string;
        level: number;
        title: string;
        titleMarkdown: string;
      }> = [];
      let current = nodes.get(item.nodeId);
      const seen = new Set<string>();
      while (
        current &&
        current.documentVersionId === item.documentVersionId &&
        !seen.has(current.id) &&
        path.length < 5
      ) {
        seen.add(current.id);
        path.unshift({
          nodeId: current.id,
          level: current.level,
          title: current.title,
          titleMarkdown: current.titleMarkdown ?? current.title,
        });
        current = current.parentId ? nodes.get(current.parentId) : undefined;
      }
      result.set(item.nodeId, path);
    }
    return result;
  }

  private async loadImages(
    evidence: VerifiedEvidence[],
    citations: PreparedKnowledgeAnswer['citations'],
  ): Promise<PreparedKnowledgeAnswer['images']> {
    if (!evidence.length) return [];
    const byChunk = new Map(evidence.map((item, index) => [item.id, { item, index }]));
    const references = await this.prisma.knowledgeImageReference.findMany({
      where: { chunkId: { in: evidence.map((item) => item.id) } },
      select: {
        chunkId: true,
        nodeId: true,
        renderBlockId: true,
        occurrenceIndex: true,
        altText: true,
        versionImage: {
          select: { photoId: true, documentVersionId: true },
        },
      },
      orderBy: [{ occurrenceIndex: 'asc' }, { id: 'asc' }],
    });
    const maximum = readBoundedInteger(
      'AI_MAX_IMAGES_PER_RESPONSE',
      4,
      0,
      4,
    );
    if (maximum === 0) return [];
    const seen = new Set<string>();
    const result: PreparedKnowledgeAnswer['images'] = [];
    for (const reference of references) {
      if (!reference.chunkId) continue;
      const match = byChunk.get(reference.chunkId);
      if (!match || seen.has(reference.versionImage.photoId)) continue;
      const citation = citations[match.index];
      if (
        !citation ||
        reference.nodeId !== match.item.nodeId ||
        reference.renderBlockId !== match.item.renderBlockId ||
        reference.versionImage.documentVersionId !==
          match.item.documentVersionId
      ) {
        continue;
      }
      seen.add(reference.versionImage.photoId);
      result.push({
        type: 'image',
        photoId: reference.versionImage.photoId,
        url: `/api/v1/media/images/${encodeURIComponent(reference.versionImage.photoId)}/content`,
        altText: reference.altText,
        documentId: match.item.documentId,
        nodeId: match.item.nodeId,
        renderBlockId: match.item.renderBlockId,
        citationIndex: citation.index,
      });
      if (result.length >= maximum) break;
    }
    return result;
  }
}

function uniqueIds(values: string[], label: string) {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (new Set(normalized).size !== normalized.length) {
    throw new BadRequestException(`${label}不能重复选择`);
  }
  return normalized;
}

function conflict(code: string, message: string) {
  return new ConflictException({ statusCode: 409, code, message });
}

function readMinimumScore() {
  const value = Number(process.env.AI_RETRIEVAL_MIN_SCORE ?? 0.35);
  return Number.isFinite(value) && value >= -1 && value <= 1 ? value : 0.35;
}

function readBoundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function diversifiedRanking(question: string, rows: VerifiedEvidence[]) {
  const normalizedQuestion = normalize(question);
  const terms = questionTerms(question);
  const remaining = rows.map((item) => {
    const normalizedTitle = normalize(item.nodeTitle);
    const normalizedContent = normalize(item.content);
    const coverage = terms.length
      ? terms.filter((term) => normalizedContent.includes(term)).length /
        terms.length
      : 0;
    return {
      item,
      originalIndex: item.candidateRank,
      base:
        item.score +
        (normalizedTitle && normalizedQuestion.includes(normalizedTitle)
          ? 0.12
          : 0) +
        coverage * 0.08,
    };
  });
  const selected: typeof remaining = [];
  while (remaining.length && selected.length < MAX_EVIDENCE) {
    remaining.sort((left, right) => {
      const leftPenalty = diversityPenalty(left.item, selected);
      const rightPenalty = diversityPenalty(right.item, selected);
      return (
        right.base - rightPenalty - (left.base - leftPenalty) ||
        left.originalIndex - right.originalIndex ||
        left.item.id.localeCompare(right.item.id)
      );
    });
    selected.push(remaining.shift()!);
  }
  return selected.map((entry) => entry.item);
}

function diversityPenalty(
  item: VerifiedEvidence,
  selected: Array<{ item: VerifiedEvidence }>,
) {
  if (selected.some((entry) => entry.item.nodeId === item.nodeId)) return 0.05;
  if (selected.some((entry) => entry.item.documentId === item.documentId)) {
    return 0.02;
  }
  return 0;
}

function questionTerms(question: string) {
  const normalized = normalize(question);
  const values = new Set<string>();
  for (const word of normalized.match(/[a-z0-9]{2,}|[\u4e00-\u9fff]+/gu) ?? []) {
    if (/^[\u4e00-\u9fff]+$/u.test(word)) {
      for (let index = 0; index < word.length - 1; index += 1) {
        values.add(word.slice(index, index + 2));
      }
    } else values.add(word);
  }
  return [...values].slice(0, 30);
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/gu, '');
}
