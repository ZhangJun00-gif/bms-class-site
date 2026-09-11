import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import unified from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkStringify from 'remark-stringify';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export const KNOWLEDGE_PARSER_VERSION = 'remark-gfm-math-v3';
export const KNOWLEDGE_CHUNKER_VERSION = 'block-token-v1';
export const KNOWLEDGE_RENDER_BLOCK_VERSION = 'mdast-render-v1';
export const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;
export const MAX_ZIP_BYTES = 200 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 500 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_FILES = 1_000;
export const MAX_HEADING_NODES = 10_000;
export const MAX_ESTIMATED_CHUNKS = 25_000;
export const TARGET_CHUNK_TOKENS = 450;
export const MAX_CHUNK_TOKENS = 600;
export const CHUNK_OVERLAP_TOKENS = 60;
export const TARGET_RENDER_BLOCK_BYTES = 24 * 1024;
export const MAX_RENDER_BLOCK_BYTES = 64 * 1024;
export const MAX_MATH_NODES = 10_000;
export const MAX_MATH_BYTES = 16 * 1024;
export const MAX_TOTAL_MATH_BYTES = 1024 * 1024;
export const MAX_HEADING_MARKDOWN_BYTES = 4 * 1024;
const MAX_ZIP_RATIO = 100;
const MAX_PATH_LENGTH = 500;

interface AstPosition {
  start?: { line?: number; column?: number; offset?: number };
  end?: { line?: number; column?: number; offset?: number };
}

interface AstNode {
  type: string;
  depth?: number;
  value?: string;
  url?: string;
  alt?: string;
  title?: string;
  identifier?: string;
  children?: AstNode[];
  position?: AstPosition;
}

export interface KnowledgeIssue {
  severity: 'ERROR' | 'WARNING';
  code: string;
  message: string;
  entryPath?: string;
  nodePath?: string;
  line?: number;
  column?: number;
}

export interface KnowledgeImageReferencePlan {
  entryPath: string;
  altText: string;
  occurrenceIndex: number;
  nodePathHash: string;
  renderBlockIndex?: number;
  line?: number;
  column?: number;
}

export interface KnowledgeRenderBlockPlan {
  blockIndex: number;
  markdown: string;
  sourceHash: string;
  plainTextLength: number;
  markdownBytes: number;
  imageOccurrenceIndexes: number[];
  mathCount: number;
}

export interface KnowledgeChunkPlan {
  chunkIndex: number;
  content: string;
  tokenCount: number;
  contentHash: string;
  imageOccurrenceIndexes: number[];
  primaryRenderBlockIndex: number;
}

export interface KnowledgeNodePlan {
  level: number;
  title: string;
  titleMarkdown: string;
  path: string;
  pathHash: string;
  parentPathHash: string | null;
  breadcrumb: string;
  chapterName: string;
  body: string;
  sortOrder: number;
  chunks: KnowledgeChunkPlan[];
  renderBlocks: KnowledgeRenderBlockPlan[];
}

export interface KnowledgeParseResult {
  title: string;
  titleMarkdown: string;
  markdown: string;
  contentHash: string;
  imageManifestHash: string;
  nodes: KnowledgeNodePlan[];
  images: KnowledgeImageReferencePlan[];
  issues: KnowledgeIssue[];
  chunkCount: number;
  renderBlockCount: number;
  mathCount: number;
}

interface EmbeddingBlock {
  text: string;
  imageOccurrenceIndexes: number[];
  renderBlockIndex?: number;
}

interface ParsedBlock extends EmbeddingBlock {
  markdown: string;
  mathCount: number;
  position?: AstPosition;
}

interface MutableNode {
  level: number;
  title: string;
  titleMarkdown: string;
  normalizedTitle: string;
  path: string;
  pathHash: string;
  parentPathHash: string | null;
  breadcrumb: string;
  chapterName: string;
  sortOrder: number;
  blocks: ParsedBlock[];
  position?: AstPosition;
}

export function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

