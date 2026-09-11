<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Ban, RefreshCw } from 'lucide-vue-next';
import SecretDialog from './SecretDialog.vue';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import { api, formatError } from '../../lib/api';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useToast } from '../../composables/useToast';
import { formatDateTime } from '../../lib/formatters';
import type {
  InviteItem,
  InviteListResponse,
  InviteState,
} from '../../types';

const stateLabels: Record<InviteState, string> = {
  ACTIVE: '有效',
  EXPIRED: '已过期',
  EXHAUSTED: '已用尽',
  REVOKED: '已撤销',
};
const stateTones: Record<InviteState, 'success' | 'warning' | 'muted'> = {
  ACTIVE: 'success',
  EXPIRED: 'muted',
  EXHAUSTED: 'warning',
  REVOKED: 'muted',
};

const toast = useToast();
const { confirm } = useConfirm();
const listRequests = useLatestRequest();
const mutations = useLatestRequest();

const label = ref('班级成员');
const maxUses = ref(1);
const expiresAt = ref(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16));
const creating = ref(false);
const createError = ref('');
const secret = ref<{ title: string; value: string; description?: string } | null>(null);

const items = ref<InviteItem[]>([]);
const loaded = ref(false);
const loadError = ref('');
const stateFilter = ref<'ALL' | InviteState>('ALL');
const visibleItems = computed(() =>
  stateFilter.value === 'ALL'
    ? items.value
    : items.value.filter((item) => item.state === stateFilter.value),
);

onMounted(() => void loadInvites());

async function loadInvites() {
  loadError.value = '';
  await listRequests.runLatest(
    ({ signal }) => api<InviteListResponse>('/invites', { signal }),
    {
      commit(result) {
        items.value = result.items;
        loaded.value = true;
      },
      onError(caught) {
        loadError.value = formatError(caught, '邀请码列表加载失败');
      },
    },
  );
}

async function submit() {
  creating.value = true;
  createError.value = '';
  try {
    const data = await api<{
      id: string;
      code: string;
      label: string;
      maxUses: number;
      usedCount: number;
      expiresAt: string;
    }>('/invites', {
      method: 'POST',
      body: JSON.stringify({
        label: label.value,
        maxUses: maxUses.value,
        expiresAt: new Date(expiresAt.value).toISOString(),
      }),
    });
    secret.value = {
      title: '邀请码已生成',
      value: data.code,
      description: `用途「${data.label}」，可用 ${data.maxUses} 次，${formatDateTime(data.expiresAt)} 过期。`,
    };
    void loadInvites();
  } catch (caught) {
    createError.value = formatError(caught, '生成失败，请稍后重试');
  } finally {
    creating.value = false;
  }
}

async function revoke(invite: InviteItem) {
  if (invite.state !== 'ACTIVE') return;
  const accepted = await confirm({
    title: '撤销邀请码',
    body: `撤销后「${invite.label}」将立即无法继续使用，已经注册的账号不受影响。`,
    confirmText: '撤销邀请码',
    danger: true,
  });
  if (!accepted) return;
  await mutations.runBusy(`invite:${invite.id}`, async () => {
    try {
      const updated = await api<InviteItem>(`/invites/${invite.id}/revoke`, {
        method: 'POST',
      });
      const index = items.value.findIndex((item) => item.id === invite.id);
      if (index >= 0) items.value[index] = updated;
      toast.success('邀请码已撤销');
    } catch (caught) {
      toast.error(formatError(caught, '撤销失败，请稍后重试'));
    }
  });
}

function clearSecret() {
  secret.value = null;
  toast.info('邀请码已从界面清除');
}
</script>

