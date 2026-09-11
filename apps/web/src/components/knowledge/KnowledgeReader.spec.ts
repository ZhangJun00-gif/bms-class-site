import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KnowledgeReader from './KnowledgeReader.vue';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', () => ({
  api: apiMock,
  formatError: (_caught: unknown, fallback: string) => fallback,
  isAbortError: () => false,
  ApiClientError: class ApiClientError extends Error {
    status = 500;
  },
}));

function heading(index: number) {
  return {
    kind: 'HEADING' as const,
    sequenceKey: String(index).padStart(3, '0'),
    nodeId: `node-${index}`,
    parentId: null,
    level: 2,
    title: `Heading ${index}`,
    titleMarkdown: `Heading ${index}`,
  };
}

describe('KnowledgeReader window anchoring', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let itemHeights: Map<string, number>;
  let resizeObservers: Array<{
    observed: Set<Element>;
    trigger: (targets?: Element[]) => void;
  }>;

  beforeEach(() => {
    itemHeights = new Map();
    resizeObservers = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observed = new Set<Element>();

        constructor(private readonly callback: ResizeObserverCallback) {
          resizeObservers.push(this);
        }

        observe(target: Element) {
          this.observed.add(target);
        }

        unobserve(target: Element) {
          this.observed.delete(target);
        }

        disconnect() {
          this.observed.clear();
        }

        trigger(targets = [...this.observed]) {
          this.callback(
            targets.map((target) => ({ target }) as ResizeObserverEntry),
            this as unknown as ResizeObserver,
          );
        }
      },
    );
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string) => {
      const url = new URL(path, 'https://bmc3.localhost');
      if (url.pathname.endsWith('/reader')) {
        return {
          libraryId: 'library-1',
          libraryName: 'Reader fixture',
          scope: 'SHARED',
          subject: { id: 'subject-1', name: 'Subject', slug: 'subject' },
          readerRevision: 'revision-1',
          headingCount: 68,
          blockCount: 0,
          imageCount: 0,
          firstAnchor: 'node-28',
          hasContent: true,
        };
      }
      if (url.pathname.endsWith('/reader/outline')) {
        return {
          readerRevision: 'revision-1',
          items: [],
          nextCursor: null,
          total: 0,
        };
      }
      if (url.pathname.endsWith('/reader-context')) {
        const nodeId = url.searchParams.get('nodeId')!;
        return {
          anchor: nodeId,
          nodeId,
          renderBlockId: null,
        };
      }
      if (url.pathname.endsWith('/reader/range')) {
        const loadingBefore = url.searchParams.get('before') === '28';
        return {
          readerRevision: 'revision-1',
          items: loadingBefore
            ? Array.from({ length: 28 }, (_, index) => heading(index))
            : Array.from({ length: 40 }, (_, index) => heading(index + 28)),
          hasBefore: !loadingBefore,
          hasAfter: false,
          beforeAnchor: loadingBefore ? null : 'node-28',
          afterAnchor: null,
        };
      }
      throw new Error(`unexpected ${path}`);
    });

    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++frameId;
      queueMicrotask(() => callback(performance.now()));
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const viewport = this.classList.contains('reader-scroll')
          ? this
          : this.closest<HTMLElement>('.reader-scroll');
        let top = 0;
        let width = 0;
        let height = 0;
        if (this.classList.contains('reader-scroll')) {
          top = 100;
          width = 800;
          height = 500;
        } else if (viewport && this.dataset.readerSequence) {
          const mounted = [
            ...viewport.querySelectorAll<HTMLElement>('[data-reader-sequence]'),
          ];
          const index = mounted.indexOf(this);
          const spacer = viewport.querySelector<HTMLElement>('.reader-spacer');
          const spacerHeight = Number.parseFloat(spacer?.style.height ?? '0') || 0;
          const previousHeight = mounted
            .slice(0, index)
            .reduce(
              (total, item) =>
                total + (itemHeights.get(item.dataset.readerSequence!) ?? 40),
              0,
            );
          top = 100 + spacerHeight + previousHeight - viewport.scrollTop;
          width = 760;
          height = itemHeights.get(this.dataset.readerSequence) ?? 40;
        }
        return {
          x: 0,
          y: top,
          top,
          right: width,
          bottom: top + height,
          left: 0,
          width,
          height,
          toJSON: () => ({}),
        } as DOMRect;
      });
  });

  afterEach(() => {
    rectSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('keeps the visible item fixed when prepending an earlier range', async () => {
    const wrapper = mount(KnowledgeReader, {
      props: { libraryId: 'library-1' },
      global: {
        stubs: {
          KnowledgeMarkdownHeading: {
            props: ['markdown'],
            template: '<span>{{ markdown }}</span>',
          },
          KnowledgeMindMap: true,
          KnowledgeOutline: true,
          MarkdownKnowledgeBlock: true,
        },
      },
    });
    await flushPromises();

    const viewport = wrapper.get<HTMLElement>('.reader-scroll').element;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 8_000 },
    });
    viewport.scrollTop = 400;
    const compensated = vi.fn();
    viewport.addEventListener(
      'knowledge-reader-anchor-compensated',
      compensated as EventListener,
    );

    await wrapper.get('.reader-scroll').trigger('scroll');
    await flushPromises();

    expect(wrapper.findAll('[data-reader-sequence]')).toHaveLength(68);
    expect(viewport.scrollTop).toBe(1_520);
    expect(viewport.dataset.lastAnchorDeviation).toBe('0.000');
    expect(compensated).toHaveBeenCalledTimes(1);
    expect((compensated.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      reason: 'LOAD_BEFORE',
      sequenceKey: '038',
      previousTop: 0,
      nextTop: 0,
      deviation: 0,
    });

    wrapper.unmount();
  });

  it('positions a direct node deep link after the viewport mounts', async () => {
    const wrapper = mount(KnowledgeReader, {
      props: { libraryId: 'library-1', initialNodeId: 'node-42' },
      global: {
        stubs: {
          KnowledgeMarkdownHeading: {
            props: ['markdown'],
            template: '<span>{{ markdown }}</span>',
          },
          KnowledgeMindMap: true,
          KnowledgeOutline: true,
          MarkdownKnowledgeBlock: true,
        },
      },
    });
    await flushPromises();

    const viewport = wrapper.get<HTMLElement>('.reader-scroll').element;
    expect(viewport.scrollTop).toBe(536);
    expect(wrapper.get('[data-heading-node="node-42"]').text()).toBe('Heading 42');

    wrapper.unmount();
  });

  it('keeps a programmatic target active until the user scrolls past it', async () => {
    const wrapper = mount(KnowledgeReader, {
      props: { libraryId: 'library-1' },
      global: {
        stubs: {
          KnowledgeMarkdownHeading: {
            props: ['markdown'],
            template: '<span>{{ markdown }}</span>',
          },
          KnowledgeMindMap: true,
          KnowledgeOutline: true,
          MarkdownKnowledgeBlock: true,
        },
      },
    });
    await flushPromises();

    const viewport = wrapper.get<HTMLElement>('.reader-scroll').element;
    wrapper.findComponent({ name: 'KnowledgeOutline' }).vm.$emit('select', 'node-42');
    await flushPromises();
    await wrapper.get('.reader-scroll').trigger('scroll');
    await flushPromises();
    expect(wrapper.emitted('locate')).toEqual([[{ nodeId: 'node-42' }]]);

    viewport.scrollTop = 1_000;
    await wrapper.get('.reader-scroll').trigger('scroll');
    await flushPromises();
    expect(wrapper.emitted('locate')?.at(-1)).toEqual([{ nodeId: 'node-55' }]);

    wrapper.unmount();
  });

  it('aggregates asynchronous height changes above one stable anchor', async () => {
    const wrapper = mount(KnowledgeReader, {
      props: { libraryId: 'library-1' },
      global: {
        stubs: {
          KnowledgeMarkdownHeading: {
            props: ['markdown'],
            template: '<span>{{ markdown }}</span>',
          },
          KnowledgeMindMap: true,
          KnowledgeOutline: true,
          MarkdownKnowledgeBlock: true,
        },
      },
    });
    await flushPromises();

    const viewport = wrapper.get<HTMLElement>('.reader-scroll').element;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 8_000 },
    });
    viewport.scrollTop = 400;
    await wrapper.get('.reader-scroll').trigger('scroll');
    await flushPromises();

    const itemObserver = [...resizeObservers]
      .reverse()
      .find((observer) =>
        [...observer.observed].some(
          (element) => (element as HTMLElement).dataset.readerSequence,
        ),
      );
    expect(itemObserver).toBeDefined();
    const mounted = [
      ...viewport.querySelectorAll<HTMLElement>('[data-reader-sequence]'),
    ];
    itemObserver!.trigger(mounted);

    viewport.scrollTop = 1_540;
    const compensated = vi.fn();
    viewport.addEventListener(
      'knowledge-reader-anchor-compensated',
      compensated as EventListener,
    );
    const first = mounted.find((item) => item.dataset.readerSequence === '000')!;
    const second = mounted.find((item) => item.dataset.readerSequence === '001')!;
    itemHeights.set('000', 48);
    itemHeights.set('001', 49);
    itemObserver!.trigger([first, second]);

    expect(viewport.scrollTop).toBe(1_557);
    expect(viewport.dataset.lastAnchorDeviation).toBe('0.000');
    expect((compensated.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      reason: 'RESIZE_ABOVE_ANCHOR',
      sequenceKey: '038',
      previousTop: -20,
      nextTop: -20,
      deviation: 0,
    });

    wrapper.unmount();
  });
});