export function deterministicUuid(...parts: string[]) {
  const bytes = createHash('sha256')
    .update(parts.join('\0'))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function decodeMarkdown(input: Buffer) {
  if (!input.length || input.length > MAX_MARKDOWN_BYTES) {
    throw new Error('MARKDOWN_SIZE_LIMIT');
  }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(input);
  if (decoded.includes('\0')) throw new Error('MARKDOWN_NUL');
  return decoded.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function normalizeKnowledgeName(value: string) {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

export function estimateTokens(value: string) {
  const cjk = value.match(/[\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const remainder = value.replace(/[\u3400-\u9fff\uf900-\ufaff]/gu, ' ');
  const words = remainder.match(/[a-z0-9]+|[^\s\p{L}\p{N}]/giu) ?? [];
  return (
    cjk +
    words.reduce(
      (total, word) => total + Math.max(1, Math.ceil(word.length / 4)),
      0,
    )
  );
}

export function parseKnowledgeMarkdown(
  markdown: string,
  options: { allowImages: boolean },
): KnowledgeParseResult {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' });
  const mathSyntax = normalizeAlternateMathDelimiters(normalized);
  const root = processor.parse(mathSyntax.markdown) as AstNode;
  demoteAmbiguousDollarMath(
    root,
    mathSyntax.markdown,
    mathSyntax.alternateInlineStarts,
  );
  inlineReferenceDefinitions(root);
  const issues: KnowledgeIssue[] = [];
  const mutableNodes: MutableNode[] = [];
  const images: KnowledgeImageReferencePlan[] = [];
  const stack: MutableNode[] = [];
  const imageAltByPath = new Map<string, string>();
  let title = '';
  let titleMarkdown = '';
  let h1Count = 0;
  let current: MutableNode | null = null;
  let seenH2 = false;
  let mathCount = 0;
  let totalMathBytes = 0;

  for (const child of root.children ?? []) {
    walk(child, (node) => {
      if (node.type !== 'math' && node.type !== 'inlineMath') return;
      mathCount += 1;
      const mathBytes = Buffer.byteLength(node.value ?? '', 'utf8');
      totalMathBytes += mathBytes;
      if (mathBytes > MAX_MATH_BYTES) {
        addIssue(
          issues,
          'ERROR',
          'MATH_EXPRESSION_TOO_LARGE',
          `单个公式不能超过 ${MAX_MATH_BYTES} 字节`,
          node,
          current?.path,
        );
      }
    });
    if (child.type === 'heading') {
      const level = child.depth ?? 0;
      const heading = normalizeKnowledgeName(visibleText(child, false));
      const headingMarkdown = stringifyHeadingInline(processor, child, issues);
      if (level === 1) {
        h1Count += 1;
        if (!title) {
          title = heading;
          titleMarkdown = headingMarkdown;
        }
        if (seenH2)
          addIssue(
            issues,
            'ERROR',
            'H1_POSITION',
            'H1 必须位于所有章节之前',
            child,
          );
        if (!heading)
          addIssue(issues, 'ERROR', 'EMPTY_HEADING', '标题不能为空', child);
        if (heading.length > 200)
          addIssue(
            issues,
            'ERROR',
            'HEADING_TOO_LONG',
            '标题不能超过 200 字',
            child,
          );
        current = null;
        continue;
      }
      if (level < 2 || level > 6) continue;
      seenH2 ||= level === 2;
      if (!seenH2)
        addIssue(
          issues,
          'ERROR',
          'MISSING_H2',
          '知识正文必须从 H2 章节开始',
          child,
        );
      if (!heading)
        addIssue(issues, 'ERROR', 'EMPTY_HEADING', '标题不能为空', child);
      if (heading.length > 200)
        addIssue(
          issues,
          'ERROR',
          'HEADING_TOO_LONG',
          '标题不能超过 200 字',
          child,
        );
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      const parent = stack.at(-1) ?? null;
      if (level > 2 && (!parent || parent.level !== level - 1)) {
        addIssue(
          issues,
          'ERROR',
          'HEADING_LEVEL_SKIP',
          '标题层级不能跳级',
          child,
        );
      }
      const chapter =
        level === 2
          ? heading
          : (stack.find((item) => item.level === 2)?.title ?? heading);
      const pathParts = [...stack.map((item) => item.normalizedTitle), heading];
      const path = pathParts.join(' > ');
      const node: MutableNode = {
        level,
        title: heading,
        titleMarkdown: headingMarkdown,
        normalizedTitle: heading,
        path,
        pathHash: sha256(path),
        parentPathHash: parent?.pathHash ?? null,
        breadcrumb: path,
        chapterName: chapter,
        sortOrder: mutableNodes.length,
        blocks: [],
        position: child.position,
      };
      if (
        mutableNodes.some(
          (item) => item.pathHash === node.pathHash && item.path === node.path,
        )
      ) {
        addIssue(
          issues,
          'ERROR',
          'DUPLICATE_NODE_PATH',
          '同一版本中知识路径不能重复',
          child,
          path,
        );
      }
      mutableNodes.push(node);
      stack.push(node);
      current = node;
      continue;
    }

    const htmlNodes: AstNode[] = [];
    walk(child, (node) => {
      if (node.type === 'html') htmlNodes.push(node);
    });
    for (const html of htmlNodes)
      addIssue(
        issues,
        'WARNING',
        'RAW_HTML_IGNORED',
        '原始 HTML 已从知识正文中排除',
        html,
      );

    const blockImages: number[] = [];
    walk(child, (node) => {
      if (node.type !== 'image') return;
      const altText = normalizeKnowledgeName(node.alt ?? '');
      const entryPath = canonicalImagePath(node.url ?? '');
      if (!options.allowImages) {
        addIssue(
          issues,
          'ERROR',
          'DIRECT_MARKDOWN_IMAGE',
          '直接 Markdown 不允许图片引用，请使用 ZIP 知识包',
          node,
        );
        return;
      }
      if (!altText || altText.length > 300) {
        addIssue(
          issues,
          'ERROR',
          'IMAGE_ALT_INVALID',
          '图片替代文本必须为 1-300 字',
          node,
          current?.path,
        );
      }
      if (!entryPath) {
        addIssue(
          issues,
          'ERROR',
          'IMAGE_PATH_INVALID',
          '图片只能引用 image/ 下的一层相对路径',
          node,
          current?.path,
        );
        return;
      }
      const previousAlt = imageAltByPath.get(
        entryPath.toLocaleLowerCase('en-US'),
      );
      if (previousAlt !== undefined && previousAlt !== altText) {
        addIssue(
          issues,
          'ERROR',
          'IMAGE_ALT_CONFLICT',
          '同一图片路径的替代文本必须一致',
          node,
          current?.path,
        );
      } else {
        imageAltByPath.set(entryPath.toLocaleLowerCase('en-US'), altText);
      }
      const occurrenceIndex = images.length;
      node.url = entryPath ?? node.url;
      node.alt = altText;
      images.push({
        entryPath,
        altText,
        occurrenceIndex,
        nodePathHash: current?.pathHash ?? '',
        line: node.position?.start?.line,
        column: node.position?.start?.column,
      });
      blockImages.push(occurrenceIndex);
    });

    const text = visibleText(child, true).trim();
    const safeChild = stripRawHtml(child);
    const blockMarkdown = safeChild ? stringifyBlock(processor, safeChild) : '';
    if (!text && !blockMarkdown) continue;
    if (!current || !seenH2) {
      addIssue(
        issues,
        'ERROR',
        'BODY_OUTSIDE_H2',
        '所有可检索正文必须位于 H2 章节下',
        child,
      );
      continue;
    }
    current.blocks.push({
      text,
      markdown: blockMarkdown,
      imageOccurrenceIndexes: blockImages,
      mathCount: countMath(child),
      position: child.position,
    });
  }

  if (h1Count !== 1)
    issues.push({
      severity: 'ERROR',
      code: 'H1_COUNT',
      message: 'Markdown 必须且只能包含一个 H1',
    });
  if (!title)
    issues.push({
      severity: 'ERROR',
      code: 'MISSING_TITLE',
      message: 'Markdown 缺少有效 H1 标题',
    });
  if (!mutableNodes.some((node) => node.level === 2))
    issues.push({
      severity: 'ERROR',
      code: 'MISSING_H2',
      message: 'Markdown 至少需要一个 H2 章节',
    });
  if (mutableNodes.length > MAX_HEADING_NODES)
    issues.push({
      severity: 'ERROR',
      code: 'NODE_LIMIT',
      message: `标题节点不能超过 ${MAX_HEADING_NODES}`,
    });
  if (mathCount > MAX_MATH_NODES)
    issues.push({
      severity: 'ERROR',
      code: 'MATH_COUNT_LIMIT',
      message: `公式数量不能超过 ${MAX_MATH_NODES}`,
    });
  if (totalMathBytes > MAX_TOTAL_MATH_BYTES)
    issues.push({
      severity: 'ERROR',
      code: 'MATH_TOTAL_SIZE_LIMIT',
      message: `公式源码总量不能超过 ${MAX_TOTAL_MATH_BYTES} 字节`,
    });

  for (const node of mutableNodes) {
    const hasChild = mutableNodes.some(
      (candidate) => candidate.parentPathHash === node.pathHash,
    );
    const hasBody = node.blocks.some(
      (block) =>
        block.text.length > 0 || block.imageOccurrenceIndexes.length > 0,
    );
    if (node.level === 2 && !hasBody && !hasChild) {
      issues.push({
        severity: 'ERROR',
        code: 'EMPTY_CHAPTER',
        message: 'H2 章节必须包含正文或子节点',
        nodePath: node.path,
        line: node.position?.start?.line,
        column: node.position?.start?.column,
      });
    }
  }

  let chunkIndex = 0;
  let renderBlockCount = 0;
  const nodes: KnowledgeNodePlan[] = mutableNodes.map((node) => {
    const renderBlocks = createRenderBlocks(node.blocks, node.path, issues);
    const chunks = chunkBlocks(node.blocks, node.breadcrumb).map((chunk) => ({
      ...chunk,
      chunkIndex: chunkIndex++,
    }));
    for (const block of renderBlocks) {
      for (const occurrenceIndex of block.imageOccurrenceIndexes) {
        const image = images[occurrenceIndex];
        if (image) image.renderBlockIndex = block.blockIndex;
      }
    }
    renderBlockCount += renderBlocks.length;
    return {
      level: node.level,
      title: node.title,
      titleMarkdown: node.titleMarkdown,
      path: node.path,
      pathHash: node.pathHash,
      parentPathHash: node.parentPathHash,
      breadcrumb: node.breadcrumb,
      chapterName: node.chapterName,
      body: node.blocks.map((block) => block.text).join('\n\n'),
      sortOrder: node.sortOrder,
      chunks,
      renderBlocks,
    };
  });
  if (chunkIndex > MAX_ESTIMATED_CHUNKS)
    issues.push({
      severity: 'ERROR',
      code: 'CHUNK_LIMIT',
      message: `估算分片不能超过 ${MAX_ESTIMATED_CHUNKS}`,
    });

  return {
    title,
    titleMarkdown,
    markdown: normalized,
    contentHash: sha256(normalized),
    imageManifestHash: sha256(
      [...imageAltByPath.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, alt]) => `${path}\0${alt}`)
        .join('\n'),
    ),
    nodes,
    images,
    issues,
    chunkCount: chunkIndex,
    renderBlockCount,
    mathCount,
  };
}

function createRenderBlocks(
  blocks: ParsedBlock[],
  nodePath: string,
  issues: KnowledgeIssue[],
): KnowledgeRenderBlockPlan[] {
  const result: KnowledgeRenderBlockPlan[] = [];
  let pending: ParsedBlock[] = [];

  const flush = () => {
    if (!pending.length) return;
    const markdown = pending
      .map((block) => block.markdown)
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (!markdown) {
      pending = [];
      return;
    }
    const blockIndex = result.length;
    for (const block of pending) block.renderBlockIndex = blockIndex;
    result.push({
      blockIndex,
      markdown,
      sourceHash: sha256(`${KNOWLEDGE_RENDER_BLOCK_VERSION}\0${markdown}`),
      plainTextLength: pending.reduce(
        (total, block) => total + block.text.length,
        0,
      ),
      markdownBytes: Buffer.byteLength(markdown, 'utf8'),
      imageOccurrenceIndexes: [
        ...new Set(pending.flatMap((block) => block.imageOccurrenceIndexes)),
      ],
      mathCount: pending.reduce((total, block) => total + block.mathCount, 0),
    });
    pending = [];
  };

  for (const block of blocks) {
    const blockBytes = Buffer.byteLength(block.markdown, 'utf8');
    if (blockBytes > MAX_RENDER_BLOCK_BYTES) {
      issues.push({
        severity: 'ERROR',
        code: 'RENDER_BLOCK_TOO_LARGE',
        message: `单个不可拆分 Markdown 块不能超过 ${MAX_RENDER_BLOCK_BYTES} 字节`,
        nodePath,
        line: block.position?.start?.line,
        column: block.position?.start?.column,
      });
    }
    const candidate = [...pending, block]
      .map((item) => item.markdown)
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (
      pending.length &&
      Buffer.byteLength(candidate, 'utf8') > TARGET_RENDER_BLOCK_BYTES
    )
      flush();
    pending.push(block);
  }
  flush();
  return result;
}

function chunkBlocks(blocks: ParsedBlock[], breadcrumb: string) {
  const fragments = blocks.flatMap(splitBlock);
  const result: Omit<KnowledgeChunkPlan, 'chunkIndex'>[] = [];
  let texts: string[] = [];
  let refs: number[] = [];
  let tokens = 0;
  let primaryRenderBlockIndex: number | undefined;
  let lastRenderBlockIndex: number | undefined;

  const flush = () => {
    if (!texts.length) return;
    const content = texts.join('\n\n').trim();
    const tokenCount = estimateTokens(content);
    if (primaryRenderBlockIndex === undefined) {
      throw new Error('CHUNK_RENDER_BLOCK_MISSING');
    }
    result.push({
      content,
      tokenCount,
      contentHash: sha256(
        `${KNOWLEDGE_PARSER_VERSION}\0${KNOWLEDGE_CHUNKER_VERSION}\0${breadcrumb}\0${content}`,
      ),
      imageOccurrenceIndexes: [...new Set(refs)],
      primaryRenderBlockIndex,
    });
    const overlap = trailingOverlap(content, CHUNK_OVERLAP_TOKENS);
    texts = overlap ? [overlap] : [];
    refs = [];
    tokens = overlap ? estimateTokens(overlap) : 0;
    primaryRenderBlockIndex = overlap ? lastRenderBlockIndex : undefined;
  };

  for (const fragment of fragments) {
    const fragmentTokens = estimateTokens(fragment.text);
    if (texts.length && tokens + fragmentTokens > TARGET_CHUNK_TOKENS) flush();
    if (tokens + fragmentTokens > MAX_CHUNK_TOKENS) flush();
    texts.push(fragment.text);
    refs.push(...fragment.imageOccurrenceIndexes);
    primaryRenderBlockIndex ??= fragment.renderBlockIndex;
    lastRenderBlockIndex = fragment.renderBlockIndex;
    tokens += fragmentTokens;
    if (tokens >= TARGET_CHUNK_TOKENS) flush();
  }
  flush();
  return result;
}

function splitBlock(block: ParsedBlock) {
  if (estimateTokens(block.text) <= MAX_CHUNK_TOKENS) return [block];
  const sentences = block.text.split(/(?<=[。！？.!?；;])\s*/u).filter(Boolean);
  const fragments: EmbeddingBlock[] = [];
  let current = '';
  for (const sentence of sentences.length > 1
    ? sentences
    : splitByLength(block.text, 900)) {
    const candidate = current ? `${current}${sentence}` : sentence;
    if (current && estimateTokens(candidate) > MAX_CHUNK_TOKENS) {
      fragments.push({
        text: current,
        imageOccurrenceIndexes: fragments.length
          ? []
          : block.imageOccurrenceIndexes,
        renderBlockIndex: block.renderBlockIndex,
      });
      current = sentence;
    } else current = candidate;
  }
  if (current)
    fragments.push({
      text: current,
      imageOccurrenceIndexes: fragments.length
        ? []
        : block.imageOccurrenceIndexes,
      renderBlockIndex: block.renderBlockIndex,
    });
  return fragments;
}

function splitByLength(value: string, length: number) {
  const result: string[] = [];
  for (let index = 0; index < value.length; index += length)
    result.push(value.slice(index, index + length));
  return result;
}

function trailingOverlap(value: string, maximumTokens: number) {
  let start = value.length;
  let tokens = 0;
  while (start > 0 && tokens < maximumTokens) {
    const next = Math.max(0, start - 1);
    tokens = estimateTokens(value.slice(next));
    start = next;
  }
  const overlap = value.slice(start).replace(/^\s+/u, '');
  return overlap === value ? '' : overlap;
}

function stringifyBlock(
  processor: { stringify(node: never): string },
  node: AstNode,
) {
  return processor
    .stringify({ type: 'root', children: [node] } as never)
    .trim();
}

function stringifyHeadingInline(
  processor: { stringify(node: never): string },
  heading: AstNode,
  issues: KnowledgeIssue[],
) {
  const allowed = new Set([
    'text',
    'emphasis',
    'strong',
    'delete',
    'inlineCode',
    'inlineMath',
    'link',
  ]);
  for (const child of heading.children ?? []) {
    walk(child, (node) => {
      if (!allowed.has(node.type)) {
        addIssue(
          issues,
          'ERROR',
          'HEADING_CONTENT_UNSUPPORTED',
          '标题只允许文本、强调、删除线、行内代码、受控链接和行内公式',
          node,
        );
        return;
      }
      if (node.type === 'link' && !isAllowedHeadingLink(node.url ?? '')) {
        addIssue(
          issues,
          'ERROR',
          'HEADING_LINK_UNSAFE',
          '标题链接只允许 HTTP、HTTPS 或同页锚点',
          node,
        );
      }
    });
  }
  const markdown = processor
    .stringify({
      type: 'root',
      children: [{ type: 'paragraph', children: heading.children ?? [] }],
    } as never)
    .trim();
  if (markdown.includes('\n')) {
    addIssue(
      issues,
      'ERROR',
      'HEADING_LINE_BREAK',
      '标题不能包含换行',
      heading,
    );
  }
  if (Buffer.byteLength(markdown, 'utf8') > MAX_HEADING_MARKDOWN_BYTES) {
    addIssue(
      issues,
      'ERROR',
      'HEADING_MARKDOWN_TOO_LARGE',
      `标题 Markdown 不能超过 ${MAX_HEADING_MARKDOWN_BYTES} 字节`,
      heading,
    );
  }
  return markdown;
}

function isAllowedHeadingLink(value: string) {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.startsWith('#')) return !value.startsWith('##');
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function stripRawHtml(node: AstNode): AstNode | null {
  if (node.type === 'html') return null;
  if (!node.children) return { ...node };
  return {
    ...node,
    children: node.children
      .map(stripRawHtml)
      .filter((child): child is AstNode => child !== null),
  };
}

function countMath(node: AstNode) {
  let count = 0;
  walk(node, (candidate) => {
    if (candidate.type === 'math' || candidate.type === 'inlineMath')
      count += 1;
  });
  return count;
}

function inlineReferenceDefinitions(root: AstNode) {
  const definitions = new Map<string, AstNode>();
  for (const child of root.children ?? []) {
    if (child.type === 'definition' && child.identifier) {
      definitions.set(child.identifier.toLocaleLowerCase('en-US'), child);
    }
  }
  const transform = (node: AstNode): AstNode => {
    const definition = node.identifier
      ? definitions.get(node.identifier.toLocaleLowerCase('en-US'))
      : undefined;
    if (node.type === 'imageReference' && definition?.url) {
      return {
        ...node,
        type: 'image',
        url: definition.url,
        title: definition.title,
        identifier: undefined,
      };
    }
    if (node.type === 'linkReference' && definition?.url) {
      return {
        ...node,
        type: 'link',
        url: definition.url,
        title: definition.title,
        identifier: undefined,
        children: node.children?.map(transform),
      };
    }
    if (!node.children) return node;
    return { ...node, children: node.children.map(transform) };
  };
  root.children = (root.children ?? [])
    .filter((child) => child.type !== 'definition')
    .map(transform);
}

function demoteAmbiguousDollarMath(
  node: AstNode,
  source: string,
  alternateInlineStarts: Set<number>,
) {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    const start = child.position?.start?.offset;
    const end = child.position?.end?.offset;
    if (
      child.type === 'inlineMath' &&
      start !== undefined &&
      end !== undefined &&
      !alternateInlineStarts.has(start) &&
      (/\d/u.test(source[start - 1] ?? '') || /\d/u.test(source[end] ?? ''))
    ) {
      return {
        type: 'text',
        value: source.slice(start, end),
        position: child.position,
      };
    }
    demoteAmbiguousDollarMath(child, source, alternateInlineStarts);
    return child;
  });
}

function normalizeAlternateMathDelimiters(value: string) {
  const delimiters: Array<{
    index: number;
    kind: 'inline' | 'block';
    open: boolean;
  }> = [];
  let fence: { marker: string; length: number } | null = null;
  let codeSpanLength = 0;
  let lineStart = true;

  for (let index = 0; index < value.length; index += 1) {
    if (lineStart && !codeSpanLength) {
      const lineEnd = value.indexOf('\n', index);
      const line = value.slice(index, lineEnd < 0 ? value.length : lineEnd);
      const match = line.match(/^ {0,3}(`{3,}|~{3,})/u);
      if (match) {
        const marker = match[1]![0]!;
        const length = match[1]!.length;
        if (!fence) fence = { marker, length };
        else if (fence.marker === marker && length >= fence.length)
          fence = null;
        index += line.length - 1;
        lineStart = false;
        continue;
      }
    }
    const character = value[index]!;
    if (character === '\n') {
      lineStart = true;
      continue;
    }
    lineStart = false;
    if (fence) continue;
    if (character === '`') {
      let run = 1;
      while (value[index + run] === '`') run += 1;
      if (!codeSpanLength) codeSpanLength = run;
      else if (codeSpanLength === run) codeSpanLength = 0;
      index += run - 1;
      continue;
    }
    if (
      codeSpanLength ||
      character !== '\\' ||
      value[index - 1] === '\\' ||
      !['(', ')', '[', ']'].includes(value[index + 1] ?? '')
    ) {
      continue;
    }
    const delimiter = value[index + 1]!;
    delimiters.push({
      index,
      kind: delimiter === '(' || delimiter === ')' ? 'inline' : 'block',
      open: delimiter === '(' || delimiter === '[',
    });
    index += 1;
  }

  const replacements = new Map<
    number,
    { marker: string; kind: 'inline' | 'block'; open: boolean }
  >();
  const stacks: Record<'inline' | 'block', number[]> = {
    inline: [],
    block: [],
  };
  for (const delimiter of delimiters) {
    if (delimiter.open) {
      stacks[delimiter.kind].push(delimiter.index);
      continue;
    }
    const openIndex = stacks[delimiter.kind].pop();
    if (openIndex === undefined) continue;
    if (
      delimiter.kind === 'inline' &&
      value.slice(openIndex, delimiter.index).includes('\n')
    )
      continue;
    const marker = delimiter.kind === 'inline' ? '$' : '$$';
    replacements.set(openIndex, { marker, kind: delimiter.kind, open: true });
    replacements.set(delimiter.index, {
      marker,
      kind: delimiter.kind,
      open: false,
    });
  }
  if (!replacements.size) {
    return { markdown: value, alternateInlineStarts: new Set<number>() };
  }
  let normalized = '';
  const alternateInlineStarts = new Set<number>();
  for (let index = 0; index < value.length; index += 1) {
    const replacement = replacements.get(index);
    if (replacement !== undefined) {
      if (replacement.kind === 'inline' && replacement.open) {
        alternateInlineStarts.add(normalized.length);
      }
      normalized += replacement.marker;
      index += 1;
    } else normalized += value[index];
  }
  return { markdown: normalized, alternateInlineStarts };
}

function visibleText(node: AstNode, includeImage: boolean): string {
  if (node.type === 'html') return '';
  if (node.type === 'image')
    return includeImage
      ? `[配图：${normalizeKnowledgeName(node.alt ?? '')}]`
      : normalizeKnowledgeName(node.alt ?? '');
  if (typeof node.value === 'string') return node.value;
  const separator = [
    'paragraph',
    'blockquote',
    'list',
    'listItem',
    'table',
    'tableRow',
    'code',
  ].includes(node.type)
    ? '\n'
    : '';
  return (node.children ?? [])
    .map((child) => visibleText(child, includeImage))
    .filter(Boolean)
    .join(separator);
}

function walk(node: AstNode, visit: (node: AstNode) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function addIssue(
  issues: KnowledgeIssue[],
  severity: KnowledgeIssue['severity'],
  code: string,
  message: string,
  node: AstNode,
  nodePath?: string,
) {
  issues.push({
    severity,
    code,
    message,
    nodePath,
    line: node.position?.start?.line,
    column: node.position?.start?.column,
  });
}

function canonicalImagePath(value: string) {
  const path = value.normalize('NFC');
  if (
    !/^image\/[^/]+$/u.test(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.includes('?') ||
    path.includes('#') ||
    /%2f|%5c|%2e/iu.test(path)
  )
    return null;
  return path;
}

export interface KnowledgeZipEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
}

export interface KnowledgeZipInspection {
  markdownPath: string;
  entries: KnowledgeZipEntry[];
  imagePaths: string[];
}

export interface KnowledgeZipLimits {
  maxExpandedBytes?: number;
  maxImageFiles?: number;
  maxMarkdownBytes?: number;
  maxImageBytes?: number;
  maxZipRatio?: number;
}

export class KnowledgeArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly entryPath?: string,
  ) {
    super(message);
    this.name = 'KnowledgeArchiveError';
  }
}

export async function inspectKnowledgeZip(
  path: string,
  limits: KnowledgeZipLimits = {},
): Promise<KnowledgeZipInspection> {
  const maxExpandedBytes = limits.maxExpandedBytes ?? MAX_EXPANDED_BYTES;
  const maxImageFiles = limits.maxImageFiles ?? MAX_IMAGE_FILES;
  const entries: KnowledgeZipEntry[] = [];
  const names = new Set<string>();
  let expanded = 0;
  await walkZip(path, async (entry) => {
    const checked = validateZipEntry(entry, limits);
    if (checked.directory) return;
    const key = checked.path.toLocaleLowerCase('en-US');
    if (names.has(key))
      throw new KnowledgeArchiveError(
        'ZIP_DUPLICATE_ENTRY',
        'ZIP 包含重复或大小写冲突的文件名',
        checked.path,
      );
    names.add(key);
    expanded += entry.uncompressedSize;
    if (expanded > maxExpandedBytes)
      throw new KnowledgeArchiveError(
        'ZIP_EXPANDED_TOO_LARGE',
        'ZIP 总解压大小超过配置限制',
      );
    entries.push({
      path: checked.path,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
    });
    if (entries.length > maxImageFiles + 1)
      throw new KnowledgeArchiveError(
        'ZIP_FILE_COUNT_LIMIT',
        'ZIP 文件数量超过限制',
      );
  });
  const markdown = entries.filter(
    (entry) =>
      extname(entry.path).toLowerCase() === '.md' && !entry.path.includes('/'),
  );
  if (markdown.length !== 1)
    throw new KnowledgeArchiveError(
      'ZIP_MARKDOWN_COUNT',
      'ZIP 根目录必须且只能包含一个 Markdown 文件',
    );
  const imagePaths = entries
    .filter((entry) => entry.path.startsWith('image/'))
    .map((entry) => entry.path);
  if (imagePaths.length > maxImageFiles)
    throw new KnowledgeArchiveError(
      'ZIP_IMAGE_COUNT_LIMIT',
      'ZIP 图片超过配置限制',
    );
  return { markdownPath: markdown[0]!.path, entries, imagePaths };
}

export async function readKnowledgeZipEntry(
  path: string,
  wanted: string,
  maximum: number,
) {
  let result: Buffer | null = null;
  await walkZip(path, async (entry, zip) => {
    const checked = validateZipEntry(entry);
    if (!checked.directory && checked.path === wanted)
      result = await readEntryBuffer(zip, entry, maximum);
  });
  if (!result)
    throw new KnowledgeArchiveError(
      'ZIP_ENTRY_MISSING',
      'ZIP 缺少所需文件',
      wanted,
    );
  return result as Buffer;
}

export async function forEachKnowledgeZipImage(
  path: string,
  handler: (entryPath: string, data: Buffer) => Promise<void>,
  maximumImageBytes = MAX_IMAGE_BYTES,
) {
  await walkZip(path, async (entry, zip) => {
    const checked = validateZipEntry(entry);
    if (!checked.directory && checked.path.startsWith('image/')) {
      await handler(
        checked.path,
        await readEntryBuffer(zip, entry, maximumImageBytes),
      );
    }
  });
}

function openZip(path: string) {
  return new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(
      path,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
        autoClose: false,
      },
      (error, zip) => (error || !zip ? reject(error) : resolve(zip)),
    );
  });
}

