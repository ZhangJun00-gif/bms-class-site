import { reactive } from 'vue';

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmState extends Required<Omit<ConfirmOptions, 'body' | 'resolve'>> {
  open: boolean;
  body: string;
  resolve: ((ok: boolean) => void) | null;
}

const state = reactive<ConfirmState>({
  open: false,
  title: '',
  body: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
  resolve: null,
});

function settle(ok: boolean) {
  state.open = false;
  state.resolve?.(ok);
  state.resolve = null;
}

/** 全局确认对话框。confirm() 返回 Promise<boolean>。 */
export function useConfirm() {
  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      state.title = options.title;
      state.body = options.body ?? '';
      state.confirmText = options.confirmText ?? '确定';
      state.cancelText = options.cancelText ?? '取消';
      state.danger = options.danger ?? false;
      state.resolve = resolve;
      state.open = true;
    });
  }

  return { state, confirm, settle };
}
