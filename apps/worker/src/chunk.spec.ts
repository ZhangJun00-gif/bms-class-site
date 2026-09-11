import { chunkText, iterateChunks, plainText } from './chunk';

describe('document chunking', () => {
  it('strips markup while retaining paragraphs', () => {
    expect(plainText('<h1>标题</h1><p>正文 &amp; 内容</p>')).toBe('标题\n正文 & 内容');
  });

  it('creates overlapping bounded chunks', () => {
    const chunks = chunkText('甲'.repeat(1_600), 800, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(800);
  });

  it('supports incremental consumption for large extracted text', () => {
    const iterator = iterateChunks('甲'.repeat(10_000), 1_200, 160);
    const first = iterator.next();
    const second = iterator.next();

    expect(first.value).toHaveLength(1_200);
    expect(second.value).toHaveLength(1_200);
    expect(second.done).toBe(false);
  });
});
