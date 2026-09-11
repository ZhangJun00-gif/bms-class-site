import { reactive } from 'vue';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  type: ToastType;
  text: string;
}

const toasts = reactive<Toast[]>([]);
let nextId = 1;

function dismiss(id: number) {
  const index = toasts.findIndex((toast) => toast.id === id);
  if (index >= 0) toasts.splice(index, 1);
}

function push(type: ToastType, text: string, duration: number) {
  const id = nextId++;
  toasts.push({ id, type, text });
  if (duration > 0) window.setTimeout(() => dismiss(id), duration);
}

export function useToast() {
  return {
    toasts,
    dismiss,
    success: (text: string) => push('success', text, 4000),
    error: (text: string) => push('error', text, 6500),
    info: (text: string) => push('info', text, 4000),
  };
}