function validateZipEntry(entry: Entry, limits: KnowledgeZipLimits = {}) {
  const path = entry.fileName.normalize('NFC');
  if (
    !path ||
    path.length > MAX_PATH_LENGTH ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[a-zA-Z]:/u.test(path) ||
    path.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new KnowledgeArchiveError(
      'ZIP_UNSAFE_PATH',
      'ZIP 包含不安全路径',
      path,
    );
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0)
    throw new KnowledgeArchiveError(
      'ZIP_ENCRYPTED',
      '不支持加密 ZIP 文件',
      path,
    );
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (unixMode === 0o120000)
    throw new KnowledgeArchiveError('ZIP_SYMLINK', 'ZIP 不允许符号链接', path);
  const directory = path.endsWith('/');
  if (directory) {
    if (path !== 'image/')
      throw new KnowledgeArchiveError(
        'ZIP_UNEXPECTED_ENTRY',
        'ZIP 只允许 image/ 目录',
        path,
      );
    return { path, directory };
  }
  const extension = extname(path).toLowerCase();
  const rootMarkdown = extension === '.md' && basename(path) === path;
  const image =
    /^image\/[^/]+$/u.test(path) &&
    ['.jpg', '.jpeg', '.png', '.webp'].includes(extension);
  if (!rootMarkdown && !image)
    throw new KnowledgeArchiveError(
      'ZIP_UNEXPECTED_ENTRY',
      'ZIP 只允许根 Markdown 和 image/ 下的一层图片',
      path,
    );
  const maximum = rootMarkdown
    ? (limits.maxMarkdownBytes ?? MAX_MARKDOWN_BYTES)
    : (limits.maxImageBytes ?? MAX_IMAGE_BYTES);
  if (entry.uncompressedSize > maximum)
    throw new KnowledgeArchiveError(
      rootMarkdown ? 'MARKDOWN_TOO_LARGE' : 'IMAGE_TOO_LARGE',
      rootMarkdown ? 'Markdown 超过 10 MiB' : '图片超过 10 MiB',
      path,
    );
  if (
    entry.uncompressedSize > 0 &&
    (entry.compressedSize === 0 ||
      entry.uncompressedSize / entry.compressedSize >
        (limits.maxZipRatio ?? MAX_ZIP_RATIO))
  )
    throw new KnowledgeArchiveError(
      'ZIP_RATIO_LIMIT',
      'ZIP 文件压缩比异常',
      path,
    );
  return { path, directory };
}

