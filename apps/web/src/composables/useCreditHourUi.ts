import type { CreditHourSubmission } from '@bmc3/contracts';
import { api } from '../lib/api';

export function creditHourStatusLabel(status: CreditHourSubmission['status']) {
  return {
    PENDING_REVIEW: 'AI 审核中',
    PENDING_MANUAL_REVIEW: '待人工审核',
    APPROVED: '已通过',
    REJECTED: '未通过',
    WITHDRAWN: '已撤回',
  }[status];
}

export function validCreditHours(value: number) {
  return Number.isFinite(value) && value >= 0.5 && value <= 1000 && Number.isInteger(value * 2);
}

export async function loadCreditHourPages<T>(path: string, signal?: AbortSignal) {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: { items: T[]; nextCursor: string | null } = await api(
      cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : path,
      { signal },
    );
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('分页游标重复，已停止加载');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { items, nextCursor: null };
}
