export function plainText(html: string) {
  return html
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function* iterateChunks(text: string, size = 1_200, overlap = 160): Generator<string> {
  if (size <= overlap) throw new Error('Chunk size must exceed overlap');
  const normalized = text.replace(/\r/g, '').trim();
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + size, normalized.length);
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n', end), normalized.lastIndexOf('。', end));
      if (boundary > start + size / 2) end = boundary + 1;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) yield chunk;
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
}

export function chunkText(text: string, size = 1_200, overlap = 160) {
  return [...iterateChunks(text, size, overlap)];
}
