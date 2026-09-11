import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ParticleCanvas from './ParticleCanvas.vue';

interface MediaQueryController {
  mediaQuery: MediaQueryList;
  setMatches(matches: boolean): void;
}

function mockParticleMode(initialMatches: boolean): MediaQueryController {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    get matches() {
      return matches;
    },
    media: '(min-width: 901px) and (prefers-reduced-motion: no-preference)',
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;

  vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));

  return {
    mediaQuery,
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

describe('ParticleCanvas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses only the static emblem when particle mode is unavailable', () => {
    mockParticleMode(false);
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');

    const wrapper = mount(ParticleCanvas);

    expect(wrapper.get('.emblem-image').attributes('src')).toBe('/badge.png');
    expect(wrapper.get('.emblem-image').attributes('aria-hidden')).toBeUndefined();
    expect(wrapper.get('.emblem-backdrop').attributes('aria-hidden')).toBe('true');
    expect(getContext).not.toHaveBeenCalled();
  });

  it('starts particles only in desktop motion mode and cleans up across mode changes', () => {
    const mode = mockParticleMode(false);
    const context = {} as CanvasRenderingContext2D;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);

    const wrapper = mount(ParticleCanvas);
    expect(getContext).not.toHaveBeenCalled();

    mode.setMatches(true);
    expect(getContext).toHaveBeenCalledTimes(1);

    mode.setMatches(false);
    mode.setMatches(true);
    expect(getContext).toHaveBeenCalledTimes(2);

    wrapper.unmount();
    expect(mode.mediaQuery.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
