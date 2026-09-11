<script setup lang="ts">
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-vue-next';
import { useToast } from '../../composables/useToast';

const { toasts, dismiss } = useToast();
const icons = { success: CheckCircle2, error: AlertTriangle, info: Info };
</script>

<template>
  <div class="toast-region" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.type">
        <component :is="icons[toast.type]" :size="18" aria-hidden="true" />
        <p>{{ toast.text }}</p>
        <button type="button" class="toast-close" :aria-label="'关闭通知'" @click="dismiss(toast.id)">
          <X :size="16" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-region {
  position: fixed;
  top: calc(var(--header-height) + 12px);
  right: 16px;
  z-index: var(--z-toast);
  display: grid;
  gap: var(--space-2);
  width: min(360px, calc(100vw - 32px));
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 13px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--shadow-m);
  pointer-events: auto;
}

.toast p {
  margin: 0;
  flex: 1;
  font-size: 14px;
  line-height: 1.6;
}

.toast > svg {
  flex: none;
  margin-top: 2px;
}

.toast.success > svg {
  color: var(--success);
}

.toast.error > svg {
  color: var(--danger);
}

.toast.info > svg {
  color: var(--accent-dark);
}

.toast-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
}

.toast-close:hover {
  color: var(--ink);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