<template>
  <section aria-label="邀请码管理" class="invite-section">
    <header class="section-heading">
      <div>
        <h2>邀请码管理</h2>
        <p>明文仅在创建后显示一次，列表不会再次提供邀请码内容。</p>
      </div>
      <button
        type="button"
        class="icon-button"
        title="刷新邀请码"
        aria-label="刷新邀请码"
        :disabled="listRequests.loading.value"
        @click="loadInvites"
      >
        <RefreshCw :size="17" aria-hidden="true" />
      </button>
    </header>

    <form class="form invite-form" @submit.prevent="submit">
      <p v-if="createError" class="alert error" role="alert">{{ createError }}</p>
      <div class="field">
        <label for="invite-label">用途</label>
        <input id="invite-label" v-model="label" required maxlength="120" />
      </div>
      <div class="field">
        <label for="invite-max-uses">可用次数</label>
        <input id="invite-max-uses" v-model.number="maxUses" type="number" min="1" max="500" required />
      </div>
      <div class="field">
        <label for="invite-expires">过期时间</label>
        <input id="invite-expires" v-model="expiresAt" type="datetime-local" required />
      </div>
      <button class="button" type="submit" :disabled="creating">
        {{ creating ? '正在生成…' : '生成邀请码' }}
      </button>
    </form>

    <div class="list-toolbar">
      <div>
        <h3>已创建的邀请码</h3>
        <span>{{ items.length }} 条</span>
      </div>
      <div class="field state-filter">
        <label for="invite-state">状态</label>
        <select id="invite-state" v-model="stateFilter">
          <option value="ALL">全部</option>
          <option value="ACTIVE">有效</option>
          <option value="EXPIRED">已过期</option>
          <option value="EXHAUSTED">已用尽</option>
          <option value="REVOKED">已撤销</option>
        </select>
      </div>
    </div>

    <SkeletonBlock v-if="listRequests.loading.value && !loaded" :lines="5" />
    <ErrorState
      v-else-if="loadError"
      :message="loadError"
      retry-label="重试加载邀请码"
      @retry="loadInvites"
    />
    <EmptyState v-else-if="!visibleItems.length" title="没有符合条件的邀请码" />
    <div v-else class="table-wrap invite-table">
      <table>
        <thead>
          <tr>
            <th scope="col">用途</th>
            <th scope="col">状态</th>
            <th scope="col">使用次数</th>
            <th scope="col">过期时间</th>
            <th scope="col">创建时间</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="invite in visibleItems" :key="invite.id">
            <td data-label="用途">{{ invite.label }}</td>
            <td data-label="状态">
              <StatusBadge :text="stateLabels[invite.state]" :tone="stateTones[invite.state]" />
            </td>
            <td data-label="使用次数">{{ invite.usedCount }} / {{ invite.maxUses }}</td>
            <td data-label="过期时间">{{ formatDateTime(invite.expiresAt) }}</td>
            <td data-label="创建时间">{{ formatDateTime(invite.createdAt) }}</td>
            <td data-label="操作">
              <button
                v-if="invite.state === 'ACTIVE'"
                type="button"
                class="button ghost small danger-text"
                :disabled="mutations.isBusy(`invite:${invite.id}`)"
                @click="revoke(invite)"
              >
                <Ban :size="14" aria-hidden="true" />
                {{ mutations.isBusy(`invite:${invite.id}`) ? '正在撤销…' : '撤销' }}
              </button>
              <span v-else class="muted-text">不可操作</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <SecretDialog
      :open="Boolean(secret)"
      :title="secret?.title ?? ''"
      :value="secret?.value ?? ''"
      :description="secret?.description"
      @close="clearSecret"
    />
  </section>
</template>

<style scoped>
.invite-section {
  display: grid;
  gap: var(--space-6);
}

.section-heading,
.list-toolbar,
.list-toolbar > div:first-child {
  display: flex;
  align-items: center;
}

.section-heading,
.list-toolbar {
  justify-content: space-between;
  gap: var(--space-4);
}

.section-heading {
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.section-heading h2,
.list-toolbar h3 {
  margin: 0;
  font-size: 18px;
}

.section-heading p {
  margin: var(--space-1) 0 0;
  color: var(--muted);
  font-size: 13px;
}

.invite-form {
  grid-template-columns: minmax(180px, 1fr) 140px minmax(210px, 1fr) auto;
  align-items: end;
  padding-bottom: var(--space-6);
  border-bottom: 1px solid var(--border);
}

.invite-form .alert {
  grid-column: 1 / -1;
}

.list-toolbar > div:first-child {
  gap: var(--space-2);
}

.list-toolbar span,
.muted-text {
  color: var(--muted);
  font-size: 13px;
}

.state-filter {
  width: 150px;
}

.danger-text {
  color: var(--danger);
}

@media (max-width: 820px) {
  .invite-form {
    grid-template-columns: 1fr 1fr;
  }

  .invite-table {
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  table,
  tbody {
    display: block;
  }

  thead {
    display: none;
  }

  tbody tr {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-5) 0;
    border-bottom: 1px solid var(--border);
  }

  td {
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    gap: var(--space-3);
    min-width: 0;
    padding: 0;
    border: 0;
    white-space: normal;
  }

  td::before {
    content: attr(data-label);
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }
}

@media (max-width: 600px) {
  .section-heading,
  .list-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .invite-form {
    grid-template-columns: 1fr;
  }

  .state-filter {
    width: 100%;
  }
}
</style>
