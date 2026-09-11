import { ref } from 'vue';
import { api, formatError } from '../lib/api';
import type {
  KnowledgeSubject,
  KnowledgeSubjectCreateRequest,
} from '../types';

interface KnowledgeSubjectsOptions {
  /** 列表加载成功后的组件侧处理（默认选中、失效选择清空等）。 */
  onLoaded?: (subjects: KnowledgeSubject[]) => void;
  /** 创建成功后的组件侧处理（选中新学科、刷新关联列表等），可异步。 */
  onCreated?: (subject: KnowledgeSubject) => void | Promise<void>;
  /** 创建成功提示文案，默认为“已创建学科”。 */
  createdMessage?: (subject: KnowledgeSubject) => string;
}

/**
 * 学科管理共享逻辑：排序加载、2-100 字符本地校验与创建合并。
 * 各组件在加载/创建后的选中行为与提示文案不同，经 options 回调保留。
 */
export function useKnowledgeSubjects(options: KnowledgeSubjectsOptions = {}) {
  const subjects = ref<KnowledgeSubject[]>([]);
  const subjectsLoading = ref(false);
  const subjectsError = ref('');
  const subjectPanelOpen = ref(false);
  const subjectName = ref('');
  const subjectSlug = ref('');
  const subjectBusy = ref(false);
  const subjectError = ref('');
  const subjectMessage = ref('');

  function sortSubjects(items: KnowledgeSubject[]) {
    return [...items].sort(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        left.name.localeCompare(right.name, 'zh-CN'),
    );
  }

  async function loadSubjects() {
    subjectsLoading.value = true;
    subjectsError.value = '';
    try {
      subjects.value = sortSubjects(
        await api<KnowledgeSubject[]>('/subjects'),
      );
      options.onLoaded?.(subjects.value);
    } catch (caught) {
      subjectsError.value = formatError(caught, '学科列表加载失败');
    } finally {
      subjectsLoading.value = false;
    }
  }

  async function createSubject() {
    const payload: KnowledgeSubjectCreateRequest = {
      name: subjectName.value.trim(),
      slug: subjectSlug.value.trim(),
    };
    subjectError.value = '';
    subjectMessage.value = '';
    if (
      payload.name.length < 2 ||
      payload.name.length > 100 ||
      payload.slug.length < 2 ||
      payload.slug.length > 100
    ) {
      subjectError.value = '学科名称和 slug 均需为 2-100 个字符';
      return;
    }

    subjectBusy.value = true;
    try {
      const subject = await api<KnowledgeSubject>('/subjects', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      subjects.value = sortSubjects([
        ...subjects.value.filter((item) => item.id !== subject.id),
        subject,
      ]);
      subjectName.value = '';
      subjectSlug.value = '';
      subjectMessage.value =
        options.createdMessage?.(subject) ?? `已创建学科“${subject.name}”`;
      await options.onCreated?.(subject);
    } catch (caught) {
      subjectError.value = formatError(caught, '学科创建失败');
    } finally {
      subjectBusy.value = false;
    }
  }

  return {
    subjects,
    subjectsLoading,
    subjectsError,
    subjectPanelOpen,
    subjectName,
    subjectSlug,
    subjectBusy,
    subjectError,
    subjectMessage,
    loadSubjects,
    createSubject,
  };
}
