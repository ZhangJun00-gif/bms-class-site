import { defineComponent, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePaneVisibility } from './usePaneVisibility';

describe('usePaneVisibility', () => {
  afterEach(() => vi.restoreAllMocks());

  it('combines retained pane activity with document visibility', async () => {
    const active = ref(true);
    let visible!: ReturnType<typeof usePaneVisibility>;
    const wrapper = mount(defineComponent({
      setup() {
        visible = usePaneVisibility(active);
        return () => null;
      },
    }));

    expect(visible.value).toBe(true);
    active.value = false;
    await nextTick();
    expect(visible.value).toBe(false);

    active.value = true;
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(visible.value).toBe(false);

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(visible.value).toBe(true);
    wrapper.unmount();
  });
});
