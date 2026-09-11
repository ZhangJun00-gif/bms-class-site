import {
  computed,
  onMounted,
  onUnmounted,
  ref,
  toValue,
  type MaybeRefOrGetter,
} from 'vue';

/** Combines a retained pane's active state with browser document visibility. */
export function usePaneVisibility(active: MaybeRefOrGetter<boolean>) {
  const documentVisible = ref(
    typeof document === 'undefined' || document.visibilityState === 'visible',
  );

  function syncDocumentVisibility() {
    documentVisible.value = document.visibilityState === 'visible';
  }

  onMounted(() =>
    document.addEventListener('visibilitychange', syncDocumentVisibility),
  );
  onUnmounted(() =>
    document.removeEventListener('visibilitychange', syncDocumentVisibility),
  );

  return computed(() => Boolean(toValue(active)) && documentVisible.value);
}
