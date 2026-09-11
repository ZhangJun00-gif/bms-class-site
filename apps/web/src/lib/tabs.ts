/**
 * WAI-ARIA tabs 键盘导航：根据按键计算下一个应激活的 tab 下标。
 * 返回 null 表示按键不属于 tabs 导航键。
 */
export function nextTabIndex(
  current: number,
  length: number,
  key: string,
): number | null {
  if (length <= 0) return null;
  if (key === 'ArrowRight') return (current + 1) % length;
  if (key === 'ArrowLeft') return (current - 1 + length) % length;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return null;
}
