<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import SecretDialog from './SecretDialog.vue';
import { useAsyncState } from '../../composables/useAsyncState';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import { api, formatError } from '../../lib/api';
import { formatDate } from '../../lib/formatters';
import {
  accountStatusLabels,
  accountStatusTones,
  roleLabels,
} from '../../lib/labels';
import { useAuthStore } from '../../stores/auth';
import type { ListResponse, Member, Role } from '../../types';

const toast = useToast();
const { confirm } = useConfirm();
const auth = useAuthStore();

const { data, loading, error, reload } = useAsyncState(async () => {
  const result = await api<ListResponse<Member>>('/users');
  return result.items;
});
const members = computed(() => data.value ?? []);
const activeAdminCount = computed(
  () =>
    members.value.filter(
      (member) => member.role === 'ADMIN' && member.status === 'ACTIVE',
    ).length,
);

const busyId = ref('');
const secret = ref<{
  title: string;
  value: string;
  description?: string;
} | null>(null);
const roleDrafts = reactive<Record<string, Role>>({});
const dirtyRoleIds = new Set<string>();

watch(
  members,
  (items) => {
    // 用户改动过但未保存的行保留草稿，其余行跟随服务端刷新
    for (const member of items)
      if (!dirtyRoleIds.has(member.id)) roleDrafts[member.id] = member.role;
  },
  { immediate: true },
);

function markRoleDirty(member: Member) {
  dirtyRoleIds.add(member.id);
}

function isCurrent(member: Member) {
  return member.id === auth.user?.id;
}

function isOnlyActiveAdmin(member: Member) {
  return (
    member.role === 'ADMIN' &&
    member.status === 'ACTIVE' &&
    activeAdminCount.value <= 1
  );
}

async function run(
  member: Member,
  task: () => Promise<unknown>,
  okMessage: string,
) {
  busyId.value = member.id;
  try {
    await task();
    toast.success(okMessage);
    await reload();
  } catch (caught) {
    toast.error(formatError(caught, '操作失败'));
  } finally {
    busyId.value = '';
  }
}

function approve(member: Member) {
  return run(
    member,
    () =>
      api(`/users/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'ACTIVE' }),
      }),
    `已通过 ${member.displayName} 的审核`,
  );
}

async function saveRole(member: Member) {
  const nextRole = roleDrafts[member.id];
  if (!nextRole || nextRole === member.role || busyId.value) return;
  const ok = await confirm({
    title: '变更成员角色',
    body: `将 ${member.displayName} 从“${roleLabels[member.role]}”调整为“${roleLabels[nextRole]}”。权限会在下一次请求时生效。`,
    confirmText: '保存角色',
    danger: member.role === 'ADMIN' || nextRole === 'ADMIN',
  });
  if (!ok) {
    roleDrafts[member.id] = member.role;
    dirtyRoleIds.delete(member.id);
    return;
  }
  busyId.value = member.id;
  try {
    await api(`/users/${member.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: nextRole }),
    });
    dirtyRoleIds.delete(member.id);
    toast.success(`已将 ${member.displayName} 设为${roleLabels[nextRole]}`);
    await reload();
  } catch (caught) {
    roleDrafts[member.id] = member.role;
    dirtyRoleIds.delete(member.id);
    toast.error(formatError(caught, '角色保存失败'));
  } finally {
    busyId.value = '';
  }
}

