<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ChevronLeft, ChevronRight, ImageOff, Images } from 'lucide-vue-next';
import BaseDialog from '../common/BaseDialog.vue';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { api, formatError } from '../../lib/api';
import type { AlbumPhotoPage, AlbumSummary, Photo } from '../../types';

const props = defineProps<{ album: AlbumSummary | null }>();
const emit = defineEmits<{ close: [] }>();

const PAGE_SIZE = 30;
const index = ref(0);
const failed = ref(false);
const viewingPhoto = ref(false);
const photos = ref<Photo[]>([]);
const photoCount = ref(0);
const nextCursor = ref<string | null>(null);
const loadError = ref('');
const appendError = ref('');
const requests = useLatestRequest();
const loading = requests.loading;
const loadMoreTrigger = ref<HTMLButtonElement | null>(null);
let observer: IntersectionObserver | null = null;

const current = computed(() => photos.value[index.value]);
const canStepPrevious = computed(() =>
  photos.value.length > 1 && (index.value > 0 || !nextCursor.value),
);
const canStepNext = computed(() =>
  photos.value.length > 1 || Boolean(nextCursor.value),
);

watch(
  () => props.album?.id,
  (albumId) => {
    requests.cancelLatest();
    index.value = 0;
    failed.value = false;
    viewingPhoto.value = false;
    photos.value = [];
    photoCount.value = props.album?.photoCount ?? 0;
    nextCursor.value = null;
    loadError.value = '';
    appendError.value = '';
    document.removeEventListener('keydown', onKeydown);
    if (albumId) {
      document.addEventListener('keydown', onKeydown);
      void loadPhotos(false);
    }
  },
  { immediate: true },
);

watch(loadMoreTrigger, (element) => {
  observer?.disconnect();
  if (!element || typeof IntersectionObserver === 'undefined') return;
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void loadPhotos(true);
  }, { rootMargin: '120px' });
  observer.observe(element);
});

watch(index, () => {
  failed.value = false;
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  requests.cancelLatest();
  observer?.disconnect();
});

async function loadPhotos(append: boolean) {
  const albumId = props.album?.id;
  if (!albumId || (append && (!nextCursor.value || loading.value))) return;
  const cursor = append ? nextCursor.value : null;
  if (!append) loadError.value = '';
  appendError.value = '';
  await requests.runLatest(
    ({ signal }) => {
      const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
      if (cursor) params.set('cursor', cursor);
      return api<AlbumPhotoPage>(
        `/albums/${albumId}/photos?${params.toString()}`,
        { signal },
      );
    },
    {
      commit(result) {
        if (props.album?.id !== albumId) return;
        const merged = append ? [...photos.value, ...result.items] : result.items;
        photos.value = Array.from(
          new Map(merged.map((photo) => [photo.id, photo])).values(),
        );
        photoCount.value = result.photoCount;
        nextCursor.value = result.nextCursor;
      },
      onError(caught) {
        const message = formatError(caught, '相册照片加载失败，请稍后重试');
        if (append) appendError.value = message;
        else loadError.value = message;
      },
    },
  );
}

async function step(delta: number) {
  const count = photos.value.length;
  if (!count) return;
  if (delta > 0 && index.value === count - 1 && nextCursor.value) {
    const previousCount = count;
    await loadPhotos(true);
    if (photos.value.length > previousCount) index.value = previousCount;
    return;
  }
  if (count > 1) index.value = (index.value + delta + count) % count;
}

function openPhoto(photoIndex: number) {
  index.value = photoIndex;
  viewingPhoto.value = true;
}

function showThumbnails() {
  viewingPhoto.value = false;
  failed.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (!viewingPhoto.value) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    void step(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    void step(1);
  }
}
</script>

