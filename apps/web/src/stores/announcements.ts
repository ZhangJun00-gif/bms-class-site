import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Announcement, AnnouncementStatusResponse } from '@bmc3/contracts';
import { ApiClientError, api, formatError, isAbortError } from '../lib/api';
import { useAuthStore } from './auth';

export const useAnnouncementsStore = defineStore('announcements', () => {
  const auth = useAuthStore();
  const latest = ref<Announcement | null>(null);
  const checked = ref(false);
  const loading = ref(false);
  const error = ref('');
  const acknowledging = ref(false);
  const changeEpoch = ref(0);
  let generation = 0;
  let controller: AbortController | null = null;
  let readController: AbortController | null = null;
  const unread = computed(() => Boolean(latest.value && !latest.value.readAt));
  const blocked = computed(() => auth.isAuthenticated && (unread.value || (!checked.value && Boolean(error.value))));

  function reset(preserveStatus = false) {
    generation += 1;
    controller?.abort(); readController?.abort();
    controller = null; readController = null;
    if (!preserveStatus) { latest.value = null; checked.value = false; error.value = ''; }
    loading.value = false; acknowledging.value = false;
  }
  function identityFailed(message: string) {
    reset();
    error.value = message;
  }
  async function refresh() {
    if (!auth.user) { reset(); return; }
    controller?.abort();
    const current = ++generation;
    const epoch = auth.sessionEpoch;
    const userId = auth.user.id;
    const request = new AbortController();
    controller = request;
    loading.value = true;
    const owns = () => generation === current && auth.sessionEpoch === epoch && auth.user?.id === userId && !request.signal.aborted;
    try {
      const response = await api<AnnouncementStatusResponse>('/announcements/status', { signal: request.signal });
      if (!owns()) return;
      latest.value = response.latest;
      checked.value = true;
      error.value = '';
    } catch (caught) {
      if (!owns() || isAbortError(caught)) return;
      checked.value = false;
      error.value = formatError(caught, '公告加载失败，请重试');
    } finally { if (owns()) loading.value = false; }
  }
  async function acknowledge(id: string) {
    if (!auth.user || acknowledging.value) return false;
    const epoch = auth.sessionEpoch;
    const userId = auth.user.id;
    const request = new AbortController();
    readController = request;
    acknowledging.value = true; error.value = '';
    const owns = () => auth.sessionEpoch === epoch && auth.user?.id === userId && !request.signal.aborted;
    try {
      await api<{ id: string; readAt: string }>(`/announcements/${encodeURIComponent(id)}/read`, { method: 'POST', signal: request.signal });
      if (!owns()) return false;
      changeEpoch.value += 1;
      await refresh();
      return owns();
    } catch (caught) {
      if (!owns() || isAbortError(caught)) return false;
      if (caught instanceof ApiClientError && caught.status === 404) await refresh();
      else error.value = formatError(caught, '确认失败，请重试');
      return false;
    } finally { if (owns()) acknowledging.value = false; }
  }
  return { latest, checked, loading, error, acknowledging, changeEpoch, unread, blocked, reset, identityFailed, refresh, acknowledge };
});
