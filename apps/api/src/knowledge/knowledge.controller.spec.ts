import { KnowledgeController } from './knowledge.controller';

describe('KnowledgeController', () => {
  it('limits document queries at the database layer when a subject is selected', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const controller = new KnowledgeController(
      { knowledgeDocument: { findMany } } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await controller.list('subject-1');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ subjectId: 'subject-1' }),
    }));
  });

  it('forwards the version service cleanup result without claiming completion', async () => {
    const cleanup = {
      deleted: true,
      cleanupPending: true,
      cleanupJobId: 'cleanup-1',
      storageDeleted: false,
      storageCleanupPending: true,
    };
    const removeDocument = jest.fn().mockResolvedValue(cleanup);
    const controller = new KnowledgeController(
      {
        knowledgeDocument: {
          findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'document-1' }),
        },
      } as never,
      {} as never,
      {} as never,
      { removeDocument } as never,
    );

    const result = await controller.remove('document-1', { id: 'editor-1' } as never);

    expect(removeDocument).toHaveBeenCalledWith(
      { id: 'editor-1' },
      'document-1',
    );
    expect(result).toEqual({ id: 'document-1', ...cleanup });
  });

  it('routes the legacy subject endpoint through the shared directory service', async () => {
    const subject = {
      id: 'subject-1',
      name: '生理学',
      slug: 'physiology',
      sortOrder: 0,
      active: true,
    };
    const createSubject = jest.fn().mockResolvedValue(subject);
    const record = jest.fn().mockResolvedValue(undefined);
    const controller = new KnowledgeController(
      {} as never,
      { record } as never,
      { createSubject } as never,
      {} as never,
    );

    await expect(
      controller.createSubject(
        { name: ' 生理学 ', slug: 'Physiology' },
        { id: 'editor-1' } as never,
      ),
    ).resolves.toEqual(subject);
    expect(createSubject).toHaveBeenCalledWith(
      'editor-1',
      { name: ' 生理学 ', slug: 'Physiology' },
      expect.any(Function),
    );
    const hook = createSubject.mock.calls[0]![2];
    const transaction = { auditLog: {} };
    await hook(transaction, subject);
    expect(record).toHaveBeenCalledWith(
      'editor-1',
      'knowledge.subject.create',
      'Subject',
      'subject-1',
      undefined,
      transaction,
    );
  });
});
