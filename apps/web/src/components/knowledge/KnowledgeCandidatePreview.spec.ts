import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import KnowledgeCandidatePreview from './KnowledgeCandidatePreview.vue';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', () => ({
  api: apiMock,
  formatError: (_caught: unknown, fallback: string) => fallback,
  isAbortError: () => false,
  ApiClientError: class ApiClientError extends Error {
    status = 500;
  },
}));

describe('KnowledgeCandidatePreview', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith('/preview')) {
        return {
          documentId: 'document-1',
          versionId: 'version-2',
          libraryId: 'library-1',
          libraryName: '组织学知识库',
          previewRevision: 'preview-revision-123',
          title: '第二版 H_2O',
          titleMarkdown: '第二版 $H_2O$',
          headingCount: 2,
          blockCount: 2,
          imageCount: 0,
          firstAnchor: 'node-1',
        };
      }
      if (path.includes('/preview/range')) {
        const next = path.includes('anchor=block-1');
        return {
          readerRevision: 'preview-revision-123',
          items: next
            ? [
                {
                  kind: 'HEADING',
                  sequenceKey: '003',
                  nodeId: 'node-2',
                  parentId: 'node-1',
                  level: 3,
                  title: '后续内容',
                  titleMarkdown: '后续内容',
                },
              ]
            : [
                {
                  kind: 'HEADING',
                  sequenceKey: '001',
                  nodeId: 'node-1',
                  parentId: null,
                  level: 2,
                  title: '水分子 H_2O',
                  titleMarkdown: '水分子 $H_2O$',
                },
                {
                  kind: 'BLOCK',
                  sequenceKey: '002',
                  nodeId: 'node-1',
                  renderBlockId: 'block-1',
                  blockIndex: 0,
                  markdown: '正文',
                  sourceHash: 'hash',
                  markdownBytes: 6,
                  mathCount: 0,
                  images: [],
                },
              ],
          hasBefore: false,
          hasAfter: !next,
          beforeAnchor: null,
          afterAnchor: next ? null : 'block-1',
        };
      }
      throw new Error(`unexpected ${path}`);
    });
  });

  it('loads only the selected document version and incrementally extends its range', async () => {
    const wrapper = mount(KnowledgeCandidatePreview, {
      props: { documentId: 'document-1', versionId: 'version-2' },
      global: {
        stubs: {
          MarkdownKnowledgeBlock: { template: '<div>正文</div>' },
        },
      },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('版本标识');
    expect(wrapper.text()).toContain('第二版');
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual([
      '/knowledge/documents/document-1/versions/version-2/preview',
      expect.stringContaining(
        '/knowledge/documents/document-1/versions/version-2/preview/range?',
      ),
    ]);
    expect(
      apiMock.mock.calls.some(([path]) => String(path).includes('/libraries/')),
    ).toBe(false);

    await wrapper.get('.preview-scroll').trigger('scroll');
    await flushPromises();
    expect(wrapper.text()).toContain('后续内容');
    expect(apiMock).toHaveBeenCalledTimes(3);
  });
});
