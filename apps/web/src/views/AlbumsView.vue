<script setup lang="ts">
import { computed, ref } from 'vue';
import PageHeader from '../components/layout/PageHeader.vue';
import EmptyState from '../components/common/EmptyState.vue';
import ErrorState from '../components/common/ErrorState.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import AlbumCard from '../components/album/AlbumCard.vue';
import AlbumLightbox from '../components/album/AlbumLightbox.vue';
import { useAsyncState } from '../composables/useAsyncState';
import { api } from '../lib/api';
import type { AlbumSummary, AlbumSummaryListResponse } from '../types';

// 列表只取摘要（封面+数量），打开相册时再按 ID 加载完整照片
const { data, loading, error, reload } = useAsyncState(async () => {
  const result = await api<AlbumSummaryListResponse>('/albums');
  return result.items;
});
const albums = computed(() => data.value ?? []);

const selected = ref<AlbumSummary | null>(null);

function openAlbum(summary: AlbumSummary) {
  selected.value = summary;
}
</script>

<template>
  <main class="page">
    <PageHeader title="班级相册" description="相册仅向审核通过的班级成员开放。">
      <template #breadcrumb>
        <RouterLink to="/">首页</RouterLink>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">班级相册</span>
      </template>
    </PageHeader>

    <section class="page-content">
      <div v-if="loading" class="album-grid">
        <div v-for="index in 4" :key="index" class="card">
          <SkeletonBlock :lines="3" />
        </div>
      </div>
      <ErrorState v-else-if="error" :message="error" @retry="reload" />
      <EmptyState v-else-if="!albums.length" title="暂无相册" hint="相册创建后会显示在这里" />
      <template v-else>
        <div class="album-grid">
          <AlbumCard v-for="album in albums" :key="album.id" :album="album" @open="openAlbum" />
        </div>
      </template>
    </section>

    <AlbumLightbox :album="selected" @close="selected = null" />
  </main>
</template>

<style scoped>
.album-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-5);
}
</style>
