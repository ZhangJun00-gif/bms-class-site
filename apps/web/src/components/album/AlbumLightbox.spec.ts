import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AlbumLightbox from './AlbumLightbox.vue';
import type { AlbumSummary, Photo } from '../../types';

const album: AlbumSummary = {
  id: 'album-1',
  title: '班级活动',
  description: '活动记录',
  coverUrl: '/photo-1.webp',
  photoCount: 2,
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
};

function photo(id: string, caption: string, sortOrder: number): Photo {
  return {
    id,
    albumId: 'album-1',
    caption,
    mimeType: 'image/webp',
    size: 100,
    width: 800,
    height: 600,
    sortOrder,
    createdAt: '2026-07-22T00:00:00.000Z',
    url: `/${id}.webp`,
  };
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function mountLightbox(items = [
  photo('photo-1', '第一张', 0),
  photo('photo-2', '第二张', 1),
]) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    response({ items, photoCount: items.length, nextCursor: null }),
  );
  const wrapper = mount(AlbumLightbox, {
    props: { album: { ...album, photoCount: items.length } },
    global: {
      stubs: {
        BaseDialog: { template: '<section><slot /></section>' },
      },
    },
  });
  await flushPromises();
  return wrapper;
}

describe('AlbumLightbox', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('loads the first cursor page and opens in thumbnail mode', async () => {
    const wrapper = await mountLightbox();

    expect(wrapper.findAll('.thumbnail-button')).toHaveLength(2);
    expect(wrapper.find('.lightbox-stage').exists()).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/v1/albums/album-1/photos?pageSize=30',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('opens the selected thumbnail and returns to the thumbnail grid', async () => {
    const wrapper = await mountLightbox();
    await wrapper.findAll('.thumbnail-button')[1]!.trigger('click');

    expect(wrapper.get('.lightbox-stage img').attributes('src')).toBe('/photo-2.webp');
    expect(wrapper.text()).toContain('第二张');

    await wrapper.get('.lightbox-back').trigger('click');
    expect(wrapper.findAll('.thumbnail-button')).toHaveLength(2);
  });

  it('uses arrow keys only while a full image is open', async () => {
    const wrapper = await mountLightbox();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await wrapper.findAll('.thumbnail-button')[0]!.trigger('click');
    expect(wrapper.get('.lightbox-stage img').attributes('src')).toBe('/photo-1.webp');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await flushPromises();
    expect(wrapper.get('.lightbox-stage img').attributes('src')).toBe('/photo-2.webp');
    wrapper.unmount();
  });

  it('appends the next cursor page without duplicating photos', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({
        items: [photo('photo-1', '第一张', 0)],
        photoCount: 2,
        nextCursor: 'cursor-1',
      }))
      .mockResolvedValueOnce(response({
        items: [photo('photo-1', '第一张', 0), photo('photo-2', '第二张', 1)],
        photoCount: 2,
        nextCursor: null,
      }));
    const wrapper = mount(AlbumLightbox, {
      props: { album },
      global: { stubs: { BaseDialog: { template: '<section><slot /></section>' } } },
    });
    await flushPromises();

    await wrapper.get('.load-more').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.thumbnail-button')).toHaveLength(2);
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      '/api/v1/albums/album-1/photos?pageSize=30&cursor=cursor-1',
      expect.anything(),
    );
  });
});
