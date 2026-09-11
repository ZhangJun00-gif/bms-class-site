import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForumReport } from '../../types';
import ForumReportsDialog from './ForumReportsDialog.vue';

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));

const report: ForumReport = {
  id: 'report-1',
  reason: '包含不适当内容',
  reporterId: 'member-1',
  threadId: 'thread-1',
  postId: null,
  resolvedAt: null,
  createdAt: '2026-07-20T00:00:00.000Z',
  reporter: { id: 'member-1', displayName: '举报人' },
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ForumReportsDialog', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('refreshes the pending list after resolving a report', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ items: [report], total: 1 }))
      .mockResolvedValueOnce(
        response({ ...report, resolvedAt: '2026-07-20T02:00:00.000Z' }),
      )
      .mockResolvedValueOnce(response({ items: [], total: 0 }));
    const wrapper = mount(ForumReportsDialog, {
      props: { open: true },
      global: {
        stubs: {
          BaseDialog: { template: '<div><slot /></div>' },
        },
      },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('包含不适当内容');

    await wrapper
      .findAll('button')
      .find((button) => button.text() === '标记已处理')!
      .trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/v1/forum/reports/report-1/resolve',
    );
    expect(wrapper.text()).toContain('暂无待处理举报');
  });
});
