import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { SaxesParser } from 'saxes';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

const DOCUMENT_XML = 'word/document.xml';
const MAX_DOCUMENT_XML_BYTES = 384 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 80 * 1024 * 1024;
const PART_FLUSH_CHARS = 64 * 1024;

class TextAccumulator {
  private readonly parts: string[] = [];
  private pending = '';
  private length = 0;

  add(value: string) {
    if (!value) return;
    this.length += value.length;
    if (this.length > MAX_EXTRACTED_TEXT_CHARS) {
      throw new Error('DOCX 提取文本超过 80 MiB 字符上限');
    }
    this.pending += value;
    if (this.pending.length >= PART_FLUSH_CHARS) {
      this.parts.push(this.pending);
      this.pending = '';
    }
  }

  value() {
    if (this.pending) this.parts.push(this.pending);
    return this.parts
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

export async function extractWordDocumentXml(stream: Readable) {
  const text = new TextAccumulator();
  const parser = new SaxesParser({ xmlns: false });
  const decoder = new StringDecoder('utf8');
  let textDepth = 0;

  parser.on('opentag', (tag) => {
    switch (tag.name) {
      case 'w:t':
        textDepth += 1;
        break;
      case 'w:tab':
        text.add('\t');
        break;
      case 'w:br':
      case 'w:cr':
        text.add('\n');
        break;
    }
  });
  parser.on('text', (value) => {
    if (textDepth) text.add(value);
  });
  parser.on('closetag', (tag) => {
    if (tag.name === 'w:t') textDepth = Math.max(0, textDepth - 1);
    if (tag.name === 'w:p' || tag.name === 'w:tc') text.add('\n');
  });

  for await (const chunk of stream) {
    parser.write(Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk));
  }
  parser.write(decoder.end());
  parser.close();
  return text.value();
}

export async function extractDocxText(source: string | Buffer) {
  const zip = await openZip(source);
  try {
    const entry = await findEntry(zip, DOCUMENT_XML);
    if (entry.uncompressedSize > MAX_DOCUMENT_XML_BYTES) {
      throw new Error('DOCX 主文档 XML 超过 384 MiB 安全上限');
    }
    const stream = await zip.openReadStreamPromise(entry);
    return await extractWordDocumentXml(stream);
  } finally {
    zip.close();
  }
}

function openZip(source: string | Buffer) {
  return new Promise<ZipFile>((resolve, reject) => {
    const callback = (error: Error | null, zip: ZipFile) => {
      if (error) reject(error);
      else resolve(zip);
    };
    const options = {
      autoClose: false,
      lazyEntries: true,
      validateEntrySizes: true,
    };
    if (Buffer.isBuffer(source)) yauzl.fromBuffer(source, options, callback);
    else yauzl.open(source, options, callback);
  });
}

function findEntry(zip: ZipFile, name: string) {
  return new Promise<Entry>((resolve, reject) => {
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    const onEntry = (entry: Entry) => {
      if (entry.fileName === name) {
        cleanup();
        resolve(entry);
      } else {
        zip.readEntry();
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`DOCX 缺少 ${name}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    zip.on('entry', onEntry);
    zip.on('end', onEnd);
    zip.on('error', onError);
    zip.readEntry();
  });
}