async function walkZip(
  path: string,
  handler: (entry: Entry, zip: ZipFile) => Promise<void>,
) {
  const zip = await openZip(path);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      error ? reject(error) : resolve();
    };
    zip.once('error', finish);
    zip.once('end', () => finish());
    zip.on('entry', (entry) => {
      void handler(entry, zip)
        .then(() => zip.readEntry())
        .catch(finish);
    });
    zip.readEntry();
  });
}

function readEntryBuffer(zip: ZipFile, entry: Entry, maximum: number) {
  return new Promise<Buffer>((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error);
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximum)
          stream.destroy(
            new KnowledgeArchiveError(
              'ZIP_ENTRY_TOO_LARGE',
              'ZIP entry 解压后超过限制',
              entry.fileName,
            ),
          );
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks, size)));
    });
  });
}

export const KNOWLEDGE_VECTOR_SCHEMA_VERSION = 'knowledge-v1';

export interface KnowledgeEmbeddingProvider {
  dimensions: number;
  model: string;
  embed(
    inputs: string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]>;
}

export interface KnowledgeEmbeddingProviderOptions {
  provider: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maximumAttempts?: number;
  retryDelayMs?: number;
  fetchImplementation?: typeof fetch;
}

interface RetryableEmbeddingError extends Error {
  retryable?: boolean;
}

