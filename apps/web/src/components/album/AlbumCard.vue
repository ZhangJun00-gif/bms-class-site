<script setup lang="ts">
import { ref } from 'vue';
import { Image as ImageIcon } from 'lucide-vue-next';
import type { AlbumSummary } from '../../types';

defineProps<{ album: AlbumSummary }>();
const emit = defineEmits<{ open: [album: AlbumSummary] }>();

const coverFailed = ref(false);
</script>

<template>
  <button type="button" class="album-card" @click="emit('open', album)">
    <span class="album-cover">
      <img
        v-if="album.coverUrl && !coverFailed"
        :src="album.coverUrl"
        :alt="album.title"
        loading="lazy"
        @error="coverFailed = true"
      />
      <ImageIcon v-else :size="36" aria-hidden="true" />
    </span>
    <span class="album-info">
      <span class="album-title">{{ album.title }}</span>
      <span v-if="album.description" class="album-desc clamp-2">{{ album.description }}</span>
      <span class="album-count">{{ album.photoCount }} 张照片</span>
    </span>
  </button>
</template>

<style scoped>
.album-card {
  display: grid;
  grid-template-rows: auto 1fr;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-s);
  overflow: hidden;
  text-align: left;
  cursor: pointer;
  transition: transform 0.2s var(--ease-out), box-shadow 0.2s var(--ease-out), border-color 0.2s var(--ease-out);
}

.album-card:hover {
  transform: translateY(-3px);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-lift);
}

.album-cover {
  aspect-ratio: 4 / 3;
  display: grid;
  place-items: center;
  background: linear-gradient(150deg, var(--primary-soft), var(--accent-soft));
  color: var(--muted);
  overflow: hidden;
}

.album-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.35s var(--ease-out);
}

.album-card:hover .album-cover img {
  transform: scale(1.04);
}

.album-info {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-4);
}

.album-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--primary-dark);
  overflow-wrap: anywhere;
}

.album-desc {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.album-count {
  margin-top: var(--space-1);
  color: var(--muted);
  font-size: 13px;
}
</style>