async function toggleSuspend(member: Member) {
  if (isCurrent(member) && member.status !== 'SUSPENDED') return;
  const suspending = member.status !== 'SUSPENDED';
  const ok = await confirm({
    title: suspending ? '停用账号' : '恢复账号',
    body: suspending
      ? `停用后 ${member.displayName} 的所有会话将失效，无法登录。`
      : `恢复后 ${member.displayName} 可重新登录。`,
    confirmText: suspending ? '停用' : '恢复',
    danger: suspending,
  });
  if (!ok) return;
  await run(
    member,
    () =>
      api(`/users/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: suspending ? 'SUSPENDED' : 'ACTIVE' }),
      }),
    suspending
      ? `已停用 ${member.displayName}`
      : `已恢复 ${member.displayName}`,
  );
}

async function resetPassword(member: Member) {
  if (isCurrent(member)) return;
  const ok = await confirm({
    title: '重置密码',
    body: `将为 ${member.displayName} 生成临时密码，其所有会话立即失效。`,
    confirmText: '重置',
    danger: true,
  });
  if (!ok) return;
  busyId.value = member.id;
  try {
    const result = await api<{ temporaryPassword: string }>(
      `/users/${member.id}/reset-password`,
      { method: 'POST' },
    );
    secret.value = {
      title: '临时密码',
      value: result.temporaryPassword,
      description: `请通过可信渠道将临时密码交给 ${member.displayName}。`,
    };
  } catch (caught) {
    toast.error(formatError(caught, '重置失败'));
  } finally {
    busyId.value = '';
  }
}

/** 一次性结果关闭后立即从响应式状态清除 */
function clearSecret() {
  secret.value = null;
}
</script>

<template>
  <section aria-label="成员管理">
    <SkeletonBlock v-if="loading" :lines="5" />
    <ErrorState v-else-if="error" :message="error" @retry="reload" />
    <EmptyState v-else-if="!members.length" title="暂无成员" />
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">姓名</th>
            <th scope="col">状态</th>
            <th scope="col">角色</th>
            <th scope="col">申请时间</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="member in members" :key="member.id">
            <td data-label="姓名">{{ member.displayName }}</td>
            <td data-label="状态">
              <StatusBadge
                :text="accountStatusLabels[member.status]"
                :tone="accountStatusTones[member.status] as ''"
              />
            </td>
            <td data-label="角色" class="role-cell">
              <select
                v-model="roleDrafts[member.id]"
                class="role-select"
                :aria-label="`调整 ${member.displayName} 的角色`"
                :disabled="
                  busyId === member.id ||
                  isCurrent(member) ||
                  isOnlyActiveAdmin(member)
                "
                @change="markRoleDirty(member)"
              >
                <option value="MEMBER">成员</option>
                <option value="EDITOR">编辑</option>
                <option value="ADMIN">管理员</option>
              </select>
              <button
                v-if="roleDrafts[member.id] !== member.role"
                type="button"
                class="action"
                :disabled="busyId === member.id"
                @click="saveRole(member)"
              >
                保存
              </button>
              <span v-if="isOnlyActiveAdmin(member)" class="safety-note"
                >唯一正常管理员不可降级</span
              >
              <span v-else-if="isCurrent(member)" class="safety-note"
                >当前账号不可修改自身角色</span
              >
            </td>
            <td data-label="申请时间">{{ formatDate(member.createdAt) }}</td>
            <td data-label="操作" class="member-actions">
              <div class="member-action-buttons">
                <button
                  v-if="member.status === 'PENDING'"
                  type="button"
                  class="action"
                  :disabled="busyId === member.id"
                  @click="approve(member)"
                >
                  通过
                </button>
                <button
                  type="button"
                  class="action"
                  :disabled="
                    busyId === member.id ||
                    (isCurrent(member) && member.status !== 'SUSPENDED')
                  "
                  :title="
                    isCurrent(member) && member.status !== 'SUSPENDED'
                      ? '当前登录账号不能停用自己'
                      : undefined
                  "
                  @click="toggleSuspend(member)"
                >
                  {{ member.status === 'SUSPENDED' ? '恢复' : '停用' }}
                </button>
                <button
                  v-if="!isCurrent(member)"
                  type="button"
                  class="action danger"
                  :disabled="busyId === member.id"
                  @click="resetPassword(member)"
                >
                  重置密码
                </button>
              </div>
              <span v-if="isCurrent(member)" class="safety-note"
                >当前账号不可停用或重置密码</span
              >
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
.member-actions {
  min-width: 220px;
}

.member-action-buttons,
.role-cell {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.role-select {
  min-width: 104px;
  min-height: 34px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  padding: 0 28px 0 10px;
  background: var(--surface);
  color: var(--ink);
  font-size: 13px;
}

.role-select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--focus-ring);
}

.safety-note {
  display: block;
  margin-top: var(--space-1);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  white-space: normal;
}

.action {
  border: 0;
  background: none;
  padding: 0;
  color: var(--accent-dark);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.action:hover:not(:disabled) {
  text-decoration: underline;
}

.action.danger {
  color: var(--danger);
}

.action:disabled {
  color: var(--muted);
  cursor: not-allowed;
}

@media (max-width: 560px) {
  .table-wrap {
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

  tbody tr:first-child {
    border-top: 1px solid var(--border);
  }

  td {
    display: grid;
    grid-template-columns: 74px minmax(0, 1fr);
    gap: var(--space-3);
    align-items: start;
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

  .member-actions,
  .role-cell {
    min-width: 0;
  }

  .member-action-buttons,
  .role-cell {
    align-items: flex-start;
  }

  .role-cell,
  .member-actions {
    grid-template-columns: 74px minmax(0, 1fr);
  }

  .role-cell > :not(.safety-note),
  .member-actions > :not(.safety-note) {
    grid-column: 2;
  }

  .role-cell .safety-note,
  .member-actions .safety-note {
    grid-column: 2;
  }
}
</style>
