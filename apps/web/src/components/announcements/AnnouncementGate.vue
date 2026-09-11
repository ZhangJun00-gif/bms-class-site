<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Check, LoaderCircle, LogOut, RefreshCw } from 'lucide-vue-next';
import BaseDialog from '../common/BaseDialog.vue';
import { useAuthStore } from '../../stores/auth';
import { useAnnouncementsStore } from '../../stores/announcements';
import { formatError } from '../../lib/api';
import { sanitizeRedirect } from '../../lib/redirect';

const auth = useAuthStore();
const notices = useAnnouncementsStore();
const router = useRouter();
const logoutBusy = ref(false);
const logoutError = ref('');
let channel: BroadcastChannel | null = null;
let alive = true;
let verifying = false;
let identity = '';

function broadcast() {
  if (channel) channel.postMessage({ type: 'invalidate' });
  else {
    try { window.localStorage.setItem('bmc3-announcements-invalidate', String(Date.now())); } catch { /* Storage can be unavailable. */ }
  }
}
watch(() => auth.sessionEpoch, () => {
  const nextIdentity = `${auth.user?.id ?? ''}:${auth.user?.role ?? ''}`;
  notices.reset(identity === nextIdentity && auth.sessionChange === 'bootstrap');
  identity = nextIdentity;
  logoutError.value = '';
  if (auth.user) void notices.refresh();
  if (['login', 'logout', 'expired'].includes(auth.sessionChange)) broadcast();
}, { immediate: true });
watch(() => notices.changeEpoch, broadcast);

async function revalidate() {
  if (verifying || !alive || document.visibilityState === 'hidden') return;
  verifying = true;
  try {
    await auth.bootstrap();
    if (!alive) return;
    if (!auth.user && router.currentRoute.value.meta.auth) {
      void router.replace({ path: '/login', query: { redirect: sanitizeRedirect(router.currentRoute.value.fullPath) } });
    }
  } catch (caught) { if (alive) notices.identityFailed(formatError(caught, '无法确认公告状态，请重试')); }
  finally { verifying = false; }
}
function onStorage(event: StorageEvent) { if (event.key === 'bmc3-announcements-invalidate') void revalidate(); }
function onMessage(event: MessageEvent) { if (event.data?.type === 'invalidate') void revalidate(); }
async function logout() {
  if (logoutBusy.value) return;
  logoutBusy.value = true; logoutError.value = '';
  try { await auth.logout(); await router.replace('/login'); }
  catch (caught) { logoutError.value = formatError(caught, '退出失败，请重试'); }
  finally { logoutBusy.value = false; }
}
onMounted(() => {
  if (typeof BroadcastChannel !== 'undefined') { channel = new BroadcastChannel('bmc3-announcements'); channel.addEventListener('message', onMessage); }
  window.addEventListener('focus', revalidate);
  window.addEventListener('storage', onStorage);
});
onBeforeUnmount(() => {
  alive = false; channel?.close();
  window.removeEventListener('focus', revalidate); window.removeEventListener('storage', onStorage);
  notices.reset();
});
</script>

<template>
  <BaseDialog :open="notices.blocked" :title="notices.latest?.title ?? '公告'" :width="680" :dismissable="false" :priority="100">
    <time v-if="notices.latest?.publishedAt" class="announcement-time">{{ new Date(notices.latest.publishedAt).toLocaleString('zh-CN') }}</time>
    <p v-if="notices.loading && !notices.latest" role="status"><LoaderCircle :size="18" class="spin" />正在加载公告…</p>
    <div v-if="notices.latest" class="announcement-body">{{ notices.latest.body }}</div>
    <p v-if="notices.error || logoutError" class="alert error" role="alert">{{ notices.error || logoutError }}</p>
    <template #footer>
      <button type="button" class="button ghost" :disabled="logoutBusy || notices.acknowledging" @click="logout"><LogOut :size="16" />退出登录</button>
      <button v-if="notices.error && !notices.checked" type="button" class="button" :disabled="notices.loading" @click="revalidate"><RefreshCw :size="16" />重试</button>
      <button v-else-if="notices.latest" type="button" class="button acknowledge" :disabled="notices.acknowledging || notices.loading || logoutBusy" @click="notices.acknowledge(notices.latest.id)"><LoaderCircle v-if="notices.acknowledging" :size="17" class="spin" /><Check v-else :size="17" />{{ notices.acknowledging ? '正在确认' : '我已阅读' }}</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.announcement-time { display: block; margin-bottom: 16px; color: var(--muted); font-size: 13px; }
.announcement-body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; }
.spin { animation: spin .8s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) { .acknowledge { flex: 1; } }
</style>
