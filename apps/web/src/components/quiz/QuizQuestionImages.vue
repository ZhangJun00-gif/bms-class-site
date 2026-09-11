<script setup lang="ts">
import { computed, ref } from "vue";
import { ImageOff } from "lucide-vue-next";
import BaseDialog from "../common/BaseDialog.vue";
import type { QuizImage } from "../../types";

const props = withDefaults(
  defineProps<{ images: QuizImage[]; altContext?: string }>(),
  { altContext: "" },
);

const failed = ref<Set<string>>(new Set());
const zoomed = ref<QuizImage | null>(null);

const contextLabel = computed(() => {
  const text = props.altContext.trim();
  if (!text) return "题目";
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
});

function altOf(image: QuizImage, index: number): string {
  const caption = image.caption.trim();
  if (caption) return caption;
  return `${contextLabel.value}配图 ${index + 1}`;
}

function onError(id: string) {
  const next = new Set(failed.value);
  next.add(id);
  failed.value = next;
}
</script>

<template>
  <div v-if="images.length" class="quiz-images">
    <figure v-for="(image, index) in images" :key="image.id" class="quiz-image">
      <div v-if="failed.has(image.id)" class="quiz-image-fallback" role="img" :aria-label="`配图 ${index + 1} 加载失败`">
        <ImageOff :size="20" aria-hidden="true" />
        <span>配图加载失败</span>
      </div>
      <button
        v-else
        type="button"
        class="quiz-image-button"
        :aria-label="`放大查看：${altOf(image, index)}`"
        @click="zoomed = image"
      >
        <img
          :src="image.url"
          :alt="altOf(image, index)"
          loading="lazy"
          @error="onError(image.id)"
        />
      </button>
      <figcaption v-if="image.caption.trim()" class="quiz-image-caption">
        {{ image.caption }}
      </figcaption>
    </figure>
  </div>
  <BaseDialog
    :open="zoomed !== null"
    title="查看配图"
    :width="860"
    @close="zoomed = null"
  >
    <div v-if="zoomed" class="quiz-image-zoom">
      <img :src="zoomed.url" :alt="zoomed.caption.trim() || '题目配图放大视图'" />
      <p v-if="zoomed.caption.trim()" class="quiz-image-caption">
        {{ zoomed.caption }}
      </p>
    </div>
  </BaseDialog>
</template>

<style scoped>
.quiz-images {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.quiz-image {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  max-width: 180px;
}

.quiz-image-button {
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface-muted);
  cursor: zoom-in;
  overflow: hidden;
}

.quiz-image-button img {
  display: block;
  max-width: 178px;
  max-height: 140px;
  width: auto;
  height: auto;
  object-fit: contain;
}

.quiz-image-caption {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.quiz-image-fallback {
  display: grid;
  place-items: center;
  gap: var(--space-1);
  width: 178px;
  height: 120px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-m);
  background: var(--surface-tint);
  color: var(--muted);
  font-size: 12px;
}

.quiz-image-zoom {
  display: grid;
  gap: var(--space-3);
  justify-items: center;
}

.quiz-image-zoom img {
  max-width: 100%;
  max-height: 70vh;
  width: auto;
  height: auto;
  border-radius: var(--radius-m);
}

@media (max-width: 560px) {
  .quiz-image {
    max-width: calc(50% - var(--space-2));
  }

  .quiz-image-button img,
  .quiz-image-fallback {
    width: 100%;
    max-width: 100%;
  }
}
</style>
