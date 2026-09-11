import { ref, type Ref } from 'vue';
import { formatError, isAbortError } from '../lib/api';

interface AbortableListPage<TItem> {
  items: TItem[];
  total?: number;
}

interface AbortableListOptions<TItem, TRow extends { id: string }> {
  /** 拉取一页数据；signal 会在新前台请求或组件卸载时中止。 */
  fetcher: (signal: AbortSignal) => Promise<AbortableListPage<TItem>>;
  /** 把新一页合并进现有行；复用已有行以保留行内操作状态（发布中、删除错误等）。 */
  merge: (current: TRow[], items: TItem[]) => TRow[];
  /** 加载失败时的提示前缀。 */
  errorMessage: string;
}

/**
 * 可中止管理列表的统一加载，仅覆盖 AdminQuizManage 与 AdminKnowledge 的同构模式：
 * - 前台请求中止上一个未完成请求，过期响应按 requestId 丢弃；
 * - 后台刷新（background=true）在已有请求进行中时跳过，且不重置 loading，
 *   因此轮询不会闪回骨架屏；
 * - AbortError 静默；merge 由组件提供以保留行状态。
 * AdminAlbums 是一次性加载并保留选中相册的不同结构，刻意不接入本 composable。
 */
export function useAbortableList<TItem, TRow extends { id: string }>(
  options: AbortableListOptions<TItem, TRow>,
) {
  const rows = ref<TRow[]>([]) as Ref<TRow[]>;
  const total = ref(0);
  const loading = ref(false);
  const loaded = ref(false);
  const loadError = ref('');
  let controller: AbortController | null = null;
  let requestId = 0;
  let inFlight = false;

  async function load(background = false) {
    if (background && inFlight) return;
    if (!background) controller?.abort();

    const currentRequest = ++requestId;
    const current = new AbortController();
    controller = current;
    inFlight = true;
    if (!background) loading.value = true;
    loadError.value = '';
    try {
      const result = await options.fetcher(current.signal);
      if (currentRequest !== requestId) return;
      rows.value = options.merge(rows.value, result.items);
      if (result.total !== undefined) total.value = result.total;
      loaded.value = true;
    } catch (caught) {
      if (isAbortError(caught)) return;
      if (currentRequest === requestId)
        loadError.value = formatError(caught, options.errorMessage);
    } finally {
      if (currentRequest === requestId) {
        loading.value = false;
        inFlight = false;
        controller = null;
      }
    }
  }

  function abort() {
    controller?.abort();
  }

  return { rows, total, loading, loaded, loadError, load, abort };
}
