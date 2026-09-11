export interface SseEvent {
  event: string;
  data: string;
}

export type SseHandler = (event: SseEvent) => void;

/**
 * 增量 SSE 解析器。
 * - 事件可以跨多个数据块（feed 任意切片）
 * - 一个数据块可以包含多个事件
 * - end() 时冲刷残余 buffer
 * - 兼容 CRLF、注释行与多行 data
 */
export function createSseParser(onEvent: SseHandler) {
  let buffer = '';

  function parseBlock(block: string): void {
    let name = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) onEvent({ event: name, data: dataLines.join('\n') });
  }

  return {
    feed(chunk: string): void {
      buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        parseBlock(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    },
    end(): void {
      if (buffer.trim()) parseBlock(buffer);
      buffer = '';
    },
  };
}
