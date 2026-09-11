import { Role } from '@prisma/client';
import { SubjectsController } from './subjects.controller';

function user(role: Role) {
  return { id: `${role.toLowerCase()}-1`, role } as never;
}

describe('SubjectsController', () => {
  it('honors includeInactive only for directory managers', async () => {
    const subjects = {
      listSubjects: jest.fn().mockResolvedValue([]),
    };
    const controller = new SubjectsController(subjects as never, {} as never);

    await controller.list({ includeInactive: true }, user(Role.MEMBER));
    await controller.list({ includeInactive: true }, user(Role.EDITOR));

    expect(subjects.listSubjects).toHaveBeenNthCalledWith(1, false);
    expect(subjects.listSubjects).toHaveBeenNthCalledWith(2, true);
  });

  it('records chapter changes with their subject boundary', async () => {
    const chapter = {
      id: 'chapter-1',
      subjectId: 'subject-1',
      name: '循环',
      slug: 'circulation',
      sortOrder: 1,
      active: false,
    };
    const subjects = {
      updateChapter: jest.fn(
        async (
          _subjectId: string,
          _chapterId: string,
          _input: unknown,
          hook: (transaction: unknown) => Promise<void>,
        ) => {
          await hook({ auditLog: {} });
          return chapter;
        },
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new SubjectsController(
      subjects as never,
      audit as never,
    );

    await controller.updateChapter(
      'subject-1',
      'chapter-1',
      { active: false },
      user(Role.ADMIN),
    );

    expect(subjects.updateChapter).toHaveBeenCalledWith(
      'subject-1',
      'chapter-1',
      { active: false },
      expect.any(Function),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'admin-1',
      'subject.chapter.update',
      'SubjectChapter',
      'chapter-1',
      { subjectId: 'subject-1', active: false },
      expect.any(Object),
    );
  });
});
