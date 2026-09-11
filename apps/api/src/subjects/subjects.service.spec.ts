import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SubjectsService } from './subjects.service';

describe('SubjectsService', () => {
  it('lists only active subjects by default in stable order', async () => {
    const prisma = {
      subject: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new SubjectsService(prisma as never);

    await service.listSubjects();

    expect(prisma.subject.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  });

  it('normalizes names and slugs when creating a subject', async () => {
    const transaction = {
      subject: {
        create: jest.fn().mockImplementation(({ data }) => data),
      },
    };
    const prisma = {
      ...transaction,
      $transaction: jest.fn(
        async (action: (client: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const service = new SubjectsService(prisma as never);

    await service.createSubject('editor-1', {
      name: ' 生理学 ',
      slug: 'Physiology-Core',
    });

    expect(prisma.subject.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: '生理学',
          slug: 'physiology-core',
          createdById: 'editor-1',
        }),
      }),
    );
  });

  it('rejects invalid slugs before writing', async () => {
    const transaction = { subject: { create: jest.fn() } };
    const prisma = {
      ...transaction,
      $transaction: jest.fn(
        async (action: (client: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const service = new SubjectsService(prisma as never);

    await expect(
      service.createSubject('editor-1', {
        name: '生理学',
        slug: '生理 学',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.subject.create).not.toHaveBeenCalled();
  });

  it('does not expose chapters of an inactive subject to members', async () => {
    const prisma = {
      subject: { findFirst: jest.fn().mockResolvedValue(null) },
      subjectChapter: { findMany: jest.fn() },
    };
    const service = new SubjectsService(prisma as never);

    await expect(service.listChapters('subject-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.subject.findFirst).toHaveBeenCalledWith({
      where: { id: 'subject-1', active: true },
      select: { id: true },
    });
    expect(prisma.subjectChapter.findMany).not.toHaveBeenCalled();
  });

  it('updates a chapter only inside its declared subject', async () => {
    const transaction = {
      subjectChapter: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    const prisma = {
      ...transaction,
      $transaction: jest.fn(
        async (action: (client: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const service = new SubjectsService(prisma as never);

    await expect(
      service.updateChapter('subject-1', 'chapter-other', { active: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.subjectChapter.findFirst).toHaveBeenCalledWith({
      where: { id: 'chapter-other', subjectId: 'subject-1' },
      select: { id: true },
    });
    expect(prisma.subjectChapter.update).not.toHaveBeenCalled();
  });
});
