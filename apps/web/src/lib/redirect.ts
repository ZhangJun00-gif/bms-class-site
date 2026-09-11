/**
 * 登录后重定向目标白名单：只允许站内绝对路径，
 * 拒绝外部 URL 与协议相对路径，防止开放重定向。
 */
export function sanitizeRedirect(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string') return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || decoded.includes('\\')) return fallback;
    const parsed = new URL(value, 'https://class.local');
    if (parsed.origin !== 'https://class.local') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
