import { BadRequestException } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';

const IMAGE_URL_PATTERN =
  /^\/api\/v1\/media\/images\/([a-zA-Z0-9_-]+)\/content$/;
const SAFE_COLOR = /^(?:#[0-9a-fA-F]{3,8}|rgba?\([\d\s,.%]+\)|[a-zA-Z]{3,20})$/;

export interface NormalizedNewsContent {
  body: string;
  photoIds: string[];
}

export function normalizeNewsContent(input: string): NormalizedNewsContent {
  const body = sanitizeHtml(input, {
    allowedTags: [
      'p',
      'div',
      'section',
      'span',
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
      'figure',
      'figcaption',
      'img',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'pre',
      'code',
    ],
    allowedAttributes: {
      '*': ['style'],
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'data-photo-id'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    allowedStyles: {
      '*': {
        color: [SAFE_COLOR],
        'background-color': [SAFE_COLOR],
        'font-size': [
          /^(?:[8-9]|[1-4]\d)(?:\.\d+)?px$/,
          /^(?:0\.[5-9]|[1-3](?:\.\d+)?)(?:rem|em)$/,
        ],
        'font-weight': [/^(?:normal|bold|[1-9]00)$/],
        'font-style': [/^(?:normal|italic)$/],
        'text-decoration': [/^(?:none|underline|line-through)$/],
        'text-align': [/^(?:left|center|right|justify)$/],
        'line-height': [/^(?:normal|[1-2](?:\.\d+)?)$/],
        'margin-left': [/^(?:0|[1-9]\d{0,2}px)$/],
        'padding-left': [/^(?:0|[1-9]\d{0,2}px)$/],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    exclusiveFilter: (frame) => {
      if (frame.tag !== 'img') return false;
      const match = frame.attribs.src?.match(IMAGE_URL_PATTERN);
      return !match || match[1] !== frame.attribs['data-photo-id'];
    },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          ...(attribs.target === '_blank'
            ? { rel: 'noopener noreferrer' }
            : {}),
        },
      }),
    },
  }).trim();

  const photoIds = extractPhotoIds(body);
  const plainText = sanitizeHtml(body, {
    allowedTags: [],
    allowedAttributes: {},
  }).replace(/\s+/g, '');
  if (!plainText && photoIds.length === 0)
    throw new BadRequestException('动态正文不能为空');
  return { body, photoIds };
}

export function extractPhotoIds(body: string) {
  return Array.from(
    new Set(
      Array.from(
        body.matchAll(/data-photo-id="([a-zA-Z0-9_-]+)"/g),
        (match) => match[1]!,
      ),
    ),
  );
}
