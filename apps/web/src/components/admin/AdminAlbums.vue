<script setup lang="ts">
import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import {
  Archive,
  ArchiveRestore,
  Check,
  Download,
  ImagePlus,
  Images,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-vue-next';
import type { AlbumOriginalSummary } from '@bmc3/contracts';
import type {
  AlbumPhotoPage,
  AlbumPhotoRemoveResult,
  AlbumSummary,
  AlbumSummaryListResponse,
  Photo,
} from '../../types';
import { ApiClientError, api, apiUrl, formatError, isAbortError, uploadForm } from '../../lib/api';
import { formatBytes } from '../../lib/formatters';
import { adminTabGuardKey } from '../../lib/adminTabGuard';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useToast } from '../../composables/useToast';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';

const ACCEPT = 'image/jpeg,image/png,image/webp';
const MAX_SIZE = 10 * 1024 * 1024;
const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHOTO_PAGE_SIZE = 30;

const { confirm } = useConfirm();
const toast = useToast();
const albumRequests = useLatestRequest();
const photoRequests = useLatestRequest();
const originalRequests = useLatestRequest();
const mutations = useLatestRequest();

const albums = ref<AlbumSummary[]>([]);
const albumFilter = ref<'active' | 'archived'>('active');
const selectedAlbumId = ref('');
const loadError = ref('');
const loading = albumRequests.loading;
const activeAlbums = computed(() =>
  albums.value.filter((album) => !album.archivedAt),
);
const archivedAlbums = computed(() =>
  albums.value.filter((album) => Boolean(album.archivedAt)),
);
const visibleAlbums = computed(() =>
  albumFilter.value === 'active' ? activeAlbums.value : archivedAlbums.value,
);
const selectedAlbum = computed(
  () => albums.value.find((album) => album.id === selectedAlbumId.value) ?? null,
);

const photos = ref<Photo[]>([]);
const photoCount = ref(0);
const photoNextCursor = ref<string | null>(null);
const photoError = ref('');
const photoAppendError = ref('');
const loadingPhotos = photoRequests.loading;
const loadMoreTrigger = ref<HTMLButtonElement | null>(null);
let photoObserver: IntersectionObserver | null = null;

const showCreate = ref(false);
const title = ref('');
const description = ref('');
const creating = ref(false);
const createError = ref('');

const renaming = ref(false);
const renameTitle = ref('');
const renameError = ref('');

const caption = ref('');
const originalSummary = ref<AlbumOriginalSummary | null>(null);
const originalError = ref('');
const preparingDownload = ref(false);
const uploadSnapshot = ref<{ albumId: string; caption: string } | null>(null);
const uploadLocked = computed(() => uploading.value || uploadSnapshot.value !== null);
const uncertainFiles = reactive(new Set<File>());
const uploadKeys = new Map<File, string>();
const previews = ref<Array<{ file: File; url: string }>>([]);
const files = ref<File[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const uploadError = ref('');
const uploadProgress = ref<{
  index: number;
  total: number;
  percent: number | null;
} | null>(null);
let uploadController: AbortController | null = null;
const results = ref<Array<{ name: string; ok: boolean; message: string }>>([]);
const removingIds = reactive(new Set<string>());
const removeErrors = reactive<Record<string, string>>({});
const albumMutationPending = computed(() => creating.value || removingIds.size > 0 || Boolean(selectedAlbum.value && mutations.isBusy(`album:${selectedAlbum.value.id}`)));
const guards = inject(adminTabGuardKey, null);
let alive = true;

onMounted(() => {
  void loadAlbums();
  guards?.register('albums', allowLeave);
  window.addEventListener('beforeunload', beforeUnload);
});
onBeforeRouteLeave(allowLeave);

async function allowLeave() {
  if (uploading.value || uncertainFiles.size) {
    uploadError.value = '上传结果尚未确认，请先重试原文件。';
    return false;
  }
  return !files.value.length || await confirm({
    title: '放弃未完成上传',
    body: '尚未上传成功的照片将从当前草稿中移除。',
    confirmText: '放弃上传',
    danger: true,
  });
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (files.value.length || uploadLocked.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}

watch(selectedAlbumId, () => {
  if (uploadSnapshot.value && selectedAlbumId.value !== uploadSnapshot.value.albumId) {
    selectedAlbumId.value = uploadSnapshot.value.albumId;
    return;
  }
  renaming.value = false;
  renameError.value = '';
  void loadPhotos(false);
  void loadOriginalSummary();
});

watch(files, (value) => {
  for (const preview of previews.value) if (preview.url) URL.revokeObjectURL(preview.url);
  previews.value = value.map((file) => ({ file, url: typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '' }));
});

watch(loadMoreTrigger, (element) => {
  photoObserver?.disconnect();
  if (!element || typeof IntersectionObserver === 'undefined') return;
  photoObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void loadPhotos(true);
  }, { rootMargin: '160px' });
  photoObserver.observe(element);
});

