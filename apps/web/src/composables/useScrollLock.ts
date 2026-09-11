let lockCount = 0;

/** 引用计数式滚动锁定：多个层叠 UI（导航 + 对话框）不会互相提前解锁 */
export function lockScroll() {
  lockCount += 1;
  document.body.classList.add('scroll-locked');
}

export function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) document.body.classList.remove('scroll-locked');
}
