import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { prepareQuestion, type QuestionInput } from '@bmc3/quiz-core';
import {
  ContentStatus,
  IndexStatus,
  KnowledgeKind,
  KnowledgeLibraryScope,
  KnowledgeRenderStatus,
  Prisma,
  QuizQuestionCategory,
  QuizQuestionOrigin,
  QuizQuestionReviewAction,
  QuizQuestionReviewStatus,
  QuizQuestionSourceReviewStatus,
  type QuestionType,
  type User,
} from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { markQuestionSourcesReviewRequired } from '../quiz/question-source-lifecycle';
import {
  generationError,
  QuestionGenerationSourceService,
  validNodeWhere,
  type QuestionGenerationSourceSnapshot,
} from './question-generation-source.service';

export interface QuestionReviewInput {
  expectedRevision: number;
  typeLabel: string;
  chapterIds: string[];
  prompt: string;
  options: Array<{ id: string; text: string }>;
  correctAnswer: string[];
  gradingRubric?: Record<string, unknown> | null;
  explanation: string;
}

export interface BulkRevalidateSourceResultItem {
  questionId: string;
  status: 'REVALIDATED' | 'SKIPPED' | 'FAILED';
  reason?: string;
  sourceRevision?: number;
}

@Injectable()
export class QuestionReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sourceService: QuestionGenerationSourceService,
    private readonly audit: AuditService,
  ) {}

  async list(query: {
    reviewStatus: QuizQuestionReviewStatus;
    sourceReviewStatus?: QuizQuestionSourceReviewStatus;
    subjectId?: string;
    gradingType?: QuestionType;
    createdById?: string;
    search?: string;
    page: number;
    pageSize: number;
  }) {
    const where: Prisma.QuizQuestionWhereInput = {
      origin: QuizQuestionOrigin.AI_GENERATED,
      reviewStatus: query.reviewStatus,
      ...(query.sourceReviewStatus
        ? { sourceReviewStatus: query.sourceReviewStatus }
        : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.gradingType ? { type: query.gradingType } : {}),
      ...(query.createdById ? { authorId: query.createdById } : {}),
      ...(query.search ? { prompt: { contains: query.search.trim() } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.quizQuestion.findMany({
        where,
        select: reviewListSelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.quizQuestion.count({ where }),
    ]);
    return {
      items: items.map(serializeReviewListItem),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(questionId: string) {
    const question = await this.prisma.quizQuestion.findFirst({
      where: { id: questionId, origin: QuizQuestionOrigin.AI_GENERATED },
      include: reviewDetailInclude,
    });
    if (!question) throw new NotFoundException('AI 题目不存在');
    return serializeReviewDetail(question);
  }

  save(user: User, questionId: string, input: QuestionReviewInput) {
    return this.saveOrApprove(user, questionId, input, false);
  }

  async approve(user: User, questionId: string, input: QuestionReviewInput) {
    await this.assertSourcesCurrent(questionId);
    return this.saveOrApprove(user, questionId, input, true);
  }

  async reject(
    user: User,
    questionId: string,
    expectedRevision: number,
    reason: string,
  ) {
    const note = reason.trim();
    if (!note || note.length > 1_000) {
      throw new BadRequestException('拒绝原因必须为 1-1000 个字符');
    }
    await this.prisma.$transaction(async (transaction) => {
      await lockQuestion(transaction, questionId);
      const question = await transaction.quizQuestion.findFirst({
        where: { id: questionId, origin: QuizQuestionOrigin.AI_GENERATED },
        include: { chapters: true },
      });
      if (!question) throw new NotFoundException('AI 题目不存在');
      assertRevision(question.reviewRevision, expectedRevision);
      if (question.reviewStatus !== QuizQuestionReviewStatus.DRAFT_REVIEW) {
        statusConflict('只有待审核草稿可以拒绝');
      }
      const before = reviewSnapshot(question);
      await transaction.quizQuestion.update({
        where: { id: questionId },
        data: {
          reviewStatus: QuizQuestionReviewStatus.REJECTED,
          reviewRevision: { increment: 1 },
        },
      });
      await transaction.quizQuestionReviewEvent.create({
        data: {
          questionId,
          reviewerId: user.id,
          action: QuizQuestionReviewAction.REJECT,
          expectedRevision,
          note,
          beforeSnapshot: before as unknown as Prisma.InputJsonValue,
          afterSnapshot: {
            ...before,
            reviewStatus: QuizQuestionReviewStatus.REJECTED,
          } as unknown as Prisma.InputJsonValue,
          fieldDiff: {
            reviewStatus: {
              before: question.reviewStatus,
              after: QuizQuestionReviewStatus.REJECTED,
            },
          },
          sourceRevision: question.sourceRevision,
        },
      });
      await this.audit.record(
        user.id,
        'ai.question-review.reject',
        'QuizQuestion',
        questionId,
        { expectedRevision },
        transaction,
      );
    });
    return this.get(questionId);
  }

  async reopen(user: User, questionId: string, expectedRevision: number) {
    await this.prisma.$transaction(
      async (transaction) => {
        await lockQuestion(transaction, questionId);
        const question = await transaction.quizQuestion.findFirst({
          where: { id: questionId, origin: QuizQuestionOrigin.AI_GENERATED },
          include: { chapters: true },
        });
        if (!question) throw new NotFoundException('AI 题目不存在');
        assertRevision(question.reviewRevision, expectedRevision);
        if (question.reviewStatus !== QuizQuestionReviewStatus.APPROVED) {
          statusConflict('只有已批准题目可以撤回为草稿');
        }
        const before = reviewSnapshot(question);
        const after = {
          ...before,
          reviewStatus: QuizQuestionReviewStatus.DRAFT_REVIEW,
        };
        await transaction.quizQuestion.update({
          where: { id: questionId },
          data: {
            reviewStatus: QuizQuestionReviewStatus.DRAFT_REVIEW,
            reviewRevision: { increment: 1 },
          },
        });
        await transaction.quizQuestionReviewEvent.create({
          data: {
            questionId,
            reviewerId: user.id,
            action: QuizQuestionReviewAction.REOPEN,
            expectedRevision,
            beforeSnapshot: before as unknown as Prisma.InputJsonValue,
            afterSnapshot: after as unknown as Prisma.InputJsonValue,
            fieldDiff: {
              reviewStatus: {
                before: question.reviewStatus,
                after: QuizQuestionReviewStatus.DRAFT_REVIEW,
              },
            },
            sourceRevision: question.sourceRevision,
          },
        });
        await this.audit.record(
          user.id,
          'ai.question-review.reopen',
          'QuizQuestion',
          questionId,
          { expectedRevision },
          transaction,
        );
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
    return this.get(questionId);
  }

  async revalidateSource(
    user: User,
    questionId: string,
    expectedRevision: number,
    knowledgeNodeIds: string[],
  ) {
    const question = await this.prisma.quizQuestion.findFirst({
      where: { id: questionId, origin: QuizQuestionOrigin.AI_GENERATED },
      select: {
        id: true,
        subjectId: true,
        reviewRevision: true,
        reviewStatus: true,
        sourceRevision: true,
      },
    });
    if (!question) throw new NotFoundException('AI 题目不存在');
    assertRevision(question.reviewRevision, expectedRevision);
    const leafNodeIds = await this.sourceService.expandKnowledgeNodeIds(
      question.subjectId,
      knowledgeNodeIds,
    );
    const snapshots = await this.sourceService.snapshotSources(
      question.subjectId,
      leafNodeIds,
    );
    await this.prisma.$transaction(
      async (transaction) => {
        await lockQuestion(transaction, questionId);
        const current = await transaction.quizQuestion.findUniqueOrThrow({
          where: { id: questionId },
        });
        assertRevision(current.reviewRevision, expectedRevision);
        if (current.origin !== QuizQuestionOrigin.AI_GENERATED) {
          throw new NotFoundException('AI 题目不存在');
        }
        await this.persistSourceRevalidation(transaction, {
          userId: user.id,
          questionId,
          expectedRevision,
          currentSourceRevision: current.sourceRevision,
          currentSourceReviewStatus: current.sourceReviewStatus,
          snapshots,
          leafNodeIds,
          bulk: false,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
    return this.get(questionId);
  }

  async bulkRevalidateSources(user: User, questionIds: string[]) {
    const results: BulkRevalidateSourceResultItem[] = [];
    for (const questionId of questionIds) {
      results.push(await this.revalidateSourceAutomatically(user, questionId));
    }
    return { results };
  }

  async markSourcesReviewRequired(input: {
    documentVersionId?: string;
    documentId?: string;
    libraryId?: string;
  }, transaction: Prisma.TransactionClient = this.prisma) {
    return markQuestionSourcesReviewRequired(transaction, input);
  }

  private async revalidateSourceAutomatically(
    user: User,
    questionId: string,
  ): Promise<BulkRevalidateSourceResultItem> {
    try {
      const question = await this.prisma.quizQuestion.findFirst({
        where: { id: questionId },
        select: {
          id: true,
          subjectId: true,
          origin: true,
          reviewStatus: true,
          sourceReviewStatus: true,
          knowledgeSources: {
            where: { current: true },
            orderBy: { ordinal: 'asc' },
            select: {
              documentId: true,
              libraryId: true,
              nodePathHash: true,
              knowledgeNode: { select: { pathHash: true } },
            },
          },
        },
      });
      if (!question) {
        return { questionId, status: 'SKIPPED', reason: 'NOT_FOUND' };
      }
      if (
        question.origin !== QuizQuestionOrigin.AI_GENERATED ||
        question.reviewStatus !== QuizQuestionReviewStatus.APPROVED ||
        question.sourceReviewStatus !==
          QuizQuestionSourceReviewStatus.REVIEW_REQUIRED
      ) {
        return {
          questionId,
          status: 'SKIPPED',
          reason: 'NOT_PENDING_SOURCE_REVIEW',
        };
      }
      if (!question.knowledgeSources.length) {
        return { questionId, status: 'FAILED', reason: 'SOURCE_PATH_UNKNOWN' };
      }
      const leafNodeIds: string[] = [];
      for (const source of question.knowledgeSources) {
        const pathHash =
          source.nodePathHash ?? source.knowledgeNode?.pathHash ?? null;
        if (!pathHash) {
          return {
            questionId,
            status: 'FAILED',
            reason: 'SOURCE_PATH_UNKNOWN',
          };
        }
        leafNodeIds.push(
          await this.resolveReplacementLeafNodeId(
            question.subjectId,
            source,
            pathHash,
          ),
        );
      }
      const uniqueLeafNodeIds = [...new Set(leafNodeIds)];
      const snapshots = await this.sourceService.snapshotSources(
        question.subjectId,
        uniqueLeafNodeIds,
      );
      const outcome = await this.prisma.$transaction(
        async (transaction) => {
          await lockQuestion(transaction, questionId);
          const current = await transaction.quizQuestion.findUniqueOrThrow({
            where: { id: questionId },
          });
          if (
            current.origin !== QuizQuestionOrigin.AI_GENERATED ||
            current.reviewStatus !== QuizQuestionReviewStatus.APPROVED ||
            current.sourceReviewStatus !==
              QuizQuestionSourceReviewStatus.REVIEW_REQUIRED
          ) {
            return {
              status: 'SKIPPED' as const,
              reason: 'NOT_PENDING_SOURCE_REVIEW',
            };
          }
          const nextSourceRevision = await this.persistSourceRevalidation(
            transaction,
            {
              userId: user.id,
              questionId,
              expectedRevision: current.reviewRevision,
              currentSourceRevision: current.sourceRevision,
              currentSourceReviewStatus: current.sourceReviewStatus,
              snapshots,
              leafNodeIds: uniqueLeafNodeIds,
              bulk: true,
            },
          );
          return {
            status: 'REVALIDATED' as const,
            sourceRevision: nextSourceRevision,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000,
        },
      );
      return { questionId, ...outcome };
    } catch (error) {
      return { questionId, status: 'FAILED', reason: bulkFailureReason(error) };
    }
  }

  private async resolveReplacementLeafNodeId(
    subjectId: string,
    source: { documentId: string; libraryId: string },
    pathHash: string,
  ) {
    const sameDocumentNode = await this.prisma.knowledgeNode.findFirst({
      where: {
        AND: [
          validNodeWhere(subjectId),
          {
            pathHash,
            children: { none: {} },
            documentVersion: {
              activeForDocument: { is: { id: source.documentId } },
            },
          },
        ],
      },
      select: { id: true },
    });
    if (sameDocumentNode) return sameDocumentNode.id;
    const candidates = await this.prisma.knowledgeDocument.findMany({
      where: {
        libraryId: source.libraryId,
        subjectId,
        kind: KnowledgeKind.MARKDOWN,
        status: ContentStatus.PUBLISHED,
        indexStatus: IndexStatus.READY,
        deletedAt: null,
        subject: { active: true },
        library: {
          scope: KnowledgeLibraryScope.SHARED,
          active: true,
          deletedAt: null,
        },
        activeVersion: {
          is: {
            indexStatus: IndexStatus.READY,
            renderStatus: KnowledgeRenderStatus.READY,
            nodes: {
              some: {
                pathHash,
                children: { none: {} },
                libraryChapter: { active: true },
              },
            },
          },
        },
      },
      select: { id: true },
    });
    const candidateDocumentIds = [
      ...new Set(candidates.map((candidate) => candidate.id)),
    ];
    if (!candidateDocumentIds.length) {
      generationError(
        'SOURCE_NODE_NOT_FOUND',
        '原知识库中没有可替换该来源的已发布知识文档',
      );
    }
    if (candidateDocumentIds.length > 1) {
      generationError(
        'SOURCE_NODE_AMBIGUOUS',
        '原知识库中存在多个可替换该来源的知识文档，请人工绑定证据',
      );
    }
    const replacementNode = await this.prisma.knowledgeNode.findFirst({
      where: {
        AND: [
          validNodeWhere(subjectId),
          {
            pathHash,
            children: { none: {} },
            documentVersion: {
              activeForDocument: { is: { id: candidateDocumentIds[0]! } },
            },
          },
        ],
      },
      select: { id: true },
    });
    if (!replacementNode) {
      generationError(
        'SOURCE_NODE_NOT_FOUND',
        '替换知识文档的当前版本中没有匹配的知识节点',
      );
    }
    return replacementNode.id;
  }

  private async persistSourceRevalidation(
    transaction: Prisma.TransactionClient,
    input: {
      userId: string;
      questionId: string;
      expectedRevision: number;
      currentSourceRevision: number;
      currentSourceReviewStatus: QuizQuestionSourceReviewStatus;
      snapshots: QuestionGenerationSourceSnapshot[];
      leafNodeIds: string[];
      bulk: boolean;
    },
  ) {
    const nextSourceRevision = input.currentSourceRevision + 1;
    await transaction.quizQuestionKnowledgeSource.updateMany({
      where: { questionId: input.questionId, current: true },
      data: { current: false, supersededAt: new Date() },
    });
    await transaction.quizQuestionKnowledgeSource.createMany({
      data: input.snapshots.map((source, ordinal) => ({
        id: randomUUID(),
        questionId: input.questionId,
        sourceRevision: nextSourceRevision,
        ordinal,
        knowledgeNodeId: source.knowledgeNodeId,
        documentId: source.documentId,
        documentVersionId: source.documentVersionId,
        libraryId: source.libraryId,
        libraryChapterId: source.libraryChapterId,
        nodePathHash: source.pathHash,
        title: source.nodeTitle,
        breadcrumb: source.breadcrumb,
        contentHash: source.contentHash,
        evidenceContent: source.evidenceContent,
        current: true,
      })),
    });
    await transaction.quizQuestion.update({
      where: { id: input.questionId },
      data: {
        sourceRevision: nextSourceRevision,
        sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
        sourceReviewRequiredAt: null,
        reviewRevision: { increment: 1 },
      },
    });
    await transaction.quizQuestionReviewEvent.create({
      data: {
        questionId: input.questionId,
        reviewerId: input.userId,
        action: QuizQuestionReviewAction.SOURCE_REVALIDATE,
        expectedRevision: input.expectedRevision,
        beforeSnapshot: {
          sourceRevision: input.currentSourceRevision,
          sourceReviewStatus: input.currentSourceReviewStatus,
        },
        afterSnapshot: {
          sourceRevision: nextSourceRevision,
          sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
          knowledgeNodeIds: input.leafNodeIds,
          ...(input.bulk ? { bulk: true } : {}),
        },
        fieldDiff: {
          sourceRevision: {
            before: input.currentSourceRevision,
            after: nextSourceRevision,
          },
        },
        sourceRevision: nextSourceRevision,
      },
    });
    await this.audit.record(
      input.userId,
      'ai.question-review.source-revalidate',
      'QuizQuestion',
      input.questionId,
      {
        expectedRevision: input.expectedRevision,
        sourceRevision: nextSourceRevision,
        ...(input.bulk ? { bulk: true } : {}),
      },
      transaction,
    );
    return nextSourceRevision;
  }

  private async saveOrApprove(
    user: User,
    questionId: string,
    input: QuestionReviewInput,
    approve: boolean,
  ) {
    await this.prisma.$transaction(
      async (transaction) => {
        await lockQuestion(transaction, questionId);
        const existing = await transaction.quizQuestion.findFirst({
          where: { id: questionId, origin: QuizQuestionOrigin.AI_GENERATED },
          include: { chapters: true },
        });
        if (!existing) throw new NotFoundException('AI 题目不存在');
        assertRevision(existing.reviewRevision, input.expectedRevision);
        if (existing.reviewStatus !== QuizQuestionReviewStatus.DRAFT_REVIEW) {
          statusConflict('只有待审核草稿可以保存或发布');
        }
        if (
          approve &&
          existing.sourceReviewStatus !== QuizQuestionSourceReviewStatus.VALID
        ) {
          statusConflict('来源待复核，不能发布');
        }
        const prepared = prepareReviewQuestion(existing, input);
        const chapterCount = await transaction.subjectChapter.count({
          where: {
            id: { in: prepared.chapterIds },
            subjectId: existing.subjectId,
            active: true,
          },
        });
        if (chapterCount !== prepared.chapterIds.length) {
          throw new BadRequestException('章节必须全部启用且属于题目学科');
        }
        const before = reviewSnapshot(existing);
        const after = {
          ...before,
          typeLabel: prepared.typeLabel,
          chapterIds: prepared.chapterIds,
          prompt: prepared.prompt,
          options: prepared.options,
          correctAnswer: prepared.correctAnswer,
          gradingRubric: prepared.gradingRubric ?? null,
          explanation: prepared.explanation,
          maxScore: prepared.maxScore,
          reviewStatus: approve
            ? QuizQuestionReviewStatus.APPROVED
            : QuizQuestionReviewStatus.DRAFT_REVIEW,
        };
        await transaction.quizQuestionChapter.deleteMany({
          where: { questionId },
        });
        await transaction.quizQuestion.update({
          where: { id: questionId },
          data: {
            typeLabel: prepared.typeLabel,
            prompt: prepared.prompt,
            options: prepared.options as unknown as Prisma.InputJsonValue,
            correctAnswer:
              prepared.correctAnswer as unknown as Prisma.InputJsonValue,
            gradingRubric: prepared.gradingRubric
              ? (prepared.gradingRubric as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
            maxScore: prepared.maxScore,
            explanation: prepared.explanation,
            reviewStatus: approve
              ? QuizQuestionReviewStatus.APPROVED
              : QuizQuestionReviewStatus.DRAFT_REVIEW,
            reviewRevision: { increment: 1 },
            chapters: {
              createMany: {
                data: prepared.chapterIds.map((chapterId) => ({ chapterId })),
              },
            },
          },
        });
        await transaction.quizQuestionReviewEvent.create({
          data: {
            questionId,
            reviewerId: user.id,
            action: approve
              ? QuizQuestionReviewAction.APPROVE
              : QuizQuestionReviewAction.SAVE_DRAFT,
            expectedRevision: input.expectedRevision,
            beforeSnapshot: before as unknown as Prisma.InputJsonValue,
            afterSnapshot: after as unknown as Prisma.InputJsonValue,
            fieldDiff: diffSnapshots(before, after) as Prisma.InputJsonValue,
            sourceRevision: existing.sourceRevision,
          },
        });
        await this.audit.record(
          user.id,
          approve ? 'ai.question-review.approve' : 'ai.question-review.save',
          'QuizQuestion',
          questionId,
          { expectedRevision: input.expectedRevision },
          transaction,
        );
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
    return this.get(questionId);
  }

  private async assertSourcesCurrent(questionId: string) {
    const question = await this.prisma.quizQuestion.findFirst({
      where: { id: questionId, origin: QuizQuestionOrigin.AI_GENERATED },
      select: {
        subjectId: true,
        sourceReviewStatus: true,
        knowledgeSources: {
          where: { current: true },
          select: {
            knowledgeNodeId: true,
            documentId: true,
            documentVersionId: true,
            libraryId: true,
            libraryChapterId: true,
            contentHash: true,
          },
          orderBy: { ordinal: 'asc' },
        },
      },
    });
    if (!question) throw new NotFoundException('AI 题目不存在');
    if (
      question.sourceReviewStatus !== QuizQuestionSourceReviewStatus.VALID ||
      !question.knowledgeSources.length ||
      question.knowledgeSources.some((source) => !source.knowledgeNodeId)
    ) {
      statusConflict('题目来源待复核，不能发布');
    }
    try {
      const snapshots = await this.sourceService.snapshotSources(
        question.subjectId,
        question.knowledgeSources.map((source) => source.knowledgeNodeId!),
      );
      const valid = snapshots.every((snapshot, index) => {
        const source = question.knowledgeSources[index]!;
        return (
          snapshot.documentId === source.documentId &&
          snapshot.documentVersionId === source.documentVersionId &&
          snapshot.libraryId === source.libraryId &&
          snapshot.libraryChapterId === source.libraryChapterId &&
          snapshot.contentHash === source.contentHash
        );
      });
      if (valid) return;
    } catch {
      // The state transition below is the authoritative failure response.
    }
    await this.prisma.quizQuestion.updateMany({
      where: {
        id: questionId,
        sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
      },
      data: {
        sourceReviewStatus: QuizQuestionSourceReviewStatus.REVIEW_REQUIRED,
        sourceReviewRequiredAt: new Date(),
      },
    });
    statusConflict('知识来源已变化，请重新绑定证据后再发布');
  }
}

const reviewListSelect = {
  id: true,
  type: true,
  typeLabel: true,
  subjectId: true,
  subject: { select: { id: true, name: true, slug: true } },
  chapters: {
    select: { chapter: { select: { id: true, name: true, slug: true } } },
  },
  prompt: true,
  reviewStatus: true,
  reviewRevision: true,
  sourceReviewStatus: true,
  sourceReviewRequiredAt: true,
  author: { select: { id: true, displayName: true } },
  generationItem: {
    select: {
      job: {
        select: {
          id: true,
          complexity: true,
          createdAt: true,
          createdBy: { select: { id: true, displayName: true } },
        },
      },
    },
  },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.QuizQuestionSelect;

const reviewDetailInclude = {
  subject: { select: { id: true, name: true, slug: true } },
  chapters: {
    select: { chapter: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  generationItem: {
    include: {
      job: {
        select: {
          id: true,
          complexity: true,
          promptVersion: true,
          configSnapshot: true,
          createdAt: true,
          createdBy: { select: { id: true, displayName: true } },
        },
      },
    },
  },
  knowledgeSources: {
    orderBy: [
      { sourceRevision: 'desc' as const },
      { ordinal: 'asc' as const },
    ],
  },
  reviewEvents: {
    include: { reviewer: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: 'desc' as const },
  },
} satisfies Prisma.QuizQuestionInclude;

type ReviewListItem = Prisma.QuizQuestionGetPayload<{
  select: typeof reviewListSelect;
}>;
type ReviewDetail = Prisma.QuizQuestionGetPayload<{
  include: typeof reviewDetailInclude;
}>;

function serializeReviewListItem(question: ReviewListItem) {
  return {
    ...question,
    chapterIds: question.chapters.map(({ chapter }) => chapter.id),
    chapters: question.chapters.map(({ chapter }) => chapter),
    generationJob: question.generationItem?.job ?? null,
    generationItem: undefined,
  };
}

function serializeReviewDetail(question: ReviewDetail) {
  return {
    id: question.id,
    gradingType: question.type,
    typeLabel: question.typeLabel,
    subjectId: question.subjectId,
    subject: question.subject,
    chapterIds: question.chapters.map(({ chapter }) => chapter.id),
    chapters: question.chapters.map(({ chapter }) => chapter),
    category: question.category,
    origin: question.origin,
    prompt: question.prompt,
    options: question.options,
    correctAnswer: question.correctAnswer,
    gradingRubric: question.gradingRubric,
    maxScore: question.maxScore,
    explanation: question.explanation,
    reviewStatus: question.reviewStatus,
    reviewRevision: question.reviewRevision,
    sourceRevision: question.sourceRevision,
    sourceReviewStatus: question.sourceReviewStatus,
    sourceReviewRequiredAt: question.sourceReviewRequiredAt,
    originalGenerated: question.generationItem?.generatedSnapshot ?? null,
    generationJob: question.generationItem?.job ?? null,
    sources: question.knowledgeSources.map((source) => ({
      id: source.id,
      sourceRevision: source.sourceRevision,
      ordinal: source.ordinal,
      current: source.current,
      knowledgeNodeId: source.knowledgeNodeId,
      documentId: source.documentId,
      documentVersionId: source.documentVersionId,
      libraryId: source.libraryId,
      libraryChapterId: source.libraryChapterId,
      title: source.title,
      breadcrumb: source.breadcrumb,
      contentHash: source.contentHash,
      evidenceContent: source.evidenceContent,
      createdAt: source.createdAt,
      supersededAt: source.supersededAt,
    })),
    events: question.reviewEvents,
    createdAt: question.createdAt,
    updatedAt: question.updatedAt,
  };
}

function prepareReviewQuestion(
  existing: {
    type: QuestionType;
    typeLabel: string;
    subjectId: string;
    category: QuizQuestionCategory;
  },
  input: QuestionReviewInput,
) {
  const question: QuestionInput = {
    gradingType: existing.type,
    typeLabel: input.typeLabel,
    subjectId: existing.subjectId,
    chapterIds: input.chapterIds,
    category: existing.category,
    prompt: input.prompt,
    options: input.options,
    correctAnswer: input.correctAnswer,
    gradingRubric: input.gradingRubric,
    explanation: input.explanation,
  };
  const prepared = prepareQuestion(question, '审核题目');
  if (
    prepared.category !== QuizQuestionCategory.KNOWLEDGE_RECALL ||
    existing.category !== QuizQuestionCategory.KNOWLEDGE_RECALL
  ) {
    throw new BadRequestException('AI 题目的分类不可修改');
  }
  return prepared;
}

function reviewSnapshot(question: {
  type: QuestionType;
  typeLabel: string;
  subjectId: string;
  category: QuizQuestionCategory;
  prompt: string;
  options: Prisma.JsonValue;
  correctAnswer: Prisma.JsonValue;
  gradingRubric: Prisma.JsonValue | null;
  maxScore: number;
  explanation: string;
  reviewStatus: QuizQuestionReviewStatus;
  chapters: Array<{ chapterId: string }>;
}) {
  return {
    gradingType: question.type,
    typeLabel: question.typeLabel,
    subjectId: question.subjectId,
    chapterIds: question.chapters.map(({ chapterId }) => chapterId),
    category: question.category,
    prompt: question.prompt,
    options: question.options,
    correctAnswer: question.correctAnswer,
    gradingRubric: question.gradingRubric,
    maxScore: question.maxScore,
    explanation: question.explanation,
    reviewStatus: question.reviewStatus,
  };
}

function diffSnapshots(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Object.fromEntries(
    Object.keys(after)
      .filter(
        (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
      )
      .map((key) => [key, { before: before[key], after: after[key] }]),
  );
}

async function lockQuestion(
  transaction: Prisma.TransactionClient,
  questionId: string,
) {
  await transaction.$queryRaw(
    Prisma.sql`SELECT id FROM QuizQuestion WHERE id = ${questionId} FOR UPDATE`,
  );
}

function assertRevision(actual: number, expected: number) {
  if (!Number.isInteger(expected) || actual !== expected) {
    throw new ConflictException({
      statusCode: 409,
      code: 'AI_REVIEW_REVISION_CONFLICT',
      message: '题目已被其他审核人修改，请刷新后重试',
      currentRevision: actual,
    });
  }
}

function statusConflict(message: string): never {
  throw new ConflictException({
    statusCode: 409,
    code: 'AI_REVIEW_STATUS_CHANGED',
    message,
  });
}

function bulkFailureReason(error: unknown) {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (
      typeof response === 'object' &&
      response !== null &&
      typeof (response as { code?: unknown }).code === 'string'
    ) {
      return (response as { code: string }).code;
    }
  }
  return 'SOURCE_REVALIDATE_FAILED';
}