<template>
  <BaseDialog :open="Boolean(album)" :title="album?.title ?? ''" :width="880" @close="emit('close')">
    <template v-if="album">
      <SkeletonBlock v-if="loading && !photos.length" :lines="5" />
      <ErrorState
        v-else-if="loadError"
        :message="loadError"
        retry-label="重试加载相册照片"
        @retry="loadPhotos(false)"
      />
      <EmptyState v-else-if="!photos.length" title="此相册暂无照片" />
      <div v-else-if="!viewingPhoto" class="thumbnail-view">
        <p class="thumbnail-count">已加载 {{ photos.length }} / {{ photoCount }} 张照片</p>
        <div class="thumbnail-grid" aria-label="相册照片缩略图">
          <button
            v-for="(photo, photoIndex) in photos"
            :key="photo.id"
            type="button"
            class="thumbnail-button"
            :aria-label="`放大查看第 ${photoIndex + 1} 张照片${photo.caption ? `：${photo.caption}` : ''}`"
            @click="openPhoto(photoIndex)"
          >
            <span class="thumbnail-image">
              <img
                :src="photo.url"
                :alt="photo.caption || `${album.title} 第 ${photoIndex + 1} 张`"
                loading="lazy"
              />
            </span>
            <span class="thumbnail-meta">
              <span>{{ photo.caption || `第 ${photoIndex + 1} 张` }}</span>
              <small>{{ photoIndex + 1 }} / {{ photoCount }}</small>
            </span>
          </button>
        </div>
        <p v-if="appendError" class="alert error" role="alert">{{ appendError }}</p>
        <button
          v-if="nextCursor"
          ref="loadMoreTrigger"
          type="button"
          class="button ghost load-more"
          :disabled="loading"
          @click="loadPhotos(true)"
        >
          {{ loading ? '正在加载…' : '加载更多照片' }}
        </button>
      </div>
      <div v-else class="lightbox">
        <div class="lightbox-toolbar">
          <button type="button" class="button ghost lightbox-back" @click="showThumbnails">
            <Images :size="16" aria-hidden="true" />
            返回缩略图
          </button>
          <span>{{ index + 1 }} / {{ photoCount }}</span>
        </div>
        <div class="lightbox-stage">
          <div v-if="failed" class="lightbox-failed">
            <ImageOff :size="36" aria-hidden="true" />
            <p>图片加载失败</p>
          </div>
          <img
            v-else-if="current"
            :key="current.id"
            :src="current.url"
            :alt="current.caption || `${album.title} 第 ${index + 1} 张`"
            @error="failed = true"
          />
        </div>
        <div class="lightbox-bar">
          <button
            type="button"
            class="icon-button"
            aria-label="上一张照片"
            :disabled="!canStepPrevious || loading"
            @click="step(-1)"
          >
            <ChevronLeft :size="18" />
          </button>
          <div class="lightbox-caption">
            <p v-if="current?.caption" class="caption-text">{{ current.caption }}</p>
            <span class="caption-count">{{ index + 1 }} / {{ photoCount }}</span>
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label="下一张照片"
            :disabled="!canStepNext || loading"
            @click="step(1)"
          >
            <ChevronRight :size="18" />
          </button>
        </div>
      </div>
    </template>
  </BaseDialog>
</template>

<style scoped>
.lightbox {
  display: grid;
  gap: var(--space-4);
}

.thumbnail-view {
  display: grid;
  gap: var(--space-3);
}

.load-more {
  justify-self: center;
}

.thumbnail-count {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.thumbnail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-4);
}

.thumbnail-button {
  min-width: 0;
  display: grid;
  grid-template-rows: auto 1fr;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  color: var(--ink);
  background: var(--surface);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.16s var(--ease-out),
    box-shadow 0.16s var(--ease-out),
    transform 0.16s var(--ease-out);
}

.thumbnail-button:hover {
  transform: translateY(-2px);
  border-color: var(--accent);
  box-shadow: var(--shadow-m);
}

.thumbnail-image {
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--surface-muted);
}

.thumbnail-image img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  transition: transform 0.2s var(--ease-out);
}

.thumbnail-button:hover .thumbnail-image img {
  transform: scale(1.035);
}

.thumbnail-meta {
  min-width: 0;
  display: grid;
  gap: 2px;
  padding: var(--space-3);
}

.thumbnail-meta > span {
  overflow: hidden;
  color: var(--ink-soft);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thumbnail-meta small,
.lightbox-toolbar > span {
  color: var(--muted);
  font-size: 12px;
}

.lightbox-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.lightbox-back {
  min-height: 38px;
  padding-inline: 16px;
}

.lightbox-stage {
  display: grid;
  place-items: center;
  min-height: 280px;
  max-height: 62vh;
  border-radius: var(--radius-l);
  background: var(--surface-muted);
  overflow: hidden;
}

.lightbox-stage img {
  max-width: 100%;
  max-height: 62vh;
  object-fit: contain;
}

.lightbox-failed {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  padding: var(--space-10);
  color: var(--muted);
}

.lightbox-failed p {
  margin: 0;
}

.lightbox-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.lightbox-caption {
  min-width: 0;
  display: grid;
  justify-items: center;
  gap: 2px;
  text-align: center;
}

.caption-text {
  margin: 0;
  color: var(--ink-soft);
  font-size: 14px;
  overflow-wrap: anywhere;
}

.caption-count {
  color: var(--muted);
  font-size: 13px;
}

@media (max-width: 560px) {
  .thumbnail-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .thumbnail-meta {
    padding: var(--space-2);
  }

  .lightbox-stage,
  .lightbox-stage img {
    max-height: 56vh;
  }
}
</style>
