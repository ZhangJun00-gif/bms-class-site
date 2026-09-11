/**
 * 动态正文 HTML_V1 的前端粘贴消毒。
 * 粘贴白名单是服务端 sanitize-html 白名单（apps/api/src/news/news-content.ts）
 * 的子集——刻意更窄：图片不允许粘贴 base64，只能经上传/相册插入；
 * 链接与样式规则与服务端保持一致，使粘贴内容保存后不再变化。
 */

const ALLOWED_TAGS = new Set([
  'p',
  'div',
  'section',
  'br',
  'hr',
  'h2',
  'h3',
  'h4',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'pre',
  'code',
]);

/** 连同内容一起丢弃的元素 */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'title',
  'head',
  'noscript',
  'template',
  'svg',
  'canvas',
  'form',
  'input',
  'button',
  'select',
  'textarea',
]);

/** 媒体元素：正文图片必须经接口上传，粘贴时丢弃并提示 */
const MEDIA_TAGS = new Set(['img', 'picture', 'video', 'audio', 'source']);

/** 编辑器只提供二/三级标题，其他标题映射到最近层级 */
const TAG_RENAMES: Record<string, string> = {
  h1: 'h2',
  h5: 'h4',
  h6: 'h4',
};

const SAFE_COLOR = /^(?:#[0-9a-fA-F]{3,8}|rgba?\([\d\s,.%]+\)|[a-zA-Z]{3,20})$/;
const SAFE_TEXT_ALIGN = /^(?:left|center|right|justify)$/;
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto']);

export interface SanitizedPaste {
  html: string;
  /** 粘贴内容中包含被移除的图片/媒体，提示用户改用上传插入 */
  droppedMedia: boolean;
}

export function sanitizePastedHtml(input: string): SanitizedPaste {
  const doc = new DOMParser().parseFromString(input, 'text/html');
  const state = { droppedMedia: false };
  const container = doc.createElement('div');
  for (const node of Array.from(doc.body.childNodes)) {
    appendClean(node, container, state, doc);
  }
  return { html: container.innerHTML.trim(), droppedMedia: state.droppedMedia };
}

function appendClean(
  node: ChildNode,
  parent: HTMLElement,
  state: { droppedMedia: boolean },
  doc: Document,
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    parent.appendChild(doc.createTextNode(node.nodeValue ?? ''));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const element = node as HTMLElement;
  const tag = element.localName;
  if (DROP_WITH_CONTENT.has(tag)) return;
  if (MEDIA_TAGS.has(tag)) {
    state.droppedMedia = true;
    return;
  }

  const mapped = TAG_RENAMES[tag] ?? tag;
  if (!ALLOWED_TAGS.has(mapped)) {
    // 未在白名单内的元素（span、font、figure 等）：保留子内容，去除外壳
    for (const child of Array.from(element.childNodes)) {
      appendClean(child, parent, state, doc);
    }
    return;
  }

  const clean = doc.createElement(mapped);
  copyAttributes(element, clean);
  parent.appendChild(clean);
  for (const child of Array.from(element.childNodes)) {
    appendClean(child, clean, state, doc);
  }
}

function copyAttributes(source: HTMLElement, target: HTMLElement): void {
  const tag = target.localName;

  if (tag === 'a') {
    const href = safeHref(source.getAttribute('href'));
    if (href) target.setAttribute('href', href);
    const title = source.getAttribute('title');
    if (title) target.setAttribute('title', title);
  }

  if (tag === 'td' || tag === 'th') {
    for (const name of ['colspan', 'rowspan'] as const) {
      const value = Number.parseInt(source.getAttribute(name) ?? '', 10);
      if (Number.isInteger(value) && value >= 1 && value <= 99)
        target.setAttribute(name, String(value));
    }
  }

  const style = safeStyle(source.getAttribute('style'));
  if (style) target.setAttribute('style', style);
}

/** 仅保留受控样式：文字颜色与文本对齐，取值与服务端正则一致 */
function safeStyle(style: string | null): string {
  if (!style) return '';
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (property === 'color' && SAFE_COLOR.test(value))
      kept.push(`color: ${value}`);
    if (property === 'text-align' && SAFE_TEXT_ALIGN.test(value))
      kept.push(`text-align: ${value}`);
  }
  return kept.join('; ');
}

function safeHref(href: string | null): string | null {
  if (!href) return null;
  // 先剥离空白与控制字符（与服务端 launder 一致），
  // 防止 java&#9;script: 这类含制表符的写法绕过 scheme 白名单
  const trimmed = href.replace(/[\x00-\x20]+/g, '');
  if (!trimmed || trimmed.startsWith('//')) return null;
  const scheme = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme && !ALLOWED_SCHEMES.has(scheme[1]!.toLowerCase())) return null;
  return trimmed;
}
