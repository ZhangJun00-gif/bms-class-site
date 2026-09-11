<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { PauseCircle, PlayCircle, RefreshCw, XCircle } from 'lucide-vue-next';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import {
  cancelServicePause,
  createServicePause,
  getDailySettings,
  getServicePauses,
  updateDailySettings,
} from '../../lib/dailyPractice';
import { formatError } from '../../lib/api';
import { formatDateTime } from '../../lib/formatters';
import type {
  DailyPracticeServicePause,
  DailyPracticeSettingsResponse,
} from '../../types';

const { confirm } = useConfirm();
const toast = useToast();
const settings = ref<DailyPracticeSettingsResponse | null>(null);
const pauses = ref<DailyPracticeServicePause[]>([]);
const loading = ref(false);
const error = ref('');
const busy = ref(false);
const reason = ref('');
const startsAt = ref('');
const endsAt = ref('');
const pauseReason = ref('');

function shanghaiDateTime(value: string) {
  return new Date(`${value.length === 16 ? `${value}:00` : value}+08:00`);
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [settingsResult, pauseResult] = await Promise.all([
      getDailySettings(),
      getServicePauses(),
    ]);
    settings.value = settingsResult;
    pauses.value = pauseResult.items;
  } catch (caught) {
    error.value = formatError(caught, '服务状态加载失败');
  } finally {
    loading.value = false;
  }
}

async function toggleService(event?: Event) {
  const current = settings.value;
  const message = reason.value.trim();
  if (!current || busy.value) return;
  if (event?.currentTarget instanceof HTMLInputElement)
    event.currentTarget.checked = current.enabled;
  if (!message) {
    toast.error('请填写本次服务调整原因');
    return;
  }
  const enabled = !current.enabled;
  const ok = await confirm({
    title: enabled ? '恢复每日一练' : '暂停每日一练',
    body: enabled
      ? '打开总开关后，如当前仍处于预约停服时段，服务会继续保持暂停。'
      : '关闭后不会创建新计划或调用模型，已经开始的答题仍可提交。',
    confirmText: enabled ? '恢复服务' : '立即暂停',
    danger: !enabled,
  });
  if (!ok) return;
  busy.value = true;
  try {
    settings.value = await updateDailySettings({
      enabled,
      expectedRevision: current.revision,
      reason: message,
    });
    reason.value = '';
    toast.success(enabled ? '总开关已打开' : '每日一练已暂停');
  } catch (caught) {
    toast.error(formatError(caught, '服务状态更新失败'));
    await load();
  } finally {
    busy.value = false;
  }
}

async function schedulePause() {
  if (busy.value) return;
  const message = pauseReason.value.trim();
  const start = shanghaiDateTime(startsAt.value);
  const end = shanghaiDateTime(endsAt.value);
  if (!startsAt.value || !endsAt.value || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    toast.error('请填写完整的停服开始和恢复时间');
    return;
  }
  if (end <= start) {
    toast.error('恢复时间必须晚于停服开始时间');
    return;
  }
  if (!message) {
    toast.error('请填写停服原因');
    return;
  }
  const ok = await confirm({
    title: '预约停服时段',
    body: `服务将在 ${startsAt.value} 至 ${endsAt.value}（Asia/Shanghai）暂停；已经开始的答题仍可提交。`,
    confirmText: '确认预约',
  });
  if (!ok) return;
  busy.value = true;
  try {
    await createServicePause({
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      reason: message,
    });
    startsAt.value = '';
    endsAt.value = '';
    pauseReason.value = '';
    toast.success('停服时段已预约');
    await load();
  } catch (caught) {
    toast.error(formatError(caught, '停服时段创建失败'));
  } finally {
    busy.value = false;
  }
}

