import { describe, expect, it } from 'vitest';
import { sanitizePastedHtml } from './newsHtml';

describe('sanitizePastedHtml', () => {
  it('keeps supported basic formatting', () => {
    const input =
      '<h2>标题</h2><p>正文<strong>粗体</strong><em>斜体</em><u>下划线</u></p>' +
      '<ul><li>项目一</li></ul><ol><li>项目二</li></ol><blockquote>引用</blockquote>' +
      '<pre><code>code</code></pre>';
    const { html, droppedMedia } = sanitizePastedHtml(input);
    expect(html).toContain('<h2>标题</h2>');
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('<em>斜体</em>');
    expect(html).toContain('<u>下划线</u>');
    expect(html).toContain('<ul><li>项目一</li></ul>');
    expect(html).toContain('<ol><li>项目二</li></ol>');
    expect(html).toContain('<blockquote>引用</blockquote>');
    expect(html).toContain('<pre><code>code</code></pre>');
    expect(droppedMedia).toBe(false);
  });

  it('maps unsupported headings into the nearest supported level', () => {
    const { html } = sanitizePastedHtml('<h1>一级</h1><h5>五级</h5>');
    expect(html).toContain('<h2>一级</h2>');
    expect(html).toContain('<h4>五级</h4>');
  });

  it('keeps simple tables with colspan and rowspan', () => {
    const { html } = sanitizePastedHtml(
      '<table><tbody><tr><th colspan="2">表头</th></tr><tr><td rowspan="2">单元格</td></tr></tbody></table>',
    );
    expect(html).toContain('<table>');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('rowspan="2"');
  });

  it('drops script and style elements together with their content', () => {
    const { html } = sanitizePastedHtml(
      '<p>安全</p><script>alert(1)</script><style>p{color:red}</style>',
    );
    expect(html).toContain('<p>安全</p>');
    expect(html).not.toContain('alert');
    expect(html).not.toContain('color:red');
  });

  it('drops pasted images and reports dropped media', () => {
    const { html, droppedMedia } = sanitizePastedHtml(
      '<p>图前</p><img src="data:image/png;base64,AAAA" alt="截图"><p>图后</p>',
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('data:image');
    expect(html).toContain('<p>图前</p>');
    expect(html).toContain('<p>图后</p>');
    expect(droppedMedia).toBe(true);
  });

  it('unwraps span and font tags but keeps their text', () => {
    const { html } = sanitizePastedHtml(
      '<p><span style="font-family:serif">文字</span><font color="red">保留</font></p>',
    );
    expect(html).not.toContain('<span');
    expect(html).not.toContain('<font');
    expect(html).toContain('文字');
    expect(html).toContain('保留');
  });

  it('removes dangerous hrefs and keeps http and mailto links', () => {
    const { html } = sanitizePastedHtml(
      '<a href="javascript:alert(1)">坏</a><a href="data:text/html,x">差</a>' +
        '<a href="https://example.com">好</a><a href="mailto:a@b.cn">邮</a>',
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text');
    expect(html).toContain('<a href="https://example.com">好</a>');
    expect(html).toContain('<a href="mailto:a@b.cn">邮</a>');
  });

  it('strips control characters before checking the href scheme', () => {
    // DOMParser 会把 &#9; 解析成制表符，scheme 判断前必须剥离
    const { html } = sanitizePastedHtml(
      '<a href="java&#9;script:alert(1)">坏</a>',
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('href');
  });

  it('keeps controlled color and text-align styles only', () => {
    const { html } = sanitizePastedHtml(
      '<p style="color: #26397d; text-align: center; background-color: yellow; position: fixed">样式</p>',
    );
    expect(html).toContain('color: #26397d');
    expect(html).toContain('text-align: center');
    expect(html).not.toContain('background-color');
    expect(html).not.toContain('position');
  });

  it('strips event handlers, classes and data attributes', () => {
    const { html } = sanitizePastedHtml(
      '<p class="x" id="y" onclick="alert(1)" data-photo-id="abc">属性</p>',
    );
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('class=');
    expect(html).not.toContain('id=');
    expect(html).not.toContain('data-photo-id');
    expect(html).toContain('属性');
  });

  it('returns empty html for empty or script-only input', () => {
    expect(sanitizePastedHtml('').html).toBe('');
    expect(sanitizePastedHtml('<script>x</script>').html).toBe('');
  });
});
