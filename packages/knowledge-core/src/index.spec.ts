import {
  MAX_MATH_BYTES,
  decodeMarkdown,
  estimateTokens,
  parseKnowledgeMarkdown,
} from './index';

describe('knowledge markdown parser', () => {
  it('builds deterministic nodes, chunks, and image references', () => {
    const markdown = [
      '# 组织学',
      '## 肝脏',
      '肝小叶是肝脏的基本结构单位。',
      '![肝小叶结构示意图](image/lobule.png)',
      '### 血流方向',
      '血液由小叶周边流向中央静脉。',
    ].join('\n\n');

    const first = parseKnowledgeMarkdown(markdown, { allowImages: true });
    const second = parseKnowledgeMarkdown(markdown, { allowImages: true });

    expect(first.issues).toEqual([]);
    expect(first.title).toBe('组织学');
    expect(first.titleMarkdown).toBe('组织学');
    expect(first.nodes).toHaveLength(2);
    expect(first.nodes[0]).toMatchObject({
      level: 2,
      chapterName: '肝脏',
      path: '肝脏',
      titleMarkdown: '肝脏',
    });
    expect(first.nodes[1]).toMatchObject({
      level: 3,
      path: '肝脏 > 血流方向',
      parentPathHash: first.nodes[0]!.pathHash,
    });
    expect(first.images).toEqual([
      expect.objectContaining({
        entryPath: 'image/lobule.png',
        altText: '肝小叶结构示意图',
        nodePathHash: first.nodes[0]!.pathHash,
      }),
    ]);
    expect(first.nodes[0]!.chunks[0]!.content).toContain(
      '[配图：肝小叶结构示意图]',
    );
    expect(first.nodes[0]!.chunks[0]!.imageOccurrenceIndexes).toEqual([0]);
    expect(first.nodes[0]!.renderBlocks).toEqual([
      expect.objectContaining({
        blockIndex: 0,
        imageOccurrenceIndexes: [0],
      }),
    ]);
    expect(first.images[0]!.renderBlockIndex).toBe(0);
    expect(first.nodes[0]!.chunks[0]!.primaryRenderBlockIndex).toBe(0);
    expect(second).toEqual(first);
  });

  it('preserves heading inline Markdown and formula source independently of plain text', () => {
    const result = parseKnowledgeMarkdown(
      [
        '# 第 $v_2$ 版',
        '## 水与 $H_2O$、`x_i` 和 **浓度**',
        '正文。',
      ].join('\n\n'),
      { allowImages: false },
    );

    expect(result.issues).toEqual([]);
    expect(result.title).toBe('第 v_2 版');
    expect(result.titleMarkdown).toBe('第 $v_2$ 版');
    expect(result.nodes[0]).toMatchObject({
      title: '水与 H_2O、x_i 和 浓度',
      titleMarkdown: '水与 $H_2O$、`x_i` 和 **浓度**',
    });
  });

  it('rejects unsafe or block-like heading content', () => {
    const result = parseKnowledgeMarkdown(
      [
        '# 标题',
        '## [危险](javascript:alert(1)) ![图片](image/a.png)',
        '正文。',
      ].join('\n\n'),
      { allowImages: true },
    );

    expect(result.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'HEADING_LINK_UNSAFE',
        'HEADING_CONTENT_UNSUPPORTED',
      ]),
    );
  });

  it('preserves renderable GFM and recognizes all supported math delimiters', () => {
    const markdown = [
      '# 数学知识',
      '## 公式',
      '行内 $a^2+b^2=c^2$ 与 \\(e^{i\\pi}+1=0\\)。',
      '$$\n\\int_0^1 x^2 dx\n$$',
      '\\[\nE = mc^2\n\\]',
      '`$code$` 不应成为公式。',
      '```text\n\\(also-code\\)\n```',
      '| 名称 | 值 |\n| --- | --- |\n| 质量 | **m** |',
      '<script>alert(1)</script>',
    ].join('\n\n');

    const result = parseKnowledgeMarkdown(markdown, { allowImages: false });
    const rendered = result.nodes[0]!.renderBlocks.map(
      (block) => block.markdown,
    ).join('\n\n');

    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'RAW_HTML_IGNORED',
        severity: 'WARNING',
      }),
    ]);
    expect(result.mathCount).toBe(4);
    expect(
      result.nodes[0]!.renderBlocks.reduce(
        (total, block) => total + block.mathCount,
        0,
      ),
    ).toBe(4);
    expect(rendered).toContain('$e^{i\\pi}+1=0$');
    expect(rendered).toContain('$$\nE = mc^2\n$$');
    expect(rendered).toContain('| 名称 | 值');
    expect(rendered).toContain('```text');
    expect(rendered).not.toContain('<script>');
  });

  it('splits render blocks only between top-level Markdown blocks', () => {
    const firstParagraph = '甲'.repeat(9_000);
    const secondParagraph = '乙'.repeat(9_000);
    const result = parseKnowledgeMarkdown(
      `# 标题\n\n## 章节\n\n${firstParagraph}\n\n${secondParagraph}`,
      { allowImages: false },
    );

    expect(result.issues).toEqual([]);
    expect(result.nodes[0]!.renderBlocks).toHaveLength(2);
    expect(result.nodes[0]!.renderBlocks[0]!.markdown).toBe(firstParagraph);
    expect(result.nodes[0]!.renderBlocks[1]!.markdown).toBe(secondParagraph);
    expect(
      new Set(
        result.nodes[0]!.chunks.map(
          (chunk) => chunk.primaryRenderBlockIndex,
        ),
      ),
    ).toEqual(new Set([0, 1]));
    expect(
      result.nodes[0]!.renderBlocks.every(
        (block) => block.markdownBytes > 24 * 1024,
      ),
    ).toBe(true);
  });

  it('rejects a single formula that exceeds the source budget', () => {
    const result = parseKnowledgeMarkdown(
      `# 标题\n\n## 章节\n\n$$\n${'x'.repeat(MAX_MATH_BYTES + 1)}\n$$`,
      { allowImages: false },
    );

    expect(result.issues.map((issue) => issue.code)).toContain(
      'MATH_EXPRESSION_TOO_LARGE',
    );
  });

  it('does not treat paired currency markers or code dollars as math', () => {
    const result = parseKnowledgeMarkdown(
      '# 标题\n\n## 章节\n\n费用从 $100 到 $200，变量为 $2x$，另有 \\(y\\)2，代码为 `$code$`。',
      { allowImages: false },
    );

    expect(result.mathCount).toBe(2);
    expect(result.nodes[0]!.renderBlocks[0]!.markdown).toContain(
      '\\$100 到 \\$200',
    );
    expect(result.nodes[0]!.renderBlocks[0]!.markdown).toContain('$2x$');
  });

  it('inlines reference links and images so every render block is self-contained', () => {
    const result = parseKnowledgeMarkdown(
      [
        '# 标题',
        '## 章节',
        '参见[指南][guide]和![结构图][lobule]。',
        '[guide]: https://example.com/guide',
        '[lobule]: image/lobule.png',
      ].join('\n\n'),
      { allowImages: true },
    );
    const rendered = result.nodes[0]!.renderBlocks[0]!.markdown;

    expect(result.issues).toEqual([]);
    expect(result.images).toEqual([
      expect.objectContaining({
        entryPath: 'image/lobule.png',
        renderBlockIndex: 0,
      }),
    ]);
    expect(rendered).toContain('[指南](https://example.com/guide)');
    expect(rendered).toContain('![结构图](image/lobule.png)');
    expect(rendered).not.toContain('[guide]:');
  });

  it('rejects images in direct Markdown and unsafe ZIP paths', () => {
    const direct = parseKnowledgeMarkdown(
      '# 标题\n\n## 章节\n\n![图](image/a.png)',
      { allowImages: false },
    );
    expect(direct.issues.map((issue) => issue.code)).toContain(
      'DIRECT_MARKDOWN_IMAGE',
    );

    const unsafe = parseKnowledgeMarkdown(
      '# 标题\n\n## 章节\n\n![图](../a.png)',
      { allowImages: true },
    );
    expect(unsafe.issues.map((issue) => issue.code)).toContain(
      'IMAGE_PATH_INVALID',
    );
  });

  it('reports structural errors with stable codes', () => {
    const result = parseKnowledgeMarkdown(
      '# 标题\n\n## 章节\n\n#### 跳级\n\n内容\n\n## 章节\n\n重复',
      { allowImages: false },
    );
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['HEADING_LEVEL_SKIP', 'DUPLICATE_NODE_PATH']),
    );
  });

  it('strictly decodes UTF-8 and rejects NUL', () => {
    expect(decodeMarkdown(Buffer.from('\uFEFF# 标题\r\n', 'utf8'))).toBe(
      '# 标题\n',
    );
    expect(() => decodeMarkdown(Buffer.from([0xff]))).toThrow();
    expect(() => decodeMarkdown(Buffer.from('# 标\0题'))).toThrow(
      'MARKDOWN_NUL',
    );
  });

  it('uses a deterministic bounded token estimator', () => {
    expect(estimateTokens('肝小叶')).toBe(3);
    expect(estimateTokens('hepatocyte')).toBe(3);
  });
});