async function cancelPause(item: DailyPracticeServicePause) {
  if (busy.value || item.cancelledAt) return;
  const ok = await confirm({
    title: new Date(item.startsAt) <= new Date() ? '提前恢复服务' : '取消预约停服',
    body: `停服原因：${item.reason}`,
    confirmText: new Date(item.startsAt) <= new Date() ? '提前恢复' : '取消预约',
  });
  if (!ok) return;
  busy.value = true;
  try {
    await cancelServicePause(item.id);
    toast.success('停服记录已取消');
    await load();
  } catch (caught) {
    toast.error(formatError(caught, '取消停服失败'));
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section class="service-section" aria-labelledby="daily-service-title">
    <header class="section-heading">
      <div>
        <p class="section-kicker">服务控制</p>
        <h3 id="daily-service-title">每日一练开放状态</h3>
      </div>
      <button
        type="button"
        class="icon-button"
        title="刷新服务状态"
        aria-label="刷新服务状态"
        :disabled="loading"
        @click="load"
      >
        <RefreshCw :size="16" aria-hidden="true" />
      </button>
    </header>
    <SkeletonBlock v-if="loading && !settings" :lines="4" />
    <ErrorState v-else-if="error && !settings" :message="error" @retry="load" />
    <template v-else-if="settings">
      <div class="service-control">
        <div class="service-state">
          <StatusBadge
            :text="settings.effective.paused ? '当前暂停' : settings.effective.enabled ? '服务开放' : '总开关关闭'"
            :tone="settings.effective.paused || !settings.enabled ? 'warning' : 'success'"
          />
          <p>
            <template v-if="settings.effective.reason">{{ settings.effective.reason }}</template>
            <template v-else>每日一练按 Asia/Shanghai 04:00 更新。</template>
          </p>
          <small v-if="settings.effective.resumesAt">
            预计 {{ formatDateTime(settings.effective.resumesAt) }} 恢复
          </small>
        </div>
        <label class="service-toggle">
          <input
            type="checkbox"
            role="switch"
            :checked="settings.enabled"
            :disabled="busy"
            @change="toggleService"
          />
          <span aria-hidden="true" />
          总开关
        </label>
      </div>
      <div class="service-action-row">
        <div class="field service-reason">
          <label for="daily-service-reason">调整原因</label>
          <input
            id="daily-service-reason"
            v-model="reason"
            maxlength="200"
            placeholder="例如：暑假暂停服务"
          />
        </div>
        <button
          type="button"
          class="button"
          :class="{ danger: settings.enabled }"
          :disabled="busy"
          @click="toggleService"
        >
          <PauseCircle v-if="settings.enabled" :size="17" aria-hidden="true" />
          <PlayCircle v-else :size="17" aria-hidden="true" />
          {{ settings.enabled ? '立即暂停' : '恢复服务' }}
        </button>
      </div>
    </template>

    <form class="pause-form" @submit.prevent="schedulePause">
      <div class="field">
        <label for="pause-start">停服开始（Asia/Shanghai）</label>
        <input id="pause-start" v-model="startsAt" type="datetime-local" required />
      </div>
      <div class="field">
        <label for="pause-end">恢复时间（Asia/Shanghai）</label>
        <input id="pause-end" v-model="endsAt" type="datetime-local" required />
      </div>
      <div class="field pause-reason">
        <label for="pause-reason">停服原因</label>
        <input id="pause-reason" v-model="pauseReason" maxlength="200" required />
      </div>
      <button type="submit" class="button secondary" :disabled="busy">
        预约停服
      </button>
    </form>

    <div v-if="pauses.length" class="pause-list-wrap">
      <h4>停服安排</h4>
      <ul class="pause-list">
        <li v-for="item in pauses" :key="item.id">
          <div>
            <strong>{{ formatDateTime(item.startsAt) }} - {{ formatDateTime(item.endsAt) }}</strong>
            <p>{{ item.reason }}</p>
          </div>
          <StatusBadge v-if="item.cancelledAt" text="已取消" tone="muted" />
          <button
            v-else
            type="button"
            class="icon-button small"
            title="取消停服或提前恢复"
            aria-label="取消停服或提前恢复"
            :disabled="busy"
            @click="cancelPause(item)"
          >
            <XCircle :size="16" aria-hidden="true" />
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.service-section {
  display: grid;
  gap: var(--space-5);
}

.section-heading,
.service-control,
.service-action-row,
.pause-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.section-heading h3,
.section-kicker,
.service-state p,
.pause-list-wrap h4,
.pause-list,
.pause-list p {
  margin: 0;
}

.section-heading h3 {
  margin-top: 3px;
  font-size: 18px;
}

.section-kicker {
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
}

.service-control {
  padding-block: var(--space-4);
  border-block: 1px solid var(--border);
}

.service-state {
  min-width: 0;
  display: grid;
  gap: var(--space-2);
}

.service-state p,
.service-state small {
  color: var(--muted);
  line-height: 1.5;
}

.service-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-soft);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.service-toggle input {
  position: absolute;
  opacity: 0;
}

.service-toggle span {
  position: relative;
  width: 46px;
  height: 26px;
  border-radius: var(--radius-pill);
  background: var(--surface-muted);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.service-toggle span::after {
  content: '';
  position: absolute;
  top: 4px;
  left: 4px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-s);
  transition: transform 0.18s var(--ease-out);
}

.service-toggle input:checked + span {
  background: var(--accent);
}

.service-toggle input:checked + span::after {
  transform: translateX(20px);
}

.service-toggle input:focus-visible + span {
  box-shadow: var(--focus-ring);
}

.service-reason {
  flex: 1;
}

.pause-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: end;
  gap: var(--space-3);
  padding-top: var(--space-5);
  border-top: 1px solid var(--border);
}

.pause-reason {
  grid-column: 1 / -1;
}

.pause-form .button {
  justify-self: start;
}

.pause-list-wrap {
  display: grid;
  gap: var(--space-3);
}

.pause-list {
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border);
}

.pause-list li {
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}

.pause-list li > div {
  min-width: 0;
}

.pause-list strong,
.pause-list p {
  overflow-wrap: anywhere;
}

.pause-list strong {
  font-size: 13px;
}

.pause-list p {
  margin-top: 3px;
  color: var(--muted);
  font-size: 13px;
}

@media (max-width: 700px) {
  .service-action-row,
  .pause-form {
    grid-template-columns: 1fr;
  }

  .service-action-row {
    align-items: stretch;
    flex-direction: column;
  }

  .pause-reason {
    grid-column: 1;
  }
}

@media (max-width: 560px) {
  .service-control,
  .pause-list li {
    align-items: flex-start;
    flex-direction: column;
  }

  .service-action-row .button,
  .pause-form .button {
    width: 100%;
  }
}
</style>
