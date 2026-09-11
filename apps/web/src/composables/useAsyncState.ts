import { ref } from 'vue';
import { ApiClientError, formatError } from '../lib/api';

export interface AsyncState<T> {
  data: ReturnType<typeof ref<T | null>>;
  loading: ReturnType<typeof ref<boolean>>;
  loaded: ReturnType<typeof ref<boolean>>;
  error: ReturnType<typeof ref<string>>;
  reload: () => Promise<void>;
}

/** 统一请求状态：加载中、成功、失败（可重试）。不得用静默失败冒充空数据。 */
export function useAsyncState<T>(fetcher: () => Promise<T>, options: { immediate?: boolean } = {}) {
  const data = ref<T | null>(null);
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref('');
  let requestId = 0;

  async function execute() {
    const currentRequest = ++requestId;
    loading.value = true;
    error.value = '';
    try {
      const result = await fetcher();
      if (currentRequest === requestId) {
        data.value = result;
        loaded.value = true;
      }
    } catch (caught) {
      if (currentRequest === requestId) error.value = humanize(caught);
    } finally {
      if (currentRequest === requestId) loading.value = false;
    }
  }

  function humanize(caught: unknown): string {
    if (caught instanceof ApiClientError) {
      if (caught.status === 401) return '登录状态已失效，请重新登录';
      if (caught.status === 403) return '当前账号无权查看此内容';
      if (caught.status === 404) return '内容不存在或已被删除';
    }
    return formatError(caught, '加载失败，请稍后重试');
  }

  if (options.immediate !== false) void execute();

  return { data, loading, loaded, error, reload: execute };
}
