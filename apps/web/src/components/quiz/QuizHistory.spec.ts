import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QuizHistory from './QuizHistory.vue';

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function attempt(id: string) {
  return {
    id,
    score: 8,
    total: 10,
    submittedAt: '2026-07-20T08:00:00.000Z',
    createdAt: '2026-07-20T07:55:00.000Z',
  };
}

describe('QuizHistory pagination', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rolls back to the last successful page when pagination fails', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response({ items: [attempt('a1')], total: 30, page: 1, pageSize: 20 }),
      )
      .mockResolvedValueOnce(response({ message: 'temporary failure' }, 503));
    const wrapper = mount(QuizHistory);
    await flushPromises();

    const pagination = wrapper.findComponent({ name: 'PaginationControl' });
    pagination.vm.$emit('update:page', 2);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pagination.props('page')).toBe(1);
    expect(wrapper.get('[role="alert"]').text()).toContain('temporary failure');
    expect(wrapper.text()).toContain('8');
    wrapper.unmount();
  });

  it('fetches the new last page before committing when the total shrinks', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response({ items: [attempt('a1')], total: 30, page: 1, pageSize: 20 }),
      )
      .mockResolvedValueOnce(
        response({ items: [], total: 5, page: 2, pageSize: 20 }),
      )
      .mockResolvedValueOnce(
        response({ items: [attempt('a-new')], total: 5, page: 1, pageSize: 20 }),
      );
    const wrapper = mount(QuizHistory);
    await flushPromises();
    const pagination = wrapper.findComponent({ name: 'PaginationControl' });

    pagination.vm.$emit('update:page', 2);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('page=2');
    expect(String(fetchMock.mock.calls[2]![0])).toContain('page=1');
    expect(pagination.props('page')).toBe(1);
    expect(wrapper.findComponent({ name: 'EmptyState' }).exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps the previous page and data when the correction request fails', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response({ items: [attempt('a1')], total: 30, page: 1, pageSize: 20 }),
      )
      .mockResolvedValueOnce(
        response({ items: [], total: 5, page: 2, pageSize: 20 }),
      )
      .mockResolvedValueOnce(response({ message: '纠偏请求失败' }, 503));
    const wrapper = mount(QuizHistory);
    await flushPromises();
    const pagination = wrapper.findComponent({ name: 'PaginationControl' });

    pagination.vm.$emit('update:page', 2);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(pagination.props('page')).toBe(1);
    expect(wrapper.get('[role="alert"]').text()).toContain('纠偏请求失败');
    expect(wrapper.text()).toContain('8');
    wrapper.unmount();
  });
});