/** Shared by the batch indexer and API query embedding path. */
export function createKnowledgeEmbeddingProvider(
  options: KnowledgeEmbeddingProviderOptions,
): KnowledgeEmbeddingProvider {
  const provider = options.provider.trim();
  const model = options.model.trim();
  const dimensions = options.dimensions;
  if (!model) throw new Error('EMBEDDING_MODEL_REQUIRED');
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error('EMBEDDING_DIMENSIONS_INVALID');
  }
  if (provider === 'mock') {
    return {
      dimensions,
      model,
      async embed(inputs, requestOptions) {
        throwIfAborted(requestOptions?.signal);
        return inputs.map((input) =>
          deterministicKnowledgeEmbedding(input, dimensions),
        );
      },
    };
  }
  if (provider !== 'zhipu') throw new Error('EMBEDDING_PROVIDER_INVALID');
  const baseUrl = options.baseUrl?.trim();
  const apiKey = options.apiKey?.trim();
  if (!baseUrl) throw new Error('EMBEDDING_BASE_URL_REQUIRED');
  if (!apiKey) throw new Error('EMBEDDING_API_KEY_REQUIRED');
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maximumAttempts = options.maximumAttempts ?? 4;
  const retryDelayMs = options.retryDelayMs ?? 500;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('EMBEDDING_TIMEOUT_INVALID');
  }
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1) {
    throw new Error('EMBEDDING_ATTEMPTS_INVALID');
  }

  return {
    dimensions,
    model,
    async embed(inputs, requestOptions) {
      if (!inputs.length) return [];
      return retryEmbeddingRequest(
        async () => {
          let timedOut = false;
          const linked = linkedAbortSignal(requestOptions?.signal, timeoutMs, () => {
            timedOut = true;
          });
          try {
            const response = await fetchImplementation(baseUrl, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ model, input: inputs, dimensions }),
              signal: linked.signal,
            });
            if (!response.ok) {
              const failure = new Error(
                `EMBEDDING_HTTP_${response.status}`,
              ) as RetryableEmbeddingError;
              failure.retryable = response.status === 429 || response.status >= 500;
              throw failure;
            }
            const body = (await response.json()) as {
              data?: Array<{ index?: number; embedding?: number[] }>;
            };
            const rows = [...(body.data ?? [])].sort(
              (left, right) => (left.index ?? 0) - (right.index ?? 0),
            );
            if (rows.length !== inputs.length) {
              throw new Error('EMBEDDING_COUNT_MISMATCH');
            }
            return rows.map((row) =>
              validateEmbeddingVector(row.embedding, dimensions),
            );
          } catch (error) {
            if (timedOut && !requestOptions?.signal?.aborted) {
              const failure = new Error(
                'EMBEDDING_TIMEOUT',
              ) as RetryableEmbeddingError;
              failure.retryable = true;
              throw failure;
            }
            throw error;
          } finally {
            linked.dispose();
          }
        },
        {
          signal: requestOptions?.signal,
          maximumAttempts,
          retryDelayMs,
        },
      );
    },
  };
}

