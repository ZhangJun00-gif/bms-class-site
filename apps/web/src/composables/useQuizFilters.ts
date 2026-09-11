import { ref } from 'vue';
import { api, formatError } from '../lib/api';
import type { QuizFiltersResponse, QuizSubjectFilterGroup } from '../types';

/**
 * 学科、章节与题型筛选条件（模块级缓存）。
 * 随机练习、题库浏览、往年真题共用同一份数据：挂载时调用 ensure()，
 * 并发调用与重复挂载复用同一次请求，避免每个面板各自拉取。
 */
const groups = ref<QuizSubjectFilterGroup[]>([]);
const loaded = ref(false);
const loading = ref(false);
const error = ref('');
let pending: Promise<void> | null = null;

async function request(force: boolean) {
  if (pending) return pending;
  if (loaded.value && !force) return Promise.resolve();
  loading.value = true;
  error.value = '';
  pending = (async () => {
    try {
      const data = await api<QuizFiltersResponse>('/quizzes/filters');
      groups.value = data.subjectGroups ?? [];
      loaded.value = true;
    } catch (caught) {
      error.value = formatError(caught, '筛选条件加载失败');
    } finally {
      loading.value = false;
      pending = null;
    }
  })();
  return pending;
}

export function useQuizFilters() {
  return {
    groups,
    /** 已成功加载过（用于区分"加载中"与"加载失败"） */
    loaded,
    loading,
    error,
    /** 首次调用发起请求；已加载或请求中直接复用 */
    ensure: () => request(false),
    /** 失败重试：忽略缓存重新请求 */
    reload: () => request(true),
  };
}

/** 仅供测试：清空模块级缓存，避免用例间相互污染 */
export function resetQuizFiltersCache() {
  groups.value = [];
  loaded.value = false;
  loading.value = false;
  error.value = '';
  pending = null;
}
