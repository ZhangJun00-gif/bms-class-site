import { computed, defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { useLatestRequest } from './useLatestRequest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('useLatestRequest', () => {
  it('aborts the previous read and ignores a late result even when abort is ignored', async () => {
    const requests = useLatestRequest();
    const first = deferred<string>();
    const second = deferred<string>();
    const committed: string[] = [];
    let firstSignal: AbortSignal | undefined;

    const firstRun = requests.runLatest(
      ({ signal }) => {
        firstSignal = signal;
        return first.promise;
      },
      { commit: (value) => committed.push(value) },
    );
    const secondRun = requests.runLatest(
      () => second.promise,
      { commit: (value) => committed.push(value) },
    );

    expect(firstSignal?.aborted).toBe(true);
    second.resolve('new');
    expect(await secondRun).toMatchObject({ status: 'committed', value: 'new' });
    first.resolve('old');
    expect(await firstRun).toMatchObject({ status: 'aborted' });
    expect(committed).toEqual(['new']);
  });

  it('runs onFinally only for the latest generation', async () => {
    const requests = useLatestRequest();
    const first = deferred<void>();
    const second = deferred<void>();
    const finallyCalls: number[] = [];

    const firstRun = requests.runLatest(
      () => first.promise,
      {
        abortPrevious: false,
        onFinally: ({ generation }) => finallyCalls.push(generation),
      },
    );
    const secondRun = requests.runLatest(
      () => second.promise,
      {
        abortPrevious: false,
        onFinally: ({ generation }) => finallyCalls.push(generation),
      },
    );

    first.resolve();
    expect(await firstRun).toMatchObject({ status: 'stale' });
    expect(finallyCalls).toEqual([]);
    expect(requests.loading.value).toBe(true);

    second.resolve();
    await secondRun;
    expect(finallyCalls).toEqual([2]);
    expect(requests.loading.value).toBe(false);
  });

  it('aborts on unmount and prevents all callbacks', async () => {
    const pending = deferred<string>();
    const commit = vi.fn();
    const onError = vi.fn();
    const onFinally = vi.fn();
    let signal: AbortSignal | undefined;
    let run: Promise<unknown> | undefined;

    const wrapper = mount(defineComponent({
      setup() {
        const requests = useLatestRequest();
        run = requests.runLatest(
          (context) => {
            signal = context.signal;
            return pending.promise;
          },
          { commit, onError, onFinally },
        );
        return () => h('div');
      },
    }));
    await nextTick();

    wrapper.unmount();
    expect(signal?.aborted).toBe(true);
    pending.resolve('late');
    expect(await run).toMatchObject({ status: 'aborted' });
    expect(commit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onFinally).not.toHaveBeenCalled();
  });

  it('tracks busy state per key, rejects reentry, and clears after errors', async () => {
    const requests = useLatestRequest();
    const pending = deferred<string>();
    const task = vi.fn(() => pending.promise);
    const busyForOne = computed(() => requests.isBusy('one'));

    const run = requests.runBusy('one', task);
    expect(busyForOne.value).toBe(true);
    expect(requests.isBusy('two')).toBe(false);
    expect(await requests.runBusy('one', task)).toBeUndefined();
    expect(task).toHaveBeenCalledTimes(1);

    pending.resolve('done');
    expect(await run).toBe('done');
    expect(busyForOne.value).toBe(false);

    await expect(requests.runBusy('one', async () => {
      throw new Error('mutation failed');
    })).rejects.toThrow('mutation failed');
    expect(requests.isBusy('one')).toBe(false);
  });

  it('rolls back a failed latest page without allowing an old failure to interfere', async () => {
    const requests = useLatestRequest();
    const page = ref(1);
    const pageTwo = deferred<string>();
    const pageThree = deferred<string>();

    const oldRun = requests.runPage(page, 2, () => pageTwo.promise);
    const latestRun = requests.runPage(page, 3, () => pageThree.promise);
    expect(page.value).toBe(3);

    pageTwo.reject(new Error('old failure'));
    expect(await oldRun).toMatchObject({ status: 'aborted' });
    expect(page.value).toBe(3);

    pageThree.reject(new Error('latest failure'));
    expect(await latestRun).toMatchObject({ status: 'failed' });
    expect(page.value).toBe(1);

    await requests.runPage(page, 2, async () => 'page two');
    expect(page.value).toBe(2);
    const pageFour = requests.runPage(page, 4, async () => {
      throw new Error('page four failed');
    });
    expect(await pageFour).toMatchObject({ status: 'failed' });
    expect(page.value).toBe(2);
  });

  it('uses the server-committed page as the rollback target', async () => {
    const requests = useLatestRequest();
    const page = ref(4);

    await requests.runPage(page, 4, async () => ({ page: 3 }), {
      commit(result) {
        page.value = result.page;
      },
    });
    expect(page.value).toBe(3);

    const failed = requests.runPage(page, 4, async () => {
      throw new Error('page disappeared');
    });
    expect(await failed).toMatchObject({ status: 'failed' });
    expect(page.value).toBe(3);
  });
});
