import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AlbumsView from './AlbumsView.vue';

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const summary = {
  id: 'a1',
  title: '春游相册',
  description: '',
  coverUrl: '/api/v1/media/images/photo-1/content',
  photoCount: 2,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
};

function mountView() {
  return mount(AlbumsView, {
    global: {
      stubs: {
        RouterLink: RouterLinkStub,
        PageHeader: { template: '<div><slot name="breadcrumb"/></div>' },
        AlbumLightbox: true,
      },
    },
  });
}

describe('AlbumsView summary flow', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads summaries and passes the selected summary to the paged lightbox', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ items: [summary], total: 1 }),
    );
    const wrapper = mountView();
    await flushPromises();

    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/v1/albums');
    expect(wrapper.findComponent({ name: 'AlbumLightbox' }).props('album')).toBeNull();
    expect(wrapper.find('.album-card img').attributes('src')).toBe(summary.coverUrl);

    await wrapper.get('.album-card').trigger('click');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent({ name: 'AlbumLightbox' }).props('album')).toMatchObject({ id: 'a1' });
  });

  it('shows the list error and supports retry', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ message: '服务暂时不可用' }, 500))
      .mockResolvedValueOnce(response({ items: [summary], total: 1 }));
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('服务暂时不可用');

    await wrapper.findAll('button').find((button) => button.text().includes('重试'))!.trigger('click');
    await flushPromises();
    expect(wrapper.find('.album-card').exists()).toBe(true);
  });
});
