import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from './auth';
import { useAnnouncementsStore } from './announcements';
import { ApiClientError, api } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api')>(), api: vi.fn(),
}));
const mockedApi = vi.mocked(api);
const notice = { id: 'latest', title: '公告', body: '正文', readAt: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const auth = useAuthStore();
  auth.user = { id: 'member-a', role: 'MEMBER' } as never;
  return { auth, notices: useAnnouncementsStore() };
}

describe('account-bound announcement state', () => {
  beforeEach(() => { setActivePinia(createPinia()); mockedApi.mockReset(); });

  it('checks status silently and only considers the latest receipt', async () => {
    const { notices } = setup();
    expect(notices.blocked).toBe(false);
    mockedApi.mockResolvedValueOnce({ latest: { ...notice, readAt: '2026-09-06T00:00:00Z' } });
    await notices.refresh();
    expect(notices.blocked).toBe(false);
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(mockedApi.mock.calls[0]![0]).toBe('/announcements/status');
  });

  it('allows normal use when no published announcement exists', async () => {
    const { notices } = setup();
    mockedApi.mockResolvedValueOnce({ latest: null });
    await notices.refresh();
    expect(notices.checked).toBe(true);
    expect(notices.blocked).toBe(false);
  });

  it('ignores an old account response even when the transport ignores abort', async () => {
    const { auth, notices } = setup();
    const old = deferred<unknown>();
    mockedApi.mockReturnValueOnce(old.promise);
    const first = notices.refresh();
    auth.user = { id: 'member-b', role: 'MEMBER' } as never;
    auth.sessionEpoch += 1;
    notices.reset();
    mockedApi.mockResolvedValueOnce({ latest: { ...notice, id: 'b-notice' } });
    await notices.refresh();
    old.resolve({ latest: { ...notice, id: 'a-notice' } });
    await first;
    expect(notices.latest?.id).toBe('b-notice');
    expect(notices.blocked).toBe(true);
  });

  it('ignores a response from an earlier login of the same account', async () => {
    const { auth, notices } = setup();
    const old = deferred<unknown>();
    mockedApi.mockReturnValueOnce(old.promise);
    const first = notices.refresh();
    auth.sessionEpoch += 1;
    notices.reset();
    old.resolve({ latest: { ...notice, readAt: '2026-09-06T00:00:00Z' } });
    await first;
    expect(notices.checked).toBe(false);
    expect(notices.latest).toBeNull();
  });

  it('keeps the gate closed on status errors and releases it after a successful retry', async () => {
    const { notices } = setup();
    mockedApi.mockRejectedValueOnce(new TypeError('offline'));
    await notices.refresh();
    expect(notices.blocked).toBe(true);
    expect(notices.error).not.toBe('');
    mockedApi.mockResolvedValueOnce({ latest: null });
    await notices.refresh();
    expect(notices.blocked).toBe(false);
    expect(notices.error).toBe('');
  });

  it('requires server success before acknowledgment and keeps a newly published notice unread', async () => {
    const { notices } = setup();
    mockedApi.mockResolvedValueOnce({ latest: notice });
    await notices.refresh();
    mockedApi.mockRejectedValueOnce(new ApiClientError('失败', 503));
    expect(await notices.acknowledge('latest')).toBe(false);
    expect(notices.unread).toBe(true);
    mockedApi.mockResolvedValueOnce({ id: 'latest', readAt: '2026-09-06T00:00:00Z' });
    mockedApi.mockResolvedValueOnce({ latest: { ...notice, id: 'newer' } });
    expect(await notices.acknowledge('latest')).toBe(true);
    expect(notices.latest?.id).toBe('newer');
    expect(notices.blocked).toBe(true);
  });

  it('refreshes after withdrawal instead of acknowledging a nonexistent notice', async () => {
    const { notices } = setup();
    mockedApi.mockResolvedValueOnce({ latest: notice });
    await notices.refresh();
    mockedApi.mockRejectedValueOnce(new ApiClientError('已撤回', 404));
    mockedApi.mockResolvedValueOnce({ latest: null });
    expect(await notices.acknowledge('latest')).toBe(false);
    expect(notices.blocked).toBe(false);
  });

  it('does not report successful confirmation if the account changes during its refresh', async () => {
    const { auth, notices } = setup();
    const refreshed = deferred<unknown>();
    mockedApi.mockResolvedValueOnce({ id: 'latest', readAt: '2026-09-06T00:00:00Z' });
    mockedApi.mockReturnValueOnce(refreshed.promise);
    const confirmation = notices.acknowledge('latest');
    await vi.waitFor(() => expect(mockedApi).toHaveBeenCalledTimes(2));
    auth.expireSession();
    notices.reset();
    refreshed.resolve({ latest: notice });
    expect(await confirmation).toBe(false);
    expect(notices.latest).toBeNull();
    expect(notices.blocked).toBe(false);
  });
});
