<script lang="ts">
// 模块级对话框栈：层叠对话框时只有栈顶响应 ESC
// （多个实例都在 document 上监听 keydown，stopPropagation 无法阻止同节点的其他监听器）
const dialogStack: Array<{ id: symbol; priority: number; overlay: HTMLElement | null }> = [];
const previousInert = new Map<HTMLElement, boolean>();
let bodyObserver: MutationObserver | null = null;

function topDialog() {
  return dialogStack.reduce<(typeof dialogStack)[number] | undefined>((top, item) => !top || item.priority >= top.priority ? item : top, undefined);
}
function syncInert() {
  for (const [element, inert] of previousInert) element.toggleAttribute('inert', inert);
  previousInert.clear();
  const top = topDialog();
  if (!top?.overlay) return;
  for (const element of Array.from(document.body.children)) {
    if (!(element instanceof HTMLElement) || element === top.overlay) continue;
    previousInert.set(element, element.hasAttribute('inert'));
    element.setAttribute('inert', '');
  }
}

function removeFromStack(id: symbol) {
  const index = dialogStack.findIndex((item) => item.id === id);
  if (index !== -1) dialogStack.splice(index, 1);
  syncInert();
  if (!dialogStack.length) { bodyObserver?.disconnect(); bodyObserver = null; }
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { lockScroll, unlockScroll } from '../../composables/useScrollLock';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** 面板最大宽度（px） */
    width?: number;
    /** 是否允许 Escape / 遮罩点击关闭（加载中或一次性结果可禁用） */
    dismissable?: boolean;
    priority?: number;
  }>(),
  { width: 560, dismissable: true, priority: 0 },
);
const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement>();
const overlay = ref<HTMLElement>();
let locked = false;
let trigger: HTMLElement | null = null;
// 标题 id 供 aria-labelledby 关联对话框与标题
const titleId = useId();
const dialogId = Symbol('BaseDialog');
let openGeneration = 0;

watch(
  () => props.open,
  async (open) => {
    const generation = ++openGeneration;
    if (open) {
      trigger =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      lockScroll();
      locked = true;
      const entry = { id: dialogId, priority: props.priority, overlay: null as HTMLElement | null };
      dialogStack.push(entry);
      await nextTick();
      if (!props.open || generation !== openGeneration) return;
      entry.overlay = overlay.value ?? null;
      syncInert();
      if (!bodyObserver) {
        bodyObserver = new MutationObserver(syncInert);
        bodyObserver.observe(document.body, { childList: true });
      }
      if (topDialog()?.id === dialogId) panel.value?.focus();
      document.addEventListener('keydown', onKeydown, true);
      document.addEventListener('focusin', onFocusIn, true);
    } else {
      release();
    }
  },
  { immediate: true },
);

onBeforeUnmount(release);

function release() {
  openGeneration += 1;
  if (locked) {
    unlockScroll();
    locked = false;
  }
  removeFromStack(dialogId);
  document.removeEventListener('keydown', onKeydown, true);
  document.removeEventListener('focusin', onFocusIn, true);
  restoreFocus();
}

/** 焦点还给仍在文档中的触发元素（可能已被列表刷新移除） */
function restoreFocus() {
  const target = trigger;
  trigger = null;
  if (target && document.contains(target)) target.focus();
}

function onKeydown(event: KeyboardEvent) {
  if (topDialog()?.id !== dialogId) return;
  if (event.key === 'Escape') {
    // 层叠时只关闭栈顶对话框
    event.stopPropagation();
    event.preventDefault();
    if (props.dismissable) {
      event.stopPropagation();
      emit('close');
    }
    return;
  }
  if (event.key === 'Tab') trapFocus(event);
}

function onFocusIn(event: FocusEvent) {
  if (topDialog()?.id === dialogId && panel.value && !panel.value.contains(event.target as Node)) panel.value.focus();
}

function trapFocus(event: KeyboardEvent) {
  const root = panel.value;
  if (!root) return;
  const focusables = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null || element === document.activeElement);
  if (!focusables.length) { event.preventDefault(); root.focus(); return; }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="overlay" class="dialog-overlay" :style="{ zIndex: `calc(var(--z-dialog) + ${priority})` }" @mousedown.self="dismissable && topDialog()?.id === dialogId && emit('close')">
      <div
        ref="panel"
        class="dialog-panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        :style="{ maxWidth: `${width}px` }"
      >
        <header class="dialog-header">
          <h2 :id="titleId">{{ title }}</h2>
          <button v-if="dismissable" type="button" class="icon-button small" aria-label="关闭对话框" @click="emit('close')">
            <X :size="18" />
          </button>
        </header>
        <div class="dialog-body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="dialog-footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(13, 23, 55, 0.48);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.dialog-panel {
  width: 100%;
  max-height: calc(100vh - 48px);
  max-height: calc(100dvh - 48px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-lift);
  outline: none;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 20px 24px 0;
}

.dialog-header h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.dialog-body {
  min-height: 0;
  padding: 16px 24px 24px;
  overflow-y: auto;
}

.dialog-footer {
  flex-shrink: 0;
  flex-wrap: wrap;
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: 0 24px 22px;
}

@media (max-width: 560px) {
  .dialog-overlay {
    padding: 12px;
    align-items: flex-end;
  }

  .dialog-panel {
    max-height: calc(100vh - 24px);
    max-height: calc(100dvh - 24px - env(safe-area-inset-bottom));
  }
}
</style>
