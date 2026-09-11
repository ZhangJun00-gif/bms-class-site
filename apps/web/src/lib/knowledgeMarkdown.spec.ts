import { describe, expect, it } from 'vitest';
import {
  renderKnowledgeBlock,
  renderKnowledgeHeading,
} from './knowledgeMarkdown';

describe('knowledge Markdown renderer', () => {
  it('uses the same KaTeX renderer for headings and body formulas', () => {
    const heading = renderKnowledgeHeading('水 $H_2O$ 与 $x_i^2$', '水 H_2O');
    const body = renderKnowledgeBlock('水 $H_2O$ 与 $x_i^2$', []);

    expect(heading).toContain('class="katex"');
    expect(body).toContain('class="katex"');
    expect(heading).toContain('msupsub');
    expect(body).toContain('msupsub');
  });

  it('removes raw HTML, unsafe links, event attributes, and untrusted styles', () => {
    const html = renderKnowledgeBlock(
      [
        '<img src="x" onerror="alert(1)">',
        '[危险](javascript:alert(1))',
        '<span style="color:red">文本</span>',
      ].join('\n\n'),
      [],
    );

    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(
      /<a[^>]+href="javascript:|<span[^>]+style="color:red"|<img src="x"/u,
    );
  });

  it('renders only images mapped by the current server block', () => {
    const mapped = renderKnowledgeBlock('![结构图](image/lobule.png)', [
      {
        sourcePath: 'image/lobule.png',
        occurrenceIndex: 0,
        photoId: 'photo-1',
        contentUrl: '/api/v1/media/images/photo-1/content',
        altText: '肝小叶结构图',
        width: 1200,
        height: 800,
      },
    ]);
    const missing = renderKnowledgeBlock(
      '![远程图](https://example.com/a.png)',
      [],
    );

    expect(mapped).toContain('/api/v1/media/images/photo-1/content');
    expect(mapped).toContain('width="1200"');
    expect(missing).toContain('图片不可用');
    expect(missing).not.toContain('example.com');
  });
});
