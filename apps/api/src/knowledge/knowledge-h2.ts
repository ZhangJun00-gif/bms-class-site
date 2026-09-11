import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export async function lockKnowledgeLibrary(
  transaction: Prisma.TransactionClient,
  libraryId: string,
) {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT id FROM KnowledgeLibrary
      WHERE id = ${libraryId} AND deletedAt IS NULL
      FOR UPDATE
    `,
  );
  if (rows.length !== 1) throw new NotFoundException('知识库不存在');
}

export async function activeH2Owners(
  transaction: Prisma.TransactionClient,
  libraryId: string,
  titles: string[],
) {
  if (!titles.length) return new Map<string, Set<string>>();
  const documents = await transaction.knowledgeDocument.findMany({
    where: {
      libraryId,
      deletedAt: null,
      activeVersionId: { not: null },
    },
    select: {
      id: true,
      activeVersion: {
        select: {
          nodes: {
            where: { level: 2, title: { in: titles } },
            select: { title: true },
          },
        },
      },
    },
  });
  const owners = new Map<string, Set<string>>();
  for (const document of documents) {
    for (const node of document.activeVersion?.nodes ?? []) {
      const documentIds = owners.get(node.title) ?? new Set<string>();
      documentIds.add(document.id);
      owners.set(node.title, documentIds);
    }
  }
  return owners;
}

export async function assertIncomingH2Target(
  transaction: Prisma.TransactionClient,
  libraryId: string,
  titles: string[],
  targetDocumentId: string | null,
) {
  const owners = await activeH2Owners(transaction, libraryId, titles);
  const conflictingDocumentIds = new Set(
    [...owners.values()].flatMap((ids) => [...ids]),
  );
  if (targetDocumentId) conflictingDocumentIds.delete(targetDocumentId);
  if (conflictingDocumentIds.size > 0 || (!targetDocumentId && owners.size > 0)) {
    throw new ConflictException({
      statusCode: 409,
      code: 'H2_REPLACEMENT_AMBIGUOUS',
      message: 'H2 占用已变化，无法安全确定整份替换目标',
    });
  }
}

export async function assertCandidateH2Unique(
  transaction: Prisma.TransactionClient,
  libraryId: string,
  documentId: string,
  versionId: string,
) {
  const nodes = await transaction.knowledgeNode.findMany({
    where: { documentVersionId: versionId, level: 2 },
    select: { title: true },
  });
  await assertIncomingH2Target(
    transaction,
    libraryId,
    [...new Set(nodes.map((node) => node.title))],
    documentId,
  );
}
