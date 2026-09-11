import DOMPurify, { type Config } from 'dompurify';
import MarkdownIt from 'markdown-it';
import { katex } from '@mdit/plugin-katex';
import type { KnowledgeReaderImage } from '../types';

export const KNOWLEDGE_RENDERER_VERSION = 'knowledge-markdown-v1';

interface KnowledgeMarkdownEnvironment {
  images: Map<string, KnowledgeReaderImage>;
}

const allowedKatexStyleProperties = new Set([
  'height',
  'width',
  'min-width',
  'top',
  'margin',
  'margin-left',
  'margin-right',
  'padding-left',
  'padding-right',
  'border-bottom-width',
  'vertical-align',
]);
const numericCssValue =
  /^-?(?:(?:\d+(?:\.\d+)?)|(?:\.\d+))(?:em|ex|px|%)?(?:\s+-?(?:(?:\d+(?:\.\d+)?)|(?:\.\d+))(?:em|ex|px|%)?){0,3}$/u;

function isInsideKatex(node: Element) {
  return node.classList.contains('katex') || Boolean(node.closest('.katex'));
}

function isAllowedKatexStyle(value: string) {
  const declarations = value
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      const separator = declaration.indexOf(':');
      if (separator < 1) return false;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const propertyValue = declaration.slice(separator + 1).trim();
      return (
        allowedKatexStyleProperties.has(property) &&
        numericCssValue.test(propertyValue)
      );
    })
  );
}

DOMPurify.addHook('uponSanitizeAttribute', (currentNode, event) => {
  if (event.attrName !== 'style') return;
  const element = currentNode instanceof Element ? currentNode : null;
  if (
    !element ||
    !isInsideKatex(element) ||
    !isAllowedKatexStyle(event.attrValue)
  ) {
    event.keepAttr = false;
  }
});

function safeLink(value: string) {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.startsWith('#')) return !value.startsWith('##');
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function stableImage(image: KnowledgeReaderImage | undefined) {
  return Boolean(
    image &&
      /^\/api\/v1\/media\/images\/[^/?#]+\/content$/u.test(
        image.contentUrl,
      ),
  );
}

function createRenderer() {
  const renderer = new MarkdownIt({
    html: false,
    breaks: false,
    linkify: false,
    typographer: false,
  });
  renderer.validateLink = (value) =>
    safeLink(value) || /^image\/[^/?#]+$/u.test(value);
  renderer.use(katex, {
    trust: false,
    throwOnError: false,
    output: 'htmlAndMathml',
    maxExpand: 1_000,
    maxSize: 10,
    strict: 'warn',
    logger: () => 'ignore',
  });
  const defaultLinkOpen =
    renderer.renderer.rules.link_open ??
    ((tokens, index, options, _environment, self) =>
      self.renderToken(tokens, index, options));
  renderer.renderer.rules.link_open = (
    tokens,
    index,
    options,
    environment,
    self,
  ) => {
    const href = tokens[index]!.attrGet('href') ?? '';
    if (!safeLink(href)) return '<span class="knowledge-link-invalid">';
    if (/^https?:/iu.test(href)) {
      tokens[index]!.attrSet('rel', 'noopener noreferrer');
    }
    return defaultLinkOpen(tokens, index, options, environment, self);
  };
  const defaultLinkClose = renderer.renderer.rules.link_close;
  renderer.renderer.rules.link_close = (
    tokens,
    index,
    options,
    environment,
    self,
  ) => {
    const open = [...tokens]
      .slice(0, index)
      .reverse()
      .find((token) => token.type === 'link_open');
    if (open && !safeLink(open.attrGet('href') ?? '')) return '</span>';
    return defaultLinkClose
      ? defaultLinkClose(tokens, index, options, environment, self)
      : self.renderToken(tokens, index, options);
  };
  renderer.renderer.rules.image = (tokens, index, _options, environment) => {
    const token = tokens[index]!;
    const sourcePath = token.attrGet('src') ?? '';
    const altText = token.content || '知识库图片';
    const image = (environment as KnowledgeMarkdownEnvironment).images.get(
      sourcePath,
    );
    if (!stableImage(image)) {
      return `<span class="knowledge-image-unavailable" role="img" aria-label="${renderer.utils.escapeHtml(altText)}">[图片不可用]</span>`;
    }
    const dimensions = [
      image?.width ? ` width="${image.width}"` : '',
      image?.height ? ` height="${image.height}"` : '',
    ].join('');
    return `<img src="${renderer.utils.escapeHtml(image!.contentUrl)}" alt="${renderer.utils.escapeHtml(image!.altText)}"${dimensions} loading="lazy" decoding="async" data-knowledge-image="${renderer.utils.escapeHtml(sourcePath)}">`;
  };
  return renderer;
}

const renderer = createRenderer();

const baseSanitizeConfig: Config = {
  USE_PROFILES: { html: true, mathMl: true },
  FORBID_TAGS: [
    'style',
    'script',
    'iframe',
    'object',
    'embed',
    'form',
    'input',
    'button',
    'textarea',
    'select',
    'option',
    'svg',
  ],
  FORBID_ATTR: ['srcset', 'formaction', 'autofocus'],
  ADD_ATTR: [
    'aria-hidden',
    'aria-label',
    'role',
    'data-knowledge-image',
    'loading',
    'decoding',
    'width',
    'height',
    'rel',
  ],
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?):|#|\/api\/v1\/media\/images\/[^/?#]+\/content$)/iu,
};

function sanitize(html: string) {
  return DOMPurify.sanitize(html, baseSanitizeConfig);
}

function restoreTrustedImageMetadata(
  html: string,
  images: KnowledgeReaderImage[],
) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const imageByPath = new Map(
    images.map((image) => [image.sourcePath, image]),
  );
  for (const element of template.content.querySelectorAll<HTMLImageElement>(
    'img[data-knowledge-image]',
  )) {
    const sourcePath = element.dataset.knowledgeImage ?? '';
    const image = imageByPath.get(sourcePath);
    if (!stableImage(image)) {
      element.remove();
      continue;
    }
    element.src = image!.contentUrl;
    element.alt = image!.altText;
    element.loading = 'lazy';
    element.decoding = 'async';
    if (image!.width) element.width = image!.width;
    if (image!.height) element.height = image!.height;
  }
  return template.innerHTML;
}

export function renderKnowledgeBlock(
  markdown: string,
  images: KnowledgeReaderImage[],
) {
  return restoreTrustedImageMetadata(
    sanitize(
      renderer.render(markdown, {
        images: new Map(images.map((image) => [image.sourcePath, image])),
      } satisfies KnowledgeMarkdownEnvironment),
    ),
    images,
  );
}

export function renderKnowledgeHeading(markdown: string, fallback: string) {
  const rendered = sanitize(
    renderer.renderInline(markdown, { images: new Map() }),
  );
  if (
    !rendered ||
    /<(?:p|div|table|pre|blockquote|ul|ol|li|img|h[1-6])\b/iu.test(rendered)
  ) {
    return renderer.utils.escapeHtml(fallback);
  }
  return rendered;
}