onBeforeUnmount(() => {
  alive = false;
  guards?.unregister('albums');
  window.removeEventListener('beforeunload', beforeUnload);
  uploadController?.abort();
  albumRequests.cancelLatest();
  photoRequests.cancelLatest();
  originalRequests.cancelLatest();
  for (const preview of previews.value) if (preview.url) URL.revokeObjectURL(preview.url);
  photoObserver?.disconnect();
});

function selectFallback() {
  if (uploadLocked.value) return;
  if (visibleAlbums.value.some((album) => album.id === selectedAlbumId.value)) return;
  selectedAlbumId.value = visibleAlbums.value[0]?.id ?? '';
}

function setFilter(filter: 'active' | 'archived') {
  if (uploadLocked.value || albumFilter.value === filter) return;
  albumFilter.value = filter;
  selectFallback();
}

function selectAlbum(event: Event) {
  const select = event.target as HTMLSelectElement;
  if (uploadLocked.value) {
    select.value = uploadSnapshot.value?.albumId ?? selectedAlbumId.value;
    return;
  }
  selectedAlbumId.value = select.value;
}

async function loadAlbums() {
  if (uploadLocked.value || albumMutationPending.value) return;
  loadError.value = '';
  await albumRequests.runLatest(
    ({ signal }) => api<AlbumSummaryListResponse>(
      '/albums?includeArchived=true',
      { signal },
    ),
    {
      commit(result) {
        if (uploadLocked.value) return;
        albums.value = result.items;
        selectFallback();
      },
      onError(caught) {
        loadError.value = formatError(caught, '相册加载失败，请稍后重试');
      },
    },
  );
}

async function loadPhotos(append: boolean, reconcileUpload = false) {
  if (uploadLocked.value && !reconcileUpload) return;
  const albumId = selectedAlbumId.value;
  if (!albumId || (append && (!photoNextCursor.value || loadingPhotos.value))) {
    if (!albumId) {
      photos.value = [];
      photoCount.value = 0;
      photoNextCursor.value = null;
    }
    return;
  }
  const cursor = append ? photoNextCursor.value : null;
  if (!append) {
    photos.value = [];
    photoCount.value = selectedAlbum.value?.photoCount ?? 0;
    photoNextCursor.value = null;
    photoError.value = '';
  }
  photoAppendError.value = '';
  await photoRequests.runLatest(
    ({ signal }) => {
      const params = new URLSearchParams({ pageSize: String(PHOTO_PAGE_SIZE) });
      if (cursor) params.set('cursor', cursor);
      return api<AlbumPhotoPage>(
        `/albums/${albumId}/photos?${params.toString()}`,
        { signal },
      );
    },
    {
      commit(result) {
        if (selectedAlbumId.value !== albumId) return;
        const merged = append ? [...photos.value, ...result.items] : result.items;
        photos.value = Array.from(
          new Map(merged.map((photo) => [photo.id, photo])).values(),
        );
        photoCount.value = result.photoCount;
        photoNextCursor.value = result.nextCursor;
        const album = selectedAlbum.value;
        if (album) {
          album.photoCount = result.photoCount;
          if (!append) album.coverUrl = result.items[0]?.url ?? null;
        }
      },
      onError(caught) {
        const message = formatError(caught, '照片加载失败，请稍后重试');
        if (append) photoAppendError.value = message;
        else photoError.value = message;
      },
    },
  );
}

async function createAlbum() {
  if (uploadLocked.value || creating.value) return;
  const normalizedTitle = title.value.trim();
  if (!normalizedTitle) {
    createError.value = '请输入相册名';
    return;
  }
  creating.value = true;
  createError.value = '';
  try {
    const created = await api<Omit<AlbumSummary, 'coverUrl' | 'photoCount'>>(
      '/albums',
      {
        method: 'POST',
        body: JSON.stringify({
          title: normalizedTitle,
          description: description.value.trim(),
        }),
      },
    );
    const album: AlbumSummary = {
      ...created,
      archivedAt: null,
      coverUrl: null,
      photoCount: 0,
    };
    albums.value.unshift(album);
    albumFilter.value = 'active';
    selectedAlbumId.value = album.id;
    title.value = '';
    description.value = '';
    showCreate.value = false;
    toast.success(`相册「${album.title}」已创建`);
  } catch (caught) {
    createError.value = formatError(caught, '创建失败，请稍后重试');
  } finally {
    creating.value = false;
  }
}

