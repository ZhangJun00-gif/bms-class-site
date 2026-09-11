const sensitiveKey =
  /password|token|session|student|cipher|encrypted|hash|cookie|authorization|secret|credential/i;

function concise(value: unknown, depth: number): string {
  if (value === null) return '空';
  if (typeof value === 'string')
    return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (depth >= 2) return '…';
  if (Array.isArray(value))
    return value
      .slice(0, 5)
      .map((item) => concise(item, depth + 1))
      .join('、');
  if (typeof value !== 'object') return '';

  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !sensitiveKey.test(key))
    .slice(0, 8)
    .map(([key, item]) => `${key}: ${concise(item, depth + 1)}`)
    .filter((item) => !item.endsWith(': '))
    .join('；');
}

export function summarizeAuditMetadata(metadata: unknown): string {
  const summary = concise(metadata, 0).trim();
  return summary || '无附加信息';
}

const actionLabels: Record<string, string> = {
  'auth.register': '提交账号申请',
  'auth.login': '登录',
  'auth.logout': '退出登录',
  'auth.password.change': '修改密码',
  'user.update': '更新成员',
  'user.password.reset': '重置成员密码',
  'invite.create': '创建邀请码',
  'invite.revoke': '撤销邀请码',
  'news.create': '创建动态',
  'news.update': '更新动态',
  'news.archive': '归档动态',
  'news.restore': '恢复动态',
  'news.delete': '删除动态',
  'news.image.upload': '上传动态图片',
  'album.create': '创建相册',
  'album.rename': '重命名相册',
  'album.archive': '归档相册',
  'album.restore': '恢复相册',
  'photo.upload': '上传相册图片',
  'album.photo.remove': '移除相册图片',
  'forum.report.resolve': '处理论坛举报',
  'forum.thread.moderate': '审核论坛主题',
  'ai.conversation.delete': '删除 AI 会话',
};

export function auditActionLabel(action: string): string {
  return actionLabels[action] ?? action;
}
