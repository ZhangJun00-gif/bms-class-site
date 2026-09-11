import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router';
import { adminTabGuardKey, type AdminTabGuard } from '../../lib/adminTabGuard';
import type { AlbumSummary, Photo } from '../../types';
import AdminAlbums from './AdminAlbums.vue';

const confirmMock = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
const tabGuards = new Map<string, AdminTabGuard>();
const wrappers: Array<{ unmount(): void }> = [];
let router: Router;

vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));
vi.mock('../../composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: toastInfo }),
}));

function photo(id: string, albumId = 'album-1', caption = ''): Photo {
  return {
    id,
    albumId,
    caption,
    mimeType: 'image/webp',
    size: 2_048,
    width: 800,
    height: 600,
    sortOrder: 0,
    createdAt: '2026-07-20T00:00:00.000Z',
    url: `/api/v1/media/images/${id}/content`,
  };
}

function album(
  id: string,
  title: string,
  photoCount = 0,
  archivedAt: string | null = null,
): AlbumSummary {
  return {
    id,
    title,
    description: `${title}说明`,
    coverUrl: photoCount ? `/api/v1/media/images/${id}-cover/content` : null,
    photoCount,
    archivedAt,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installAlbumFetch(
  albums: AlbumSummary[],
  pages: Record<string, { items: Photo[]; nextCursor?: string | null }> = {},
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/api/v1/albums?includeArchived=true')
      return response({ items: albums, total: albums.length });
    if (url.endsWith('/originals/summary')) {
      const id = url.split('/')[4]!;
      const count = albums.find((item) => item.id === id)?.photoCount ?? 0;
      return response({ albumId: id, photoCount: count, originalCount: 0, missingOriginalCount: count, originalBytes: 0, canExport: false });
    }
    const match = url.match(/\/api\/v1\/albums\/([^/]+)\/photos\?/);
    if (match && !init?.method) {
      const page = pages[match[1]!] ?? { items: [] };
      return response({
        items: page.items,
        photoCount: albums.find((item) => item.id === match[1])?.photoCount ?? page.items.length,
        nextCursor: page.nextCursor ?? null,
      });
    }
    return response({ message: `未模拟请求 ${url}` }, 500);
  });
}

async function mountAlbums() {
  router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: AdminAlbums },
    { path: '/other', component: { template: '<p>Other page</p>' } },
  ] });
  await router.push('/');
  const wrapper = mount(RouterView, { global: {
    plugins: [router],
    provide: { [adminTabGuardKey as symbol]: {
      register: (id: string, guard: AdminTabGuard) => tabGuards.set(id, guard),
      unregister: (id: string) => tabGuards.delete(id),
    } },
  } });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

class FakeXmlHttpRequest {
  static instances: FakeXmlHttpRequest[] = [];
  status = 0;
  response: unknown = null;
  responseType = '';
  withCredentials = false;
  method = '';
  url = '';
  body: unknown = null;
  aborted = false;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() { FakeXmlHttpRequest.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  headers: Record<string, string> = {};
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: unknown) { this.body = body; }
  abort() { this.aborted = true; this.onabort?.(); }
}

async function pickPhotos(wrapper: Awaited<ReturnType<typeof mountAlbums>>, files: File[]) {
  const input = wrapper.get('#photo-files');
  Object.defineProperty(input.element, 'files', { configurable: true, value: files });
  await input.trigger('change');
}