async function retryEmbeddingRequest<T>(
  action: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    maximumAttempts: number;
    retryDelayMs: number;
  },
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.maximumAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (
        !(error as RetryableEmbeddingError).retryable ||
        attempt === options.maximumAttempts - 1
      ) {
        throw error;
      }
      await abortableDelay(options.retryDelayMs * 2 ** attempt, options.signal);
    }
  }
  throw lastError;
}

function linkedAbortSignal(
  source: AbortSignal | undefined,
  timeoutMs: number,
  onTimeout: () => void,
) {
  const controller = new AbortController();
  const abortFromSource = () => controller.abort(source?.reason);
  if (source?.aborted) abortFromSource();
  else source?.addEventListener('abort', abortFromSource, { once: true });
  const timeout = setTimeout(() => {
    onTimeout();
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      source?.removeEventListener('abort', abortFromSource);
    },
  };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(abortError(signal));
    };
    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function validateEmbeddingVector(
  value: number[] | undefined,
  dimensions: number,
) {
  if (
    !value ||
    value.length !== dimensions ||
    value.some((item) => !Number.isFinite(item))
  ) {
    throw new Error('EMBEDDING_VECTOR_INVALID');
  }
  return value;
}

export function deterministicKnowledgeEmbedding(
  input: string,
  dimensions: number,
) {
  const values = new Array<number>(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const digest = createHash('sha256').update(`${input}\0${index}`).digest();
    values[index] = digest.readInt32BE(0) / 0x7fffffff;
  }
  const norm = Math.sqrt(
    values.reduce((total, value) => total + value * value, 0),
  );
  return values.map((value) => value / norm);
}
