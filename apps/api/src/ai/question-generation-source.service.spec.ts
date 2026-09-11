import { BadRequestException } from '@nestjs/common';
import { QuestionGenerationSourceService } from './question-generation-source.service';

describe('QuestionGenerationSourceService leaf evidence selection', () => {
  it('returns descendant leaf metadata for each heading in the picker', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'parent',
          parentId: null,
          documentVersionId: 'version-1',
          level: 2,
          title: '循环调节',
          titleMarkdown: null,
          path: '循环调节',
          breadcrumb: '循环调节',
          sortOrder: 1,
          libraryChapterId: 'library-chapter-1',
          documentVersion: {
            id: 'version-1',
            documentId: 'document-1',
            activeForDocument: {
              id: 'document-1',
              title: '生理学',
              libraryId: 'library-1',
            },
          },
          chunks: [{ tokenCount: 20, content: '父标题导语' }],
          _count: { children: 2 },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'leaf-a',
          documentVersionId: 'version-1',
          path: '循环调节 > 压力感受性反射',
        },
        {
          id: 'leaf-b',
          documentVersionId: 'version-1',
          path: '循环调节 > 化学感受性反射',
        },
      ]);
    const service = new QuestionGenerationSourceService(
      {
        knowledgeLibrary: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'library-1',
            name: '生理学',
            subjectId: 'subject-1',
          }),
        },
        knowledgeNode: {
          findMany,
          count: jest.fn().mockResolvedValue(3),
        },
      } as never,
      {} as never,
    );

    const result = await service.nodes(
      'subject-1',
      'library-1',
      undefined,
      1,
      100,
    );

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: 'parent',
        hasChildren: true,
        leafNodeCount: 2,
        leafNodeIds: ['leaf-a', 'leaf-b'],
      }),
    );
  });

  it('expands a parent heading to descendant leaves and removes overlaps', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'parent', documentVersionId: 'version-1', path: '循环调节' },
        {
          id: 'leaf-b',
          documentVersionId: 'version-1',
          path: '循环调节 > 化学感受性反射',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'leaf-a',
          documentVersionId: 'version-1',
          path: '循环调节 > 压力感受性反射',
          sortOrder: 2,
        },
        {
          id: 'leaf-b',
          documentVersionId: 'version-1',
          path: '循环调节 > 化学感受性反射',
          sortOrder: 3,
        },
      ]);
    const service = new QuestionGenerationSourceService(
      { knowledgeNode: { findMany } } as never,
      {} as never,
    );

    await expect(
      service.expandKnowledgeNodeIds('subject-1', ['parent', 'leaf-b']),
    ).resolves.toEqual(['leaf-a', 'leaf-b']);
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ children: { none: {} } }),
      }),
    );
  });

  it('applies the 20-node limit after expanding the selected parent', async () => {
    const leaves = Array.from({ length: 21 }, (_, index) => ({
      id: `leaf-${index + 1}`,
      documentVersionId: 'version-1',
      path: `循环调节 > 末级证据 ${index + 1}`,
      sortOrder: index + 1,
    }));
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'parent', documentVersionId: 'version-1', path: '循环调节' },
      ])
      .mockResolvedValueOnce(leaves);
    const service = new QuestionGenerationSourceService(
      { knowledgeNode: { findMany } } as never,
      {} as never,
    );

    await expect(
      service.expandKnowledgeNodeIds('subject-1', ['parent']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