describe('AdminAlbums', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    toastSuccess.mockReset();
    toastError.mockReset();
    toastInfo.mockReset();
  });

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    tabGuards.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeXmlHttpRequest.instances = [];
  });

  it('loads album summaries and only the selected album photo page', async () => {
    const fetchMock = installAlbumFetch(
      [album('album-1', '第一相册', 1), album('album-2', '第二相册')],
      { 'album-1': { items: [photo('photo-1')] } },
    );
    const wrapper = await mountAlbums();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/albums?includeArchived=true',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/albums/album-1/photos?pageSize=30',
      expect.anything(),
    );
    expect(wrapper.findAll('.photo-item')).toHaveLength(1);
  });

  it('uploads to the selected album and keeps existing upload feedback', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
    const albums = [album('album-1', '第一相册'), album('album-2', '第二相册')];
    const pages = { 'album-2': { items: [] as Photo[] } };
    installAlbumFetch(albums, pages);
    const wrapper = await mountAlbums();

    await wrapper.get('#managed-album').setValue('album-2');
    await flushPromises();
    await wrapper.get('#photo-caption').setValue('统一说明');
    await pickPhotos(wrapper, [new File(['image'], 'class.png', { type: 'image/png' })]);
    await wrapper.get('.upload-form').trigger('submit');
    await flushPromises();

    const request = FakeXmlHttpRequest.instances[0]!;
    expect(request.url).toBe('/api/v1/albums/album-2/photos');
    expect((request.body as FormData).get('caption')).toBe('统一说明');
    request.status = 201;
    request.response = photo('photo-2', 'album-2', '新照片');
    pages['album-2'].items = [request.response as Photo];
    albums[1]!.photoCount = 1;
    request.onload?.();
    await flushPromises();

    expect(wrapper.text()).toContain('新照片');
    expect(wrapper.text()).toContain('上传成功');
    expect(toastSuccess).toHaveBeenCalledWith('照片已全部上传');
  });

  it('cancels the remaining upload queue and aborts an upload on unmount', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
    installAlbumFetch([album('album-1', '第一相册')]);
    const wrapper = await mountAlbums();

    await pickPhotos(wrapper, [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ]);
    await wrapper.get('.upload-form').trigger('submit');
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text().includes('取消剩余'))!.trigger('click');
    await flushPromises();

    expect(FakeXmlHttpRequest.instances[0]!.aborted).toBe(true);
    expect(wrapper.text()).toContain('已取消');
    expect(toastInfo).toHaveBeenCalled();

    await pickPhotos(wrapper, [new File(['c'], 'c.png', { type: 'image/png' })]);
    await wrapper.get('.upload-form').trigger('submit');
    await flushPromises();
    wrapper.unmount();
    expect(FakeXmlHttpRequest.instances.at(-1)!.aborted).toBe(true);
  });

  it('retains the exact unknown upload and reconciles a committed retry without double-counting', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
    const albums = [album('album-1', '第一相册'), album('album-2', '第二相册')];
    const pages = { 'album-1': { items: [] as Photo[] } };
    const fetch = installAlbumFetch(albums, pages);
    const wrapper = await mountAlbums();
    const file = new File(['original'], 'original.png', { type: 'image/png' });
    await wrapper.get('#photo-caption').setValue('原说明');
    await pickPhotos(wrapper, [file]);
    await wrapper.get('.upload-form').trigger('submit');
    await flushPromises();
    const first = FakeXmlHttpRequest.instances[0]!;
    expect(wrapper.get('button[aria-label="刷新相册"]').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('button').find((button) => button.text() === '新建相册')!.attributes('disabled')).toBeDefined();
    expect(wrapper.get('#managed-album').attributes('disabled')).toBeDefined();
    await wrapper.get('button[aria-label="刷新相册"]').trigger('click');
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('includeArchived=true'))).toHaveLength(1);

    // The server committed the photo, but its response was lost.
    albums[0]!.photoCount = 1;
    pages['album-1'].items = [photo('committed', 'album-1', '已提交原图')];
    first.status = 500;
    first.response = { message: '连接异常' };
    first.onload?.();
    await flushPromises();
    expect(wrapper.text()).toContain('部分上传结果尚未确认');
    expect(wrapper.text()).toContain('已加载 1 / 1 张');
    expect(wrapper.findAll('.photo-item')).toHaveLength(1);
    expect(wrapper.find('[aria-label="清除失败文件"]').exists()).toBe(false);

    // Defend the immutable snapshot even against a programmatic select change.
    const selected = wrapper.get('#managed-album').element as HTMLSelectElement;
    selected.value = 'album-2';
    selected.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect(selected.value).toBe('album-1');
    await pickPhotos(wrapper, [new File(['replacement'], 'replacement.png', { type: 'image/png' })]);
    await wrapper.get('.upload-form').trigger('submit');
    await flushPromises();
    const retry = FakeXmlHttpRequest.instances[1]!;
    expect(retry.url).toBe(first.url);
    expect(retry.headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
    expect((retry.body as FormData).get('file')).toBe((first.body as FormData).get('file'));
    expect((retry.body as FormData).get('caption')).toBe('原说明');
    retry.status = 201;
    retry.response = pages['album-1'].items[0];
    retry.onload?.();
    await flushPromises();
    expect(wrapper.findAll('.photo-item')).toHaveLength(1);
    expect(wrapper.text()).toContain('已加载 1 / 1 张');
    expect(wrapper.get('#managed-album').text()).toContain('第一相册（1）');
    expect(wrapper.get('#managed-album').attributes('disabled')).toBeUndefined();
  });

  it('cancels old page reads at upload start and prevents pagination while the result is unknown', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
    const summary = album('album-1', '分页相册', 2);
    const fetch = installAlbumFetch([summary], { 'album-1': { items: [photo('photo-1')], nextCursor: 'next' } });
    const regularFetch = fetch.getMockImplementation()!;
    let resolvePage!: (response: Response) => void;
    let staleSignal: AbortSignal | undefined;
    fetch.mockImplementation((input, init) => {
      if (String(input).includes('cursor=next')) {
        staleSignal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve) => { resolvePage = resolve; });
      }
      return regularFetch(input, init);
    });
    const wrapper = await mountAlbums();
    await wrapper.get('.load-more').trigger('click');
    await pickPhotos(wrapper, [new File(['new'], 'new.png', { type: 'image/png' })]);
    await wrapper.get('.upload-form').trigger('submit');
    await flushPromises();
    expect(staleSignal?.aborted).toBe(true);
    expect(wrapper.get('.load-more').attributes('disabled')).toBeDefined();
    resolvePage(response({ items: [photo('wrong')], photoCount: 99, nextCursor: null }));
    await flushPromises();
    expect(wrapper.text()).not.toContain('/ 99 张');
    FakeXmlHttpRequest.instances[0]!.onerror?.();
    await flushPromises();
    const pageCount = fetch.mock.calls.filter(([url]) => String(url).includes('/photos?')).length;
    await wrapper.get('.load-more').trigger('click');
    await flushPromises();
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/photos?'))).toHaveLength(pageCount);
    expect(wrapper.text()).toContain('已加载 1 / 2 张');
  });

  it('keeps unknown status after a later rejected retry and prevents leaving until resolved', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
    installAlbumFetch([album('album-1', '第一相册')]);
    const wrapper = await mountAlbums();
    await pickPhotos(wrapper, [new File(['image'], 'file.png', { type: 'image/png' })]);
    await wrapper.get('.upload-form').trigger('submit');
    await flushPromises();
    expect(await tabGuards.get('albums')!()).toBe(false);
    await router.push('/other');
    expect(router.currentRoute.value.path).toBe('/');
    FakeXmlHttpRequest.instances[0]!.onerror?.();
    await flushPromises();
    await wrapper.get('.upload-form').trigger('submit');
    await flushPromises();
    const retry = FakeXmlHttpRequest.instances[1]!;
    retry.status = 400;
    retry.response = { message: '相册已归档' };
    retry.onload?.();
    await flushPromises();
    expect(wrapper.find('[aria-label="清除失败文件"]').exists()).toBe(false);
    expect(await tabGuards.get('albums')!()).toBe(false);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await wrapper.get('.upload-form').trigger('submit');
    await flushPromises();
    const last = FakeXmlHttpRequest.instances[2]!;
    expect(last.headers['Idempotency-Key']).toBe(retry.headers['Idempotency-Key']);
    last.status = 201;
    last.response = photo('resolved');
    last.onload?.();
    await flushPromises();
    expect(await tabGuards.get('albums')!()).toBe(true);
    await router.push('/other');
    expect(router.currentRoute.value.path).toBe('/other');
  });

  it('asks before abandoning selected files and blocks new uploads during album creation', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
    const fetch = installAlbumFetch([album('album-1', '第一相册')]);
    const regularFetch = fetch.getMockImplementation()!;
    let completeCreate!: (response: Response) => void;
    fetch.mockImplementation((input, init) => String(input) === '/api/v1/albums' && init?.method === 'POST'
      ? new Promise<Response>((resolve) => { completeCreate = resolve; }) : regularFetch(input, init));
    const wrapper = await mountAlbums();
    await pickPhotos(wrapper, [new File(['image'], 'file.png', { type: 'image/png' })]);
    confirmMock.mockResolvedValueOnce(false);
    await router.push('/other');
    expect(router.currentRoute.value.path).toBe('/');
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: '放弃未完成上传' }));
    await wrapper.findAll('button').find((button) => button.text() === '新建相册')!.trigger('click');
    await wrapper.get('#album-title').setValue('新相册');
    await wrapper.get('.create-form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('.upload-button').attributes('disabled')).toBeDefined();
    await wrapper.get('.upload-form').trigger('submit');
    await flushPromises();
    expect(FakeXmlHttpRequest.instances).toHaveLength(0);
    completeCreate(response({ message: '创建失败' }, 400));
    await flushPromises();
    expect(wrapper.get('.upload-button').attributes('disabled')).toBeUndefined();
    confirmMock.mockResolvedValueOnce(true);
    await router.push('/other');
    expect(router.currentRoute.value.path).toBe('/other');
  });

  it('creates an album and selects it for management', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === '/api/v1/albums?includeArchived=true')
        return response({ items: [], total: 0 });
      if (String(input) === '/api/v1/albums' && init?.method === 'POST')
        return response({
          id: 'album-new',
          title: '新相册',
          description: '说明',
          archivedAt: null,
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T00:00:00.000Z',
        }, 201);
      if (String(input).includes('/albums/album-new/photos?'))
        return response({ items: [], photoCount: 0, nextCursor: null });
      return response({}, 500);
    });
    const wrapper = await mountAlbums();

    await wrapper.findAll('button').find((button) => button.text() === '新建相册')!.trigger('click');
    await wrapper.get('#album-title').setValue('新相册');
    await wrapper.get('#album-description').setValue('说明');
    await wrapper.get('.create-form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('上传到「新相册」');
    expect((wrapper.get('#managed-album').element as HTMLSelectElement).value).toBe('album-new');
  });

  it('renames, archives and restores an album without deleting photos', async () => {
    const active = album('album-1', '第一相册', 1);
    const fetchMock = installAlbumFetch([active], {
      'album-1': { items: [photo('photo-1')] },
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/v1/albums?includeArchived=true')
        return response({ items: [active], total: 1 });
      if (url.includes('/albums/album-1/photos?') && !init?.method)
        return response({ items: [photo('photo-1')], photoCount: 1, nextCursor: null });
      if (url === '/api/v1/albums/album-1' && init?.method === 'PATCH')
        return response({ id: 'album-1', title: '新名称', updatedAt: active.updatedAt });
      if (url.endsWith('/album-1/archive'))
        return response({ id: 'album-1', archivedAt: '2026-08-11T00:00:00.000Z', updatedAt: active.updatedAt });
      if (url.endsWith('/album-1/restore'))
        return response({ id: 'album-1', archivedAt: null, updatedAt: active.updatedAt });
      return response({}, 500);
    });
    const wrapper = await mountAlbums();

    await wrapper.get('button[aria-label="重命名相册"]').trigger('click');
    await wrapper.get('#album-rename').setValue('新名称');
    await wrapper.get('.rename-form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('#managed-album').text()).toContain('新名称');

    await wrapper.get('button[aria-label="归档相册"]').trigger('click');
    await flushPromises();
    expect(confirmMock).toHaveBeenLastCalledWith(expect.objectContaining({
      body: expect.stringContaining('照片关系会完整保留'),
    }));

    await wrapper.findAll('.album-filters button')[1]!.trigger('click');
    await wrapper.get('button[aria-label="恢复相册"]').trigger('click');
    await flushPromises();
    expect(toastSuccess).toHaveBeenLastCalledWith('相册已恢复');
  });

  it('appends cursor pages with stable deduplication', async () => {
    const summary = album('album-1', '分页相册', 2);
    let page = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/v1/albums?includeArchived=true')
        return response({ items: [summary], total: 1 });
      if (url.endsWith('/originals/summary')) return response({ albumId: 'album-1', photoCount: 2, originalCount: 0, missingOriginalCount: 2, originalBytes: 0, canExport: false });
      page += 1;
      return page === 1
        ? response({ items: [photo('photo-1')], photoCount: 2, nextCursor: 'next-1' })
        : response({ items: [photo('photo-1'), photo('photo-2')], photoCount: 2, nextCursor: null });
    });
    const wrapper = await mountAlbums();

    await wrapper.get('.load-more').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.photo-item')).toHaveLength(2);
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      '/api/v1/albums/album-1/photos?pageSize=30&cursor=next-1',
      expect.anything(),
    );
  });

  it('removes a loaded image while preserving shared references', async () => {
    const existing = album('album-1', '第一相册', 1);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/v1/albums?includeArchived=true')
        return response({ items: [existing], total: 1 });
      if (url.includes('/albums/album-1/photos?'))
        return response({ items: [photo('photo-1', 'album-1', '活动照')], photoCount: 1, nextCursor: null });
      if (init?.method === 'DELETE')
        return response({ id: 'photo-1', removed: true, photoDeleted: false, objectDeleted: null });
      return response({}, 500);
    });
    const wrapper = await mountAlbums();

    await wrapper.get('.photo-remove').trigger('click');
    await flushPromises();

    expect(wrapper.find('.photo-item').exists()).toBe(false);
    expect(toastSuccess).toHaveBeenCalledWith('图片已从相册移除，其他业务引用保持不变');
  });

  it('retries the album list after a load error', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ message: '服务异常' }, 500))
      .mockResolvedValueOnce(response({ items: [album('album-1', '重试成功')], total: 1 }))
      .mockResolvedValueOnce(response({ items: [], photoCount: 0, nextCursor: null }));
    const wrapper = await mountAlbums();
    expect(wrapper.text()).toContain('服务异常');

    await wrapper.findAll('button').find((button) => button.text().includes('重试加载相册'))!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('重试成功');
  });
});
