<script setup lang="ts">
import { ref, watch } from 'vue';
import BaseDialog from '../common/BaseDialog.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import { fetchNewsDetail } from '../../lib/news';
import { formatError } from '../../lib/api';
import { formatDateTime } from '../../lib/formatters';
import { useAuthStore } from '../../stores/auth';
import type { NewsItem, NewsSummary } from '../../types';

const props = defineProps<{ item: NewsSummary | null }>();
const emit = defineEmits<{ close: [] }>();

const auth = useAuthStore();
const detail = ref<NewsItem | null>(null);
const loading = ref(false);
const loadError = ref('');
let requestId = 0;

async function load(id: string) {
  const current = ++requestId;
  loading.value = true;
  loadError.value = '';
  try {
    const result = await fetchNewsDetail(auth.isAuthenticated, id);
    if (current === requestId) detail.value = result;
  } catch (caught) {
    if (current === requestId)
      loadError.value = formatError(caught, '正文加载失败，请稍后重试');
  } finally {
    if (current === requestId) loading.value = false;
  }
}

watch(
  () => props.item?.id,
  (id) => {
    // 关闭或切换时先清空，绝不能展示上一条的正文
    detail.value = null;
    loadError.value = '';
    if (!id) {
      requestId += 1;
      loading.value = false;
      return;
    }
    void load(id);
  },
  { immediate: true },
);

function retry() {
  const id = props.item?.id;
  if (!id || loading.value) return;
  detail.value = null;
  void load(id);
}
</script>

<template>
  <BaseDialog
    :open="Boolean(item)"
    :title="item?.title ?? ''"
    :width="800"
    @close="emit('close')"
  >
    <template v-if="item">
      <div class="detail-meta meta">
        <span>{{ item.author.displayName }}</span>
        <time :datetime="item.publishedAt ?? undefined">{{
          formatDateTime(item.publishedAt)
        }}</time>
        <StatusBadge
          v-if="item.visibility === 'MEMBERS'"
          text="成员可见"
          tone="accent"
        />
      </div>
      <div v-if="loading" role="status" aria-label="正文加载中">
        <SkeletonBlock :lines="5" />
      </div>
      <ErrorState
        v-else-if="loadError"
        :message="loadError"
        retry-label="重试加载正文"
        @retry="retry"
      />
      <!-- 正文由后端 sanitize-html 清洗，允许保留基本排版标签 -->
      <div
        v-else-if="detail"
        class="rich-text detail-body"
        v-html="detail.body"
      />
    </template>
  </BaseDialog>
</template>

<style scoped>
.detail-meta {
  padding-bottom: var(--space-4);
  margin-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.detail-body {
  overflow-wrap: anywhere;
  overflow-x: auto;
}
</style>
