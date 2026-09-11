import {
  getCurrentInstance,
  onUnmounted,
  reactive,
  readonly,
  ref,
  type Ref,
} from 'vue';

export interface LatestRequestContext {
  signal: AbortSignal;
  generation: number;
  isCurrent: () => boolean;
}

export type LatestRequestResult<T> =
  | { status: 'committed'; value: T; generation: number }
  | { status: 'stale'; generation: number }
  | { status: 'aborted'; generation: number }
  | { status: 'failed'; error: unknown; generation: number };

export interface LatestRequestCallbacks<T> {
  commit?: (value: T, context: LatestRequestContext) => void;
  onError?: (error: unknown, context: LatestRequestContext) => void;
  onFinally?: (context: LatestRequestContext) => void;
  abortPrevious?: boolean;
}

export type LatestRequestTask<T> = (context: LatestRequestContext) => Promise<T>;

type BusyKey = string | number;

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}

/**
 * Coordinates component-owned reads and per-resource mutations.
 * Only the newest live generation may change state through request callbacks.
 */
export function useLatestRequest() {
  const loading = ref(false);
  const generation = ref(0);
  const busyKeys = reactive(new Set<BusyKey>());
  const stablePages = new WeakMap<Ref<number>, number>();
  const controllers = new Set<AbortController>();
  let latestController: AbortController | null = null;
  let alive = true;

  function abortControllers() {
    for (const controller of controllers) controller.abort();
  }

  function cancelLatest() {
    generation.value += 1;
    latestController?.abort();
    latestController = null;
    loading.value = false;
  }

  async function runLatest<T>(
    task: LatestRequestTask<T>,
    callbacks: LatestRequestCallbacks<T> = {},
  ): Promise<LatestRequestResult<T>> {
    if (callbacks.abortPrevious !== false) abortControllers();

    const currentGeneration = generation.value + 1;
    generation.value = currentGeneration;
    const controller = new AbortController();
    controllers.add(controller);
    latestController = controller;
    loading.value = true;

    const isCurrent = () => alive
      && generation.value === currentGeneration
      && latestController === controller
      && !controller.signal.aborted;
    const context: LatestRequestContext = {
      signal: controller.signal,
      generation: currentGeneration,
      isCurrent,
    };

    try {
      const value = await task(context);
      if (!isCurrent()) {
        return controller.signal.aborted
          ? { status: 'aborted', generation: currentGeneration }
          : { status: 'stale', generation: currentGeneration };
      }
      callbacks.commit?.(value, context);
      return { status: 'committed', value, generation: currentGeneration };
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return { status: 'aborted', generation: currentGeneration };
      }
      if (!isCurrent()) return { status: 'stale', generation: currentGeneration };
      callbacks.onError?.(error, context);
      return { status: 'failed', error, generation: currentGeneration };
    } finally {
      controllers.delete(controller);
      if (isCurrent()) {
        try {
          callbacks.onFinally?.(context);
        } finally {
          loading.value = false;
          latestController = null;
        }
      }
    }
  }

  async function runPage<T>(
    page: Ref<number>,
    nextPage: number,
    task: LatestRequestTask<T>,
    callbacks: LatestRequestCallbacks<T> = {},
  ) {
    if (!stablePages.has(page)) stablePages.set(page, page.value);
    page.value = nextPage;

    return runLatest(task, {
      ...callbacks,
      commit(value, context) {
        callbacks.commit?.(value, context);
        stablePages.set(page, page.value);
      },
      onError(error, context) {
        page.value = stablePages.get(page) ?? page.value;
        callbacks.onError?.(error, context);
      },
    });
  }

  async function runBusy<T>(key: BusyKey, task: () => Promise<T>): Promise<T | undefined> {
    if (busyKeys.has(key)) return undefined;
    busyKeys.add(key);
    try {
      return await task();
    } finally {
      busyKeys.delete(key);
    }
  }

  function isBusy(key: BusyKey) {
    return busyKeys.has(key);
  }

  if (getCurrentInstance()) {
    onUnmounted(() => {
      alive = false;
      generation.value += 1;
      abortControllers();
      controllers.clear();
      latestController = null;
      loading.value = false;
    });
  }

  return {
    loading: readonly(loading),
    generation: readonly(generation),
    runLatest,
    runPage,
    runBusy,
    isBusy,
    cancelLatest,
  };
}
