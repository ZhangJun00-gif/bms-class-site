/**
 * 班级动态读取助手：摘要分页 + 按需详情。
 * 详情按「可见范围 + ID」做会话内内存缓存；登录状态变化由 auth store 统一
 * clearNewsDetailCache()，管理端写操作成功后必须 invalidateNewsDetail(id)。
 * clear 带有 epoch 计数：清空后在途请求的迟到响应不会重新写入缓存。
 */

import { api } from './api';
import type { NewsItem, NewsPageResponse } from '../types';

/** 公开/成员摘要分页。摘要不含 body，正文由 fetchNewsDetail 按需加载。 */
export function fetchNewsSummaries(
  member: boolean,
  page: number,
  pageSize: number,
): Promise<NewsPageResponse> {
  const base = member ? '/news/members' : '/news';
  return api<NewsPageResponse>(
    `${base}?page=${page}&pageSize=${pageSize}&includeBody=false`,
  );
}

const detailCache = new Map<string, NewsItem>();
let cacheEpoch = 0;

function cacheKey(member: boolean, id: string) {
  return `${member ? 'members' : 'public'}:${id}`;
}

/** 按需加载动态详情；同一会话内重复打开命中内存缓存。 */
export async function fetchNewsDetail(
  member: boolean,
  id: string,
): Promise<NewsItem> {
  const key = cacheKey(member, id);
  const cached = detailCache.get(key);
  if (cached) return cached;
  const epoch = cacheEpoch;
  const item = await api<NewsItem>(`${member ? '/news/members' : '/news'}/${id}`);
  // 登录态变化已清空缓存时，迟到的响应不得重新写入
  if (epoch === cacheEpoch) detailCache.set(key, item);
  return item;
}

/** 管理端创建/更新/归档/恢复/删除成功后调用，避免读者看到旧正文。 */
export function invalidateNewsDetail(id: string) {
  detailCache.delete(cacheKey(true, id));
  detailCache.delete(cacheKey(false, id));
}

/** 登录状态变化时清空全部缓存（由 auth store 统一调用）。 */
export function clearNewsDetailCache() {
  cacheEpoch += 1;
  detailCache.clear();
}