function cancelCreate() {
  if (creating.value) return;
  showCreate.value = false;
  createError.value = '';
}

function beginRename() {
  if (!selectedAlbum.value || uploadLocked.value) return;
  renameTitle.value = selectedAlbum.value.title;
  renameError.value = '';
  renaming.value = true;
}

function cancelRename() {
  if (selectedAlbum.value && mutations.isBusy(`album:${selectedAlbum.value.id}`)) return;
  renaming.value = false;
  renameError.value = '';
}

async function saveRename() {
  if (uploadLocked.value) return;
  const album = selectedAlbum.value;
  const normalizedTitle = renameTitle.value.trim();
  if (!album || !normalizedTitle) {
    renameError.value = '请输入相册名';
    return;
  }
  await mutations.runBusy(`album:${album.id}`, async () => {
    renameError.value = '';
    try {
      const updated = await api<Pick<AlbumSummary, 'id' | 'title' | 'updatedAt'>>(
        `/albums/${album.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ title: normalizedTitle }),
        },
      );
      album.title = updated.title;
      album.updatedAt = updated.updatedAt;
      renaming.value = false;
      toast.success('相册名称已更新');
    } catch (caught) {
      renameError.value = formatError(caught, '重命名失败，请稍后重试');
    }
  });
}

async function setArchived(archive: boolean) {
  const album = selectedAlbum.value;
  if (!album || uploadLocked.value) return;
  const accepted = await confirm({
    title: archive ? '归档相册' : '恢复相册',
    body: archive
      ? '归档后普通成员将无法查看相册及照片，照片关系会完整保留，可随时恢复。'
      : '恢复后相册及照片将重新对班级成员可见。',
    confirmText: archive ? '归档' : '恢复',
    danger: archive,
  });
  if (!accepted || uploadLocked.value) return;
  await mutations.runBusy(`album:${album.id}`, async () => {
    try {
      const updated = await api<Pick<AlbumSummary, 'id' | 'archivedAt' | 'updatedAt'>>(
        `/albums/${album.id}/${archive ? 'archive' : 'restore'}`,
        { method: 'POST' },
      );
      album.archivedAt = updated.archivedAt;
      album.updatedAt = updated.updatedAt;
      selectFallback();
      toast.success(archive ? '相册已归档，照片关系保持不变' : '相册已恢复');
    } catch (caught) {
      toast.error(formatError(caught, archive ? '归档失败' : '恢复失败'));
    }
  });
}

function pickFiles(event: Event) {
  if (uploadLocked.value) return;
  const input = event.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  uploadError.value = '';
  results.value = [];
  const invalid = picked.find((file) => !SUPPORTED_TYPES.includes(file.type));
  if (invalid) {
    resetFiles();
    uploadError.value = `「${invalid.name}」不是支持的格式，仅支持 JPEG、PNG 或 WebP 图片`;
    return;
  }
  const oversize = picked.find((file) => file.size > MAX_SIZE);
  if (oversize) {
    resetFiles();
    uploadError.value = `「${oversize.name}」超过 10MB 限制`;
    return;
  }
  files.value = picked;
}

async function loadOriginalSummary() {
  const albumId = selectedAlbumId.value;
  originalSummary.value = null;
  originalError.value = '';
  if (!albumId) { originalRequests.cancelLatest(); return; }
  await originalRequests.runLatest(
    ({ signal }) => api<AlbumOriginalSummary>(`/albums/${albumId}/originals/summary`, { signal }),
    {
      commit(result) { if (selectedAlbumId.value === albumId) originalSummary.value = result; },
      onError(caught) { originalError.value = formatError(caught, '原图信息加载失败'); },
    },
  );
}

async function downloadOriginals() {
  const albumId = selectedAlbumId.value;
  if (!albumId || preparingDownload.value || !originalSummary.value?.canExport) return;
  preparingDownload.value = true;
  try {
    const summary = await api<AlbumOriginalSummary>(`/albums/${albumId}/originals/summary`);
    if (selectedAlbumId.value !== albumId) return;
    originalSummary.value = summary;
    if (!summary.canExport) { toast.info('这些照片未保留原图'); return; }
    const accepted = await confirm({
      title: '下载相册原图',
      body: `${summary.originalCount} 张原图，约 ${formatBytes(summary.originalBytes)}。${summary.missingOriginalCount ? `另有 ${summary.missingOriginalCount} 张历史照片未保留原图，将在清单中标明。` : ''}`,
      confirmText: '下载原图',
    });
    if (!accepted || selectedAlbumId.value !== albumId) return;
    const link = document.createElement('a');
    link.href = apiUrl(`/albums/${albumId}/originals.zip`);
    link.target = '_blank';
    link.rel = 'noopener';
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
  } catch (caught) {
    toast.error(formatError(caught, '原图下载准备失败'));
  } finally { preparingDownload.value = false; }
}

async function uploadPhotos() {
  const album = selectedAlbum.value;
  if (!album || album.archivedAt || !files.value.length || uploading.value || albumMutationPending.value) return;
  uploading.value = true;
  albumRequests.cancelLatest();
  photoRequests.cancelLatest();
  originalRequests.cancelLatest();
  uploadError.value = '';
  results.value = [];
  uploadProgress.value = null;
  const controller = new AbortController();
  uploadController = controller;
  const queue = [...files.value];
  uploadSnapshot.value ??= { albumId: album.id, caption: caption.value.trim() };
  const snapshot = uploadSnapshot.value;
  const remaining: File[] = [];
  let cancelled = false;
  for (const [offset, file] of queue.entries()) {
    uploadProgress.value = { index: offset + 1, total: queue.length, percent: null };
    const form = new FormData();
    form.append('file', file);
    if (snapshot.caption) form.append('caption', snapshot.caption);
    if (!uploadKeys.has(file)) uploadKeys.set(file, crypto.randomUUID());
    try {
      const photo = await uploadForm<Photo>(`/albums/${snapshot.albumId}/photos`, form, {
        headers: { 'Idempotency-Key': uploadKeys.get(file)! },
        signal: controller.signal,
        onProgress(progress) {
          uploadProgress.value = {
            index: offset + 1,
            total: queue.length,
            percent: progress.percent,
          };
        },
      });
      uncertainFiles.delete(file);
      uploadKeys.delete(file);
      results.value.push({ name: file.name, ok: true, message: photo.originalAvailable ? '上传成功，原图已保留' : '上传成功' });
    } catch (caught) {
      const uncertain = !(caught instanceof ApiClientError) || caught.status >= 500 || caught.status === 409;
      if (uncertain) uncertainFiles.add(file);
      if (isAbortError(caught)) {
        cancelled = true;
        remaining.push(...queue.slice(offset));
        for (const rest of queue.slice(offset))
          results.value.push({ name: rest.name, ok: false, message: '已取消' });
        break;
      }
      remaining.push(file);
      results.value.push({
        name: file.name,
        ok: false,
        message: formatError(caught, '上传失败'),
      });
    }
  }
  if (!alive) return;
  const failed = results.value.filter((result) => !result.ok).length;
  files.value = remaining;
  if (!remaining.length) { resetFiles(); uploadSnapshot.value = null; }
  else uploadError.value = uncertainFiles.size ? '部分上传结果尚未确认，请重试原文件。' : '部分照片上传失败，文件已保留。';
  uploadProgress.value = null;
  uploadController = null;
  // A failed response can conceal a committed upload. Read authoritative IDs
  // and totals instead of adding the idempotent retry response a second time.
  await loadPhotos(false, true);
  await loadOriginalSummary();
  uploading.value = false;
  if (cancelled) toast.info('已取消剩余上传，已上传成功的照片保留在相册中');
  else if (!failed) {
    caption.value = '';
    toast.success('照片已全部上传');
  }
}

function discardFailedFiles() {
  if (uploading.value || uncertainFiles.size) return;
  uploadSnapshot.value = null;
  uploadKeys.clear();
  resetFiles();
  uploadError.value = '';
}

function cancelUploads() {
  uploadController?.abort();
}

async function removePhoto(photo: Photo) {
  const album = selectedAlbum.value;
  if (!album || removingIds.has(photo.id) || uploadLocked.value) return;
  const approved = await confirm({
    title: '从相册移除图片',
    body: '图片将从当前相册移除。若动态或题库仍在使用，原图会继续保留；没有其他引用时，图片记录和 COS 对象将一并清理。',
    confirmText: '移除图片',
    danger: true,
  });
  if (!approved || uploadLocked.value) return;

  removingIds.add(photo.id);
  delete removeErrors[photo.id];
  try {
    const result = await api<AlbumPhotoRemoveResult>(
      `/albums/${album.id}/photos/${photo.id}`,
      { method: 'DELETE' },
    );
    photos.value = photos.value.filter((item) => item.id !== photo.id);
    photoCount.value = Math.max(0, photoCount.value - 1);
    album.photoCount = photoCount.value;
    if (album.coverUrl === photo.url) album.coverUrl = photos.value[0]?.url ?? null;
    if (!result.photoDeleted) toast.success('图片已从相册移除，其他业务引用保持不变');
    else if (result.objectDeleted === false)
      toast.error('图片已移除，COS 清理失败，后端将定期重试');
    else toast.success('图片已移除并完成存储清理');
    await loadOriginalSummary();
  } catch (caught) {
    removeErrors[photo.id] = formatError(caught, '移除失败，请稍后重试');
  } finally {
    removingIds.delete(photo.id);
  }
}

function resetFiles() {
  files.value = [];
  if (fileInput.value) fileInput.value.value = '';
}
</script>

<template>
  <section aria-label="相册管理" class="album-admin">
    <header class="section-heading">
      <div>
        <h2>相册管理</h2>
        <p>{{ activeAlbums.length }} 个使用中 · {{ archivedAlbums.length }} 个已归档</p>
      </div>
      <div class="heading-actions">
        <button
          type="button"
          class="icon-button"
          :disabled="loading || uploadLocked || albumMutationPending"
          aria-label="刷新相册"
          title="刷新相册"
          @click="loadAlbums"
        >
          <RefreshCw :size="17" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="button secondary"
          :aria-expanded="showCreate"
          :disabled="uploadLocked || creating"
          @click="showCreate = !showCreate"
        >
          <X v-if="showCreate" :size="17" aria-hidden="true" />
          <Plus v-else :size="17" aria-hidden="true" />
          {{ showCreate ? '关闭表单' : '新建相册' }}
        </button>
      </div>
    </header>

    <form v-if="showCreate" class="form create-form" @submit.prevent="createAlbum">
      <p v-if="createError" class="alert error" role="alert">{{ createError }}</p>
      <div class="create-fields">
        <div class="field">
          <label for="album-title">相册名</label>
          <input id="album-title" v-model="title" required maxlength="160" :disabled="uploadLocked || creating" />
        </div>
        <div class="field description-field">
          <label for="album-description">说明</label>
          <input id="album-description" v-model="description" maxlength="2000" :disabled="uploadLocked || creating" />
        </div>
        <div class="create-actions">
          <button class="button" type="submit" :disabled="creating || uploadLocked">
            {{ creating ? '正在创建…' : '创建相册' }}
          </button>
          <button class="button ghost" type="button" :disabled="creating" @click="cancelCreate">
            取消
          </button>
        </div>
      </div>
    </form>

    <div class="album-filters" role="tablist" aria-label="相册状态">
      <button
        type="button"
        role="tab"
        :aria-selected="albumFilter === 'active'"
        :class="{ active: albumFilter === 'active' }"
        :disabled="uploadLocked"
        @click="setFilter('active')"
      >
        使用中（{{ activeAlbums.length }}）
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="albumFilter === 'archived'"
        :class="{ active: albumFilter === 'archived' }"
        :disabled="uploadLocked"
        @click="setFilter('archived')"
      >
        已归档（{{ archivedAlbums.length }}）
      </button>
    </div>

    <SkeletonBlock v-if="loading" :lines="5" :height="18" />
    <ErrorState
      v-else-if="loadError"
      :message="loadError"
      retry-label="重试加载相册"
      @retry="loadAlbums"
    />
    <EmptyState
      v-else-if="!visibleAlbums.length"
      :title="albumFilter === 'active' ? '暂无使用中的相册' : '暂无已归档相册'"
    >
      <template #icon><Images :size="32" aria-hidden="true" /></template>
    </EmptyState>

    <div v-else-if="selectedAlbum" class="album-workspace">
      <div class="album-toolbar">
        <div class="field album-picker">
          <label for="managed-album">当前相册</label>
          <select id="managed-album" :value="selectedAlbumId" :disabled="uploadLocked" @change="selectAlbum">
            <option v-for="album in visibleAlbums" :key="album.id" :value="album.id">
              {{ album.title }}（{{ album.photoCount }}）
            </option>
          </select>
        </div>
        <div class="album-identity">
          <form v-if="renaming" class="rename-form" @submit.prevent="saveRename">
            <label class="sr-only" for="album-rename">相册名</label>
            <input id="album-rename" v-model="renameTitle" maxlength="160" required />
            <button
              type="submit"
              class="icon-button"
              title="保存名称"
              aria-label="保存相册名称"
              :disabled="mutations.isBusy(`album:${selectedAlbum.id}`) || uploadLocked"
            >
              <Check :size="17" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="icon-button"
              title="取消重命名"
              aria-label="取消重命名"
              :disabled="mutations.isBusy(`album:${selectedAlbum.id}`)"
              @click="cancelRename"
            >
              <X :size="17" aria-hidden="true" />
            </button>
          </form>
          <div v-else class="album-actions">
            <span v-if="originalSummary" class="original-count">原图 {{ originalSummary.originalCount }} / 照片 {{ originalSummary.photoCount }}</span>
            <button type="button" class="icon-button" title="下载原图" aria-label="下载原图"
              :disabled="!originalSummary?.canExport || preparingDownload || uploading" @click="downloadOriginals">
              <Download :size="17" aria-hidden="true" />
            </button>
            <StatusBadge
              :text="selectedAlbum.archivedAt ? '已归档' : '使用中'"
              :tone="selectedAlbum.archivedAt ? 'muted' : 'success'"
            />
            <button
              type="button"
              class="icon-button"
              title="重命名相册"
              aria-label="重命名相册"
              :disabled="mutations.isBusy(`album:${selectedAlbum.id}`) || uploadLocked"
              @click="beginRename"
            >
              <Pencil :size="16" aria-hidden="true" />
            </button>
            <button
              v-if="selectedAlbum.archivedAt"
              type="button"
              class="icon-button"
              title="恢复相册"
              aria-label="恢复相册"
              :disabled="mutations.isBusy(`album:${selectedAlbum.id}`)"
              @click="setArchived(false)"
            >
              <ArchiveRestore :size="17" aria-hidden="true" />
            </button>
            <button
              v-else
              type="button"
              class="icon-button danger-icon"
              title="归档相册"
              aria-label="归档相册"
              :disabled="mutations.isBusy(`album:${selectedAlbum.id}`) || uploadLocked"
              @click="setArchived(true)"
            >
              <Archive :size="17" aria-hidden="true" />
            </button>
          </div>
          <p v-if="renameError" class="rename-error" role="alert">{{ renameError }}</p>
          <p v-if="originalSummary && originalSummary.photoCount && !originalSummary.canExport" class="field-hint">这些照片未保留原图</p>
          <p v-if="originalError" class="rename-error" role="alert">{{ originalError }} <button type="button" class="icon-button" title="重试原图信息" aria-label="重试原图信息" @click="loadOriginalSummary"><RefreshCw :size="16" /></button></p>
          <p v-if="selectedAlbum.description" class="album-description">
            {{ selectedAlbum.description }}
          </p>
        </div>
      </div>

      <section
        v-if="!selectedAlbum.archivedAt"
        class="upload-section"
        :aria-label="`上传到${selectedAlbum.title}`"
      >
        <div class="subheading">
          <ImagePlus :size="19" aria-hidden="true" />
          <h3>上传到「{{ selectedAlbum.title }}」</h3>
        </div>
        <form class="form upload-form" @submit.prevent="uploadPhotos">
          <p v-if="uploadError" class="alert error upload-message" role="alert">{{ uploadError }}</p>
          <div class="field">
            <label for="photo-files">选择照片</label>
            <input
              id="photo-files"
              ref="fileInput"
              type="file"
              :accept="ACCEPT"
              multiple
              :disabled="uploadLocked"
              @change="pickFiles"
            />
            <p class="field-hint">JPEG、PNG、WebP，单张不超过 10MB。</p>
          </div>
          <div class="field">
            <label for="photo-caption">统一说明（可选）</label>
            <input id="photo-caption" v-model="caption" maxlength="300" :disabled="uploadLocked" />
          </div>
          <div v-if="uploading && uploadProgress" class="upload-progress" role="status">
            <progress
              v-if="uploadProgress.percent !== null"
              :value="uploadProgress.percent"
              max="100"
            />
            <span>
              第 {{ uploadProgress.index }}/{{ uploadProgress.total }} 张<template v-if="uploadProgress.percent !== null"> · {{ uploadProgress.percent }}%</template><template v-else> · 等待服务器响应…</template>
            </span>
          </div>
          <div class="upload-buttons">
            <button v-if="uploadSnapshot && !uploading && !uncertainFiles.size" type="button" class="icon-button" title="清除失败文件" aria-label="清除失败文件" @click="discardFailedFiles"><Trash2 :size="17" /></button>
            <button class="button upload-button" type="submit" :disabled="uploading || !files.length || albumMutationPending">
              <ImagePlus :size="17" aria-hidden="true" />
              {{ uploading ? '正在上传…' : files.length ? `上传 ${files.length} 张` : '上传照片' }}
            </button>
            <button
              v-if="uploading"
              type="button"
              class="button ghost"
              @click="cancelUploads"
            >
              <X :size="16" aria-hidden="true" />
              取消剩余
            </button>
          </div>
        </form>

        <ul v-if="previews.length" class="selected-previews">
          <li v-for="(preview, index) in previews" :key="index">
            <img v-if="preview.url" :src="preview.url" :alt="preview.file.name" />
            <span>{{ preview.file.name }}</span>
          </li>
        </ul>

        <ul v-if="results.length" class="upload-results" aria-live="polite">
          <li v-for="(result, index) in results" :key="`${result.name}-${index}`" :class="{ ok: result.ok }">
            <span class="result-name">{{ result.name }}</span>
            <span>{{ result.message }}</span>
          </li>
        </ul>
      </section>
      <p v-else class="alert info archived-note" role="status">
        该相册已归档，成员当前无法查看；恢复后才能继续上传照片。
      </p>

      <section class="photo-section" aria-label="已有照片">
        <div class="photo-heading">
          <h3>已有照片</h3>
          <span>已加载 {{ photos.length }} / {{ photoCount }} 张</span>
        </div>
        <SkeletonBlock v-if="loadingPhotos && !photos.length" :lines="4" />
        <ErrorState
          v-else-if="photoError"
          :message="photoError"
          retry-label="重试加载照片"
          @retry="loadPhotos(false)"
        />
        <EmptyState v-else-if="!photos.length" title="该相册暂无照片" />
        <div v-else class="photo-grid">
          <article v-for="photo in photos" :key="photo.id" class="photo-item">
            <div class="photo-preview">
              <img :src="photo.url" :alt="photo.caption || selectedAlbum.title" loading="lazy" />
              <button
                type="button"
                class="icon-button photo-remove"
                :disabled="removingIds.has(photo.id) || uploadLocked"
                :aria-label="removingIds.has(photo.id) ? '正在移除图片' : '从相册移除图片'"
                :title="removingIds.has(photo.id) ? '正在移除' : '移除图片'"
                @click="removePhoto(photo)"
              >
                <Trash2 :size="17" aria-hidden="true" />
              </button>
            </div>
            <div class="photo-meta">
              <p>{{ photo.caption || '无说明' }}</p>
              <span>{{ formatBytes(photo.size) }}<template v-if="photo.width && photo.height"> · {{ photo.width }}×{{ photo.height }}</template></span>
              <p v-if="removeErrors[photo.id]" class="remove-error" role="alert">
                {{ removeErrors[photo.id] }}
              </p>
            </div>
          </article>
        </div>
        <p v-if="photoAppendError" class="alert error" role="alert">
          {{ photoAppendError }}
        </p>
        <button
          v-if="photoNextCursor"
          ref="loadMoreTrigger"
          type="button"
          class="button ghost load-more"
          :disabled="loadingPhotos || uploadLocked"
          @click="loadPhotos(true)"
        >
          {{ loadingPhotos ? '正在加载…' : '加载更多照片' }}
        </button>
      </section>
    </div>
  </section>
</template>

<style scoped>
.album-admin {
  display: grid;
  gap: var(--space-6);
}

.section-heading,
.heading-actions,
.album-toolbar,
.subheading,
.photo-heading {
  display: flex;
  align-items: center;
}

.section-heading {
  justify-content: space-between;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.section-heading h2,
.subheading h3,
.photo-heading h3 {
  margin: 0;
  font-size: 18px;
}

.section-heading p {
  margin: var(--space-1) 0 0;
  color: var(--muted);
  font-size: 13px;
}

.heading-actions {
  gap: var(--space-2);
}

.album-filters {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}

.album-filters button {
  min-height: 38px;
  padding: 0 var(--space-4);
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
}

.album-filters button.active {
  border-bottom-color: var(--accent);
  color: var(--primary-dark);
  font-weight: 600;
}

.create-form {
  padding: var(--space-5) 0;
  border-bottom: 1px solid var(--border);
}

.create-fields {
  display: grid;
  grid-template-columns: minmax(180px, 0.7fr) minmax(240px, 1.3fr) auto;
  align-items: end;
  gap: var(--space-4);
}

.create-actions {
  display: flex;
  gap: var(--space-2);
}

.album-workspace {
  display: grid;
  gap: var(--space-8);
}

.album-toolbar {
  align-items: end;
  gap: var(--space-5);
}

.album-picker {
  width: min(420px, 100%);
  flex: none;
}

.album-identity {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: var(--space-2);
}

.album-actions,
.rename-form {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.rename-form input {
  width: min(360px, 100%);
}

.danger-icon,
.rename-error {
  color: var(--danger);
}

.rename-error {
  margin: 0;
  font-size: 12px;
}

.album-description {
  max-width: 64ch;
  margin: 0;
  color: var(--ink-soft);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.archived-note {
  margin: 0;
}

.upload-section {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-5) 0;
  border-block: 1px solid var(--border);
}

.subheading {
  gap: var(--space-2);
  color: var(--primary);
}

.upload-form {
  grid-template-columns: minmax(220px, 1.2fr) minmax(180px, 1fr) auto;
  align-items: start;
}

.upload-message {
  grid-column: 1 / -1;
}

.upload-progress {
  grid-column: 1 / -1;
  display: grid;
  gap: var(--space-1);
  color: var(--muted);
  font-size: 13px;
}

.upload-progress progress {
  width: 100%;
  height: 8px;
  accent-color: var(--accent);
}

.upload-buttons {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: 25px;
}

.upload-results {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.upload-results li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 8px 10px;
  border-left: 3px solid var(--danger);
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 13px;
}

.upload-results li.ok {
  border-color: var(--success);
  background: var(--success-bg);
  color: var(--success);
}

.result-name {
  color: var(--ink-soft);
  overflow-wrap: anywhere;
}

.photo-section {
  display: grid;
  gap: var(--space-4);
}

.photo-heading {
  justify-content: space-between;
  gap: var(--space-3);
}

.photo-heading span {
  color: var(--muted);
  font-size: 13px;
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: var(--space-4);
}

.photo-item {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}

.photo-preview {
  position: relative;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--surface-muted);
}

.photo-preview img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.photo-remove {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  color: var(--danger);
  background: rgba(255, 255, 255, 0.94);
  box-shadow: var(--shadow-s);
}

.photo-meta {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3);
}

.photo-meta p {
  margin: 0;
  color: var(--ink-soft);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.original-count { color: var(--muted); font-size: 13px; }
.selected-previews { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 12px; margin: 12px 0; padding: 0; list-style: none; }
.selected-previews li { min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
.selected-previews img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; }

.photo-meta span {
  color: var(--muted);
  font-size: 12px;
}

.photo-meta .remove-error {
  color: var(--danger);
  font-size: 12px;
}

.load-more {
  justify-self: center;
}

@media (max-width: 820px) {
  .create-fields,
  .upload-form {
    grid-template-columns: 1fr 1fr;
  }

  .create-actions,
  .upload-buttons {
    grid-column: 1 / -1;
  }

  .upload-buttons {
    width: fit-content;
    margin-top: 0;
  }
}

@media (max-width: 600px) {
  .section-heading,
  .album-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .album-filters {
    overflow-x: auto;
  }

  .album-filters button {
    flex: 1 0 auto;
  }

  .heading-actions {
    justify-content: space-between;
  }

  .create-fields,
  .upload-form {
    grid-template-columns: 1fr;
  }

  .description-field,
  .create-actions,
  .upload-buttons {
    grid-column: auto;
  }

  .create-actions .button,
  .upload-buttons .button {
    flex: 1;
  }

  .album-description {
    margin: 0;
  }

  .rename-form input {
    min-width: 0;
    flex: 1;
  }

  .photo-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .photo-meta {
    padding: var(--space-2);
  }
}

@media (max-width: 370px) {
  .photo-grid {
    grid-template-columns: 1fr;
  }
}
</style>
