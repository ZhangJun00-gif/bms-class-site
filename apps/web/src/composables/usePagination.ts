import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';

/** 客户端分页：后端列表暂无分页参数，列表统一在前端分页展示 */
export function usePagination<T>(items: Ref<T[]> | ComputedRef<T[]>, pageSize = 10) {
  const page = ref(1);
  const total = computed(() => items.value.length);
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
  const pageItems = computed(() => {
    const start = (page.value - 1) * pageSize;
    return items.value.slice(start, start + pageSize);
  });

  watch(total, () => {
    if (page.value > pageCount.value) page.value = pageCount.value;
  });

  return { page, pageCount, pageItems, total };
}
