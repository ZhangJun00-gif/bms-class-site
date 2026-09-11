import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

const subjectSelect = {
  id: true,
  name: true,
  slug: true,
  sortOrder: true,
  active: true,
} satisfies Prisma.SubjectSelect;

const chapterSelect = {
  id: true,
  subjectId: true,
  name: true,
  slug: true,
  sortOrder: true,
  active: true,
} satisfies Prisma.SubjectChapterSelect;

export interface SubjectWriteInput {
  name?: string;
  slug?: string;
  sortOrder?: number;
  active?: boolean;
}

export type SubjectMutationHook = (
  transaction: Prisma.TransactionClient,
  entity: { id: string },
) => Promise<void>;

function normalizeRequired(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) throw new BadRequestException(`${field}不能为空`);
  return normalized;
}

function normalizeSlug(value: string) {
  const slug = normalizeRequired(value, 'slug').toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new BadRequestException('slug 只能包含小写字母、数字和连字符');
  }
  return slug;
}

function mapConflict(error: unknown, message: string): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(message);
  }
  throw error;
}

@Injectable()
export class SubjectsService {
  constructor(private readonly prisma: PrismaService) {}

  listSubjects(includeInactive = false) {
    return this.prisma.subject.findMany({
      where: includeInactive ? {} : { active: true },
      select: subjectSelect,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createSubject(
    userId: string,
    input: Required<Pick<SubjectWriteInput, 'name' | 'slug'>> &
      SubjectWriteInput,
    afterMutation?: SubjectMutationHook,
  ) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const subject = await transaction.subject.create({
          data: {
            name: normalizeRequired(input.name, '学科名称'),
            slug: normalizeSlug(input.slug),
            sortOrder: input.sortOrder ?? 0,
            active: input.active ?? true,
            createdById: userId,
          },
          select: subjectSelect,
        });
        await afterMutation?.(transaction, subject);
        return subject;
      });
    } catch (error) {
      mapConflict(error, '学科名称或 slug 已存在');
    }
  }

  async updateSubject(
    id: string,
    input: SubjectWriteInput,
    afterMutation?: SubjectMutationHook,
  ) {
    const data: Prisma.SubjectUpdateInput = {};
    if (input.name !== undefined) {
      data.name = normalizeRequired(input.name, '学科名称');
    }
    if (input.slug !== undefined) data.slug = normalizeSlug(input.slug);
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.active !== undefined) data.active = input.active;
    if (!Object.keys(data).length) {
      throw new BadRequestException('至少提供一个要修改的学科字段');
    }
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const subject = await transaction.subject.update({
          where: { id },
          data,
          select: subjectSelect,
        });
        await afterMutation?.(transaction, subject);
        return subject;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('学科不存在');
      }
      mapConflict(error, '学科名称或 slug 已存在');
    }
  }

  async listChapters(subjectId: string, includeInactive = false) {
    const subject = await this.prisma.subject.findFirst({
      where: { id: subjectId, ...(includeInactive ? {} : { active: true }) },
      select: { id: true },
    });
    if (!subject) throw new NotFoundException('学科不存在或已停用');
    return this.prisma.subjectChapter.findMany({
      where: { subjectId, ...(includeInactive ? {} : { active: true }) },
      select: chapterSelect,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createChapter(
    subjectId: string,
    input: Required<Pick<SubjectWriteInput, 'name' | 'slug'>> & SubjectWriteInput,
    afterMutation?: SubjectMutationHook,
  ) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const subject = await transaction.subject.findFirst({
          where: { id: subjectId, active: true },
          select: { id: true },
        });
        if (!subject) throw new NotFoundException('学科不存在或已停用');
        const chapter = await transaction.subjectChapter.create({
          data: {
            subjectId,
            name: normalizeRequired(input.name, '章节名称'),
            slug: normalizeSlug(input.slug),
            sortOrder: input.sortOrder ?? 0,
            active: input.active ?? true,
          },
          select: chapterSelect,
        });
        await afterMutation?.(transaction, chapter);
        return chapter;
      });
    } catch (error) {
      mapConflict(error, '该学科下的章节名称或 slug 已存在');
    }
  }

  async updateChapter(
    subjectId: string,
    chapterId: string,
    input: SubjectWriteInput,
    afterMutation?: SubjectMutationHook,
  ) {
    const data: Prisma.SubjectChapterUpdateInput = {};
    if (input.name !== undefined) {
      data.name = normalizeRequired(input.name, '章节名称');
    }
    if (input.slug !== undefined) data.slug = normalizeSlug(input.slug);
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.active !== undefined) data.active = input.active;
    if (!Object.keys(data).length) {
      throw new BadRequestException('至少提供一个要修改的章节字段');
    }

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.subjectChapter.findFirst({
          where: { id: chapterId, subjectId },
          select: { id: true },
        });
        if (!existing) throw new NotFoundException('章节不存在');
        const chapter = await transaction.subjectChapter.update({
          where: { id: chapterId },
          data,
          select: chapterSelect,
        });
        await afterMutation?.(transaction, chapter);
        return chapter;
      });
    } catch (error) {
      mapConflict(error, '该学科下的章节名称或 slug 已存在');
    }
  }
}
