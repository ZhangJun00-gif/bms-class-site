<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ArrowLeft, Check, ChevronDown, LoaderCircle, RefreshCw } from 'lucide-vue-next';
import type { Announcement, AnnouncementPage, AnnouncementSummary } from '@bmc3/contracts';
import PageHeader from '../components/layout/PageHeader.vue';
import EmptyState from '../components/common/EmptyState.vue';
import { ApiClientError, api, formatError } from '../lib/api';
import { useLatestRequest } from '../composables/useLatestRequest';
import { useAuthStore } from '../stores/auth';
import { useAnnouncementsStore } from '../stores/announcements';

const auth = useAuthStore();
const notices = useAnnouncementsStore();
const list = useLatestRequest();
const reader = useLatestRequest();
const items = ref<AnnouncementSummary[]>([]);
const cursor = ref<string | null>(null);
const detail = ref<Announcement | null>(null);
const selectedId = ref('');
const error = ref('');
const detailError = ref('');
const loaded = ref(false);
let listScroll = 0;
let alive = true;
let identity = `${auth.user?.id ?? ''}:${auth.user?.role ?? ''}`;

async function load(append = false) {
  error.value = '';
  const next = append ? cursor.value : null;
  const epoch = auth.sessionEpoch;
  await list.runLatest(({ signal }) => api<AnnouncementPage>(`/announcements?pageSize=20${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, { signal }), {
    commit(result) {
      if (auth.sessionEpoch !== epoch) return;
      items.value = append ? [...items.value, ...result.items] : result.items;
      cursor.value = result.nextCursor; loaded.value = true;
    },
    onError(caught) { error.value = formatError(caught, '公告列表加载失败'); },
  });
}
async function open(id: string) {
  if (!selectedId.value) listScroll = window.scrollY;
  selectedId.value = id; detail.value = null; detailError.value = '';
  const epoch = auth.sessionEpoch;
  await reader.runLatest(({ signal }) => api<Announcement>(`/announcements/${encodeURIComponent(id)}`, { signal }), {
    commit(result) { if (auth.sessionEpoch === epoch) detail.value = result; },
    onError(caught) {
      detailError.value = caught instanceof ApiClientError && caught.status === 404 ? '公告已撤回或不存在' : formatError(caught, '公告加载失败');
      if (caught instanceof ApiClientError && caught.status === 404) void load();
    },
  });
}
function back() {
  reader.cancelLatest(); selectedId.value = ''; detail.value = null;
  requestAnimationFrame(() => window.scrollTo({ top: listScroll }));
}
async function acknowledge() {
  const id = detail.value?.id;
  if (!id) return;
  const epoch = auth.sessionEpoch;
  const generation = reader.generation.value;
  const owns = () => alive && auth.sessionEpoch === epoch && selectedId.value === id && reader.generation.value === generation;
  const success = await notices.acknowledge(id);
  if (!owns()) return;
  if (success) {
    await open(id);
    if (detail.value?.id === id) {
      items.value = items.value.map((item) => item.id === id ? { ...item, readAt: detail.value!.readAt } : item);
    }
  } else {
    detailError.value = notices.error;
    if (!detailError.value) await open(id);
  }
}
watch(() => auth.sessionEpoch, () => {
  const nextIdentity = `${auth.user?.id ?? ''}:${auth.user?.role ?? ''}`;
  const preserveSelection = Boolean(auth.user) && identity === nextIdentity && auth.sessionChange === 'bootstrap';
  identity = nextIdentity;
  list.cancelLatest(); reader.cancelLatest(); error.value = ''; detailError.value = '';
  if (!preserveSelection) {
    selectedId.value = ''; detail.value = null; items.value = []; cursor.value = null; loaded.value = false;
  }
  if (auth.user) {
    void load();
    if (preserveSelection && selectedId.value) void open(selectedId.value);
  }
});
onMounted(() => void load());
onBeforeUnmount(() => { alive = false; });
</script>

<template>
  <main class="page">
    <PageHeader title="公告"><template #breadcrumb><RouterLink to="/">首页</RouterLink><span> / </span><span aria-current="page">公告</span></template></PageHeader>
    <section class="page-content announcements">
      <template v-if="selectedId">
        <button type="button" class="button ghost" @click="back"><ArrowLeft :size="16" />返回公告列表</button>
        <p v-if="reader.loading.value" role="status">正在加载公告…</p>
        <p v-if="detailError" class="alert error" role="alert">{{ detailError }}<button type="button" class="button secondary" @click="open(selectedId)">重试</button></p>
        <article v-if="detail" class="announcement-reader"><h2>{{ detail.title }}</h2><time>{{ detail.publishedAt ? new Date(detail.publishedAt).toLocaleString('zh-CN') : '' }}</time><div class="announcement-body">{{ detail.body }}</div><p v-if="detail.readAt" class="read-state">已确认阅读</p><button v-else type="button" class="button" :disabled="notices.acknowledging" @click="acknowledge"><LoaderCircle v-if="notices.acknowledging" :size="17" /><Check v-else :size="17" />我已阅读</button></article>
      </template>
      <template v-else>
        <p v-if="error" class="alert error" role="alert">{{ error }}<button type="button" class="button secondary" @click="load()"><RefreshCw :size="16" />重试</button></p>
        <p v-if="list.loading.value && !loaded" role="status">正在加载公告…</p>
        <EmptyState v-else-if="loaded && !items.length" title="暂无公告" />
        <ul v-else class="announcement-list"><li v-for="item in items" :key="item.id"><button type="button" @click="open(item.id)"><strong>{{ item.title }}</strong><span>{{ item.publishedAt ? new Date(item.publishedAt).toLocaleString('zh-CN') : '' }} · {{ item.readAt ? '已确认' : '未确认' }}</span></button></li></ul>
        <button v-if="cursor" type="button" class="button secondary" :disabled="list.loading.value" @click="load(true)"><ChevronDown :size="16" />更多公告</button>
      </template>
    </section>
  </main>
</template>

<style scoped>
.announcements { max-width: 900px; width: 100%; box-sizing: border-box; }
.announcement-list { list-style: none; padding: 0; margin: 0 0 18px; }
.announcement-list li { border-bottom: 1px solid var(--border); }
.announcement-list button { display: grid; gap: 8px; width: 100%; padding: 18px 0; text-align: left; background: none; border: 0; color: var(--ink); cursor: pointer; }
.announcement-list strong, h2 { overflow-wrap: anywhere; }
.announcement-list span, time, .read-state { color: var(--muted); font-size: 13px; }
.announcement-reader { padding: 20px 0; }.announcement-reader h2 { font-size: 22px; }
.announcement-body { margin: 24px 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; }
</style>
