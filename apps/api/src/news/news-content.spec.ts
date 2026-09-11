import { BadRequestException } from '@nestjs/common';
import { extractPhotoIds, normalizeNewsContent } from './news-content';

describe('normalizeNewsContent', () => {
  it('keeps supported article formatting and internal image references', () => {
    const result = normalizeNewsContent(`
      <section style="text-align: center; position: fixed">
        <h2 style="color: #26397d; font-size: 28px">班级活动</h2>
        <p><strong>保留正文</strong></p>
        <img src="/api/v1/media/images/photo-1/content" data-photo-id="photo-1" onerror="alert(1)">
      </section>
    `);

    expect(result.body).toContain('text-align:center');
    expect(result.body).toContain('font-size:28px');
    expect(result.body).toContain('data-photo-id="photo-1"');
    expect(result.body).not.toContain('position');
    expect(result.body).not.toContain('onerror');
    expect(result.photoIds).toEqual(['photo-1']);
  });

  it('removes scripts and external images', () => {
    const result = normalizeNewsContent(`
      <p>安全正文<script>alert(1)</script></p>
      <img src="https://example.com/tracker.png" data-photo-id="tracker">
    `);

    expect(result.body).toContain('安全正文');
    expect(result.body).not.toContain('script');
    expect(result.body).not.toContain('example.com');
    expect(result.photoIds).toEqual([]);
  });

  it('rejects content emptied by sanitization', () => {
    expect(() => normalizeNewsContent('<script>alert(1)</script>')).toThrow(
      BadRequestException,
    );
  });
});

describe('extractPhotoIds', () => {
  it('deduplicates photo references in document order', () => {
    expect(
      extractPhotoIds(
        '<img data-photo-id="a"><img data-photo-id="b"><img data-photo-id="a">',
      ),
    ).toEqual(['a', 'b']);
  });
});
