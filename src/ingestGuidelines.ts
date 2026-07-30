import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearCorpusCache, type GuidelineChunk } from './corpus.ts';

const CORPUS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'corpus', 'guidelines.jsonl');

const APPLE_GUIDELINES_URL = 'https://developer.apple.com/app-store/review/guidelines';
const APPLE_DOCC_JSON_BASE = 'https://developer.apple.com/tutorials/data/documentation';

const MAX_EXCERPT_CHARS = 900;
const MIN_ACCEPTABLE_CHARS = 160;
const FETCH_TIMEOUT_MS = 30000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ai-reviewer-corpus-refresh/1.0; +https://developer.apple.com)';

// Whole-page extractions can accidentally capture navigation chrome. Body-scoped adapters
// do not use these; they rely on min length instead.
const CHROME_MARKERS = ['Skip to main content', 'Sign in', 'Help Center', 'View in English'];

const FETCH_KIND = {
  appleGuidelines: 'apple-guidelines',
  appleDocc: 'apple-docc',
  appleHtml: 'apple-html',
  googleHelp: 'google-help',
  androidDevsite: 'android-devsite',
} as const;

type FetchKind = (typeof FETCH_KIND)[keyof typeof FETCH_KIND];

const FIELD_ORDER: (keyof GuidelineChunk)[] = [
  'id',
  'source',
  'section',
  'title',
  'url',
  'text',
];

const readChunks = (): GuidelineChunk[] =>
  readFileSync(CORPUS_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GuidelineChunk);

const serializeChunk = (chunk: GuidelineChunk): string => {
  const ordered: Record<string, unknown> = {};
  for (const field of FIELD_ORDER) ordered[field] = chunk[field];
  return JSON.stringify(ordered);
};

const writeChunks = (chunks: GuidelineChunk[]): void => {
  writeFileSync(CORPUS_PATH, `${chunks.map(serializeChunk).join('\n')}\n`);
};

const decodeEntities = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&rdquo;/g, '\u201d');

const htmlToText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

const clamp = (text: string): string =>
  text.length > MAX_EXCERPT_CHARS ? `${text.slice(0, MAX_EXCERPT_CHARS).trimEnd()}\u2026` : text;

const looksLikeChrome = (text: string): boolean =>
  CHROME_MARKERS.some((marker) => text.includes(marker));

const normalizeExcerpt = (text: string): string =>
  clamp(
    text
      .replace(/^[:.\-\s]+/, '')
      .replace(/^Watch the latest videos about privacy\s*/i, '')
      .replace(/^Help us improve this policy article by taking a 2-minute survey\s*\.\s*/i, '')
      .replace(
        /^Disclaimer:\s*Policy summaries and Key Considerations are overviews only;[\s\S]*?case of conflict\.\s*/i,
        '',
      )
      .replace(/\s+/g, ' ')
      .trim(),
  );

const stripHash = (url: string): string => url.replace(/#.*$/, '');

const withHlEn = (url: string): string => {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('hl')) parsed.searchParams.set('hl', 'en');
  return parsed.toString();
};

const resolveFetchKind = (url: string): FetchKind | undefined => {
  if (url.startsWith(APPLE_GUIDELINES_URL)) return FETCH_KIND.appleGuidelines;
  if (url.startsWith('https://developer.apple.com/documentation/')) return FETCH_KIND.appleDocc;
  if (url.startsWith('https://support.google.com/')) return FETCH_KIND.googleHelp;
  if (url.startsWith('https://developer.android.com/')) return FETCH_KIND.androidDevsite;
  if (url.startsWith('https://developer.apple.com/')) return FETCH_KIND.appleHtml;
  return undefined;
};

const fetchPage = async (url: string, accept: string): Promise<string | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`  skip (HTTP ${response.status}): ${url}`);
      return undefined;
    }
    return await response.text();
  } catch (error: unknown) {
    console.warn(
      `  skip (fetch failed): ${url} — ${error instanceof Error ? error.message : error}`,
    );
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Balanced walk from the first matching open tag to its corresponding close tag.
const extractElementInnerHtml = (
  html: string,
  openPattern: RegExp,
): string | undefined => {
  openPattern.lastIndex = 0;
  const match = openPattern.exec(html);
  if (!match) return undefined;
  const tagMatch = match[0].match(/^<([a-z0-9]+)/i);
  const tag = tagMatch?.[1]?.toLowerCase();
  if (!tag) return undefined;

  const start = match.index + match[0].length;
  const openRe = new RegExp(`<${escapeRegExp(tag)}\\b`, 'gi');
  const closeRe = new RegExp(`</${escapeRegExp(tag)}>`, 'gi');
  let depth = 1;
  let cursor = start;

  while (cursor < html.length && depth > 0) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) return html.slice(start, start + 40000);

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }

    depth -= 1;
    if (depth === 0) return html.slice(start, nextClose.index);
    cursor = nextClose.index + nextClose[0].length;
  }

  return html.slice(start, start + 40000);
};

const extractByClass = (html: string, className: string): string | undefined =>
  extractElementInnerHtml(
    html,
    new RegExp(
      `<(?:div|main|section|article)[^>]*class="[^"]*\\b${escapeRegExp(className)}\\b[^"]*"[^>]*>`,
      'i',
    ),
  );

const extractByTag = (html: string, tag: string): string | undefined =>
  extractElementInnerHtml(html, new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>`, 'i'));

// Drop Google Help alert/banner nodes (disclaimers, "changes coming", survey callouts).
const removeElementsByClass = (html: string, className: string): string => {
  let output = html;
  const openPattern = new RegExp(
    `<(div|aside|section|p)[^>]*class="[^"]*\\b${escapeRegExp(className)}\\b[^"]*"[^>]*>`,
    'i',
  );

  while (true) {
    openPattern.lastIndex = 0;
    const match = openPattern.exec(output);
    if (!match) break;
    const tag = match[1]?.toLowerCase();
    if (!tag) break;

    const start = match.index;
    const afterOpen = match.index + match[0].length;
    const openRe = new RegExp(`<${escapeRegExp(tag)}\\b`, 'gi');
    const closeRe = new RegExp(`</${escapeRegExp(tag)}>`, 'gi');
    let depth = 1;
    let cursor = afterOpen;
    let end = output.length;

    while (cursor < output.length && depth > 0) {
      openRe.lastIndex = cursor;
      closeRe.lastIndex = cursor;
      const nextOpen = openRe.exec(output);
      const nextClose = closeRe.exec(output);
      if (!nextClose) break;
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth += 1;
        cursor = nextOpen.index + nextOpen[0].length;
        continue;
      }
      depth -= 1;
      if (depth === 0) {
        end = nextClose.index + nextClose[0].length;
        break;
      }
      cursor = nextClose.index + nextClose[0].length;
    }

    output = `${output.slice(0, start)} ${output.slice(end)}`;
  }

  return output;
};

// Prefer "<section> <title>" when Apple still renders a titled heading. Some 2.5.x
// clauses only prefix the prose with the section number ("2.5.4 Multitasking apps…").
const findGuidelineBodyStart = (chunk: GuidelineChunk, pageText: string): number | undefined => {
  const titled = `${chunk.section} ${chunk.title}`;
  const titledIdx = pageText.indexOf(titled);
  if (titledIdx !== -1) return titledIdx + titled.length;

  const token = `${chunk.section} `;
  let from = 0;
  while (from < pageText.length) {
    const idx = pageText.indexOf(token, from);
    if (idx === -1) return undefined;
    const prev = idx === 0 ? '' : pageText[idx - 1];
    if (!prev || !/\d/.test(prev)) return idx + token.length;
    from = idx + token.length;
  }
  return undefined;
};

const extractGuidelineSection = (chunk: GuidelineChunk, pageText: string): string | undefined => {
  const bodyStart = findGuidelineBodyStart(chunk, pageText);
  if (bodyStart === undefined) return undefined;
  return normalizeExcerpt(pageText.slice(bodyStart, bodyStart + MAX_EXCERPT_CHARS));
};

type DocCNode = {
  type?: string;
  text?: string;
  code?: string;
  inlineContent?: unknown[];
  content?: unknown[];
  items?: unknown[];
  abstract?: unknown[];
  primaryContentSections?: unknown[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readDocCNode = (value: unknown): DocCNode | undefined => {
  if (!isRecord(value)) return undefined;
  const node: DocCNode = {};
  if (typeof value.type === 'string') node.type = value.type;
  if (typeof value.text === 'string') node.text = value.text;
  if (typeof value.code === 'string') node.code = value.code;
  if (Array.isArray(value.inlineContent)) node.inlineContent = value.inlineContent;
  if (Array.isArray(value.content)) node.content = value.content;
  if (Array.isArray(value.items)) node.items = value.items;
  if (Array.isArray(value.abstract)) node.abstract = value.abstract;
  if (Array.isArray(value.primaryContentSections)) {
    node.primaryContentSections = value.primaryContentSections;
  }
  return node;
};

const collectDocCText = (value: unknown): string => {
  const node = readDocCNode(value);
  if (!node) return '';
  const parts: string[] = [];
  if (node.text) parts.push(node.text);
  if (node.code) parts.push(node.code);
  if (node.inlineContent) {
    for (const child of node.inlineContent) parts.push(collectDocCText(child));
  }
  if (node.content) {
    for (const child of node.content) parts.push(collectDocCText(child));
  }
  if (node.items) {
    for (const item of node.items) {
      const itemNode = readDocCNode(item);
      if (!itemNode?.content) continue;
      for (const child of itemNode.content) parts.push(collectDocCText(child));
    }
  }
  return parts.join(' ');
};

const doccPathFromUrl = (url: string): string | undefined => {
  const match = stripHash(url).match(
    /^https:\/\/developer\.apple\.com\/documentation\/(.+?)\/?$/,
  );
  return match?.[1];
};

const extractDocCExcerpt = (jsonText: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  const doc = readDocCNode(parsed);
  if (!doc) return undefined;

  const parts: string[] = [];
  if (doc.abstract) {
    for (const node of doc.abstract) parts.push(collectDocCText(node));
  }
  if (doc.primaryContentSections) {
    for (const sectionValue of doc.primaryContentSections) {
      const section = readDocCNode(sectionValue);
      if (!section?.content) continue;
      for (const nodeValue of section.content) {
        const node = readDocCNode(nodeValue);
        if (node?.type === 'heading') continue;
        parts.push(collectDocCText(nodeValue));
      }
    }
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text ? normalizeExcerpt(text) : undefined;
};

type PageCache = Map<string, string | undefined>;

const cachedFetch = async (
  cache: PageCache,
  url: string,
  accept: string,
): Promise<string | undefined> => {
  if (cache.has(url)) return cache.get(url);
  const body = await fetchPage(url, accept);
  cache.set(url, body);
  return body;
};

const extractFromAppleGuidelines = (
  chunk: GuidelineChunk,
  pageText: string | undefined,
): string | undefined => {
  if (!pageText) return undefined;
  const excerpt = extractGuidelineSection(chunk, pageText);
  if (!excerpt || looksLikeChrome(excerpt)) return undefined;
  return excerpt;
};

const extractFromAppleDocc = async (
  chunk: GuidelineChunk,
  cache: PageCache,
): Promise<string | undefined> => {
  const path = doccPathFromUrl(chunk.url);
  if (!path) return undefined;
  const json = await cachedFetch(cache, `${APPLE_DOCC_JSON_BASE}/${path}.json`, 'application/json');
  if (!json) return undefined;
  return extractDocCExcerpt(json);
};

const extractFromAppleHtml = async (
  chunk: GuidelineChunk,
  cache: PageCache,
): Promise<string | undefined> => {
  const html = await cachedFetch(cache, stripHash(chunk.url), 'text/html');
  if (!html) return undefined;
  const inner = extractByTag(html, 'main') ?? extractByClass(html, 'section');
  if (!inner) return undefined;
  const text = htmlToText(inner);
  return text ? normalizeExcerpt(text) : undefined;
};

const extractFromGoogleHelp = async (
  chunk: GuidelineChunk,
  cache: PageCache,
): Promise<string | undefined> => {
  const html = await cachedFetch(cache, withHlEn(stripHash(chunk.url)), 'text/html');
  if (!html) return undefined;
  const rawInner =
    extractByClass(html, 'article-content-container') ??
    extractByClass(html, 'article-container') ??
    extractByClass(html, 'main-content');
  if (!rawInner) return undefined;
  const inner = removeElementsByClass(rawInner, 'alert');
  const text = htmlToText(inner);
  return text ? normalizeExcerpt(text) : undefined;
};

const extractFromAndroidDevsite = async (
  chunk: GuidelineChunk,
  cache: PageCache,
): Promise<string | undefined> => {
  const html = await cachedFetch(cache, withHlEn(stripHash(chunk.url)), 'text/html');
  if (!html) return undefined;
  const inner = extractByClass(html, 'devsite-article-body');
  if (!inner) return undefined;
  const text = htmlToText(inner);
  return text ? normalizeExcerpt(text) : undefined;
};

const extractExcerpt = async (
  chunk: GuidelineChunk,
  kind: FetchKind,
  appleGuidelinesText: string | undefined,
  cache: PageCache,
): Promise<string | undefined> => {
  switch (kind) {
    case FETCH_KIND.appleGuidelines:
      return extractFromAppleGuidelines(chunk, appleGuidelinesText);
    case FETCH_KIND.appleDocc:
      return extractFromAppleDocc(chunk, cache);
    case FETCH_KIND.appleHtml:
      return extractFromAppleHtml(chunk, cache);
    case FETCH_KIND.googleHelp:
      return extractFromGoogleHelp(chunk, cache);
    case FETCH_KIND.androidDevsite:
      return extractFromAndroidDevsite(chunk, cache);
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
};

export type CorpusRefreshResult = {
  updated: number;
  unchanged: number;
  failed: number;
  unsupported: number;
  total: number;
};

export const refreshCorpus = async (): Promise<CorpusRefreshResult> => {
  const chunks = readChunks();
  const cache: PageCache = new Map();

  const needsAppleGuidelines = chunks.some(
    (chunk) => resolveFetchKind(chunk.url) === FETCH_KIND.appleGuidelines,
  );
  let appleGuidelinesText: string | undefined;
  if (needsAppleGuidelines) {
    const html = await cachedFetch(cache, `${APPLE_GUIDELINES_URL}/`, 'text/html');
    if (html) appleGuidelinesText = htmlToText(html);
  }

  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  let unsupported = 0;

  for (const chunk of chunks) {
    const kind = resolveFetchKind(chunk.url);
    if (!kind) {
      console.warn(`  ${chunk.id}: unsupported url host, keeping curated text`);
      unsupported += 1;
      continue;
    }

    const excerpt = await extractExcerpt(chunk, kind, appleGuidelinesText, cache);
    if (!excerpt || excerpt.length < MIN_ACCEPTABLE_CHARS) {
      console.warn(`  ${chunk.id} (${kind}): no reliable excerpt, keeping curated text`);
      failed += 1;
      continue;
    }
    if (excerpt === chunk.text) {
      unchanged += 1;
      continue;
    }

    console.log(`  ${chunk.id} (${kind}): refreshed (${excerpt.length} chars)`);
    chunk.text = excerpt;
    updated += 1;
  }

  writeChunks(chunks);
  clearCorpusCache();

  const result = {
    updated,
    unchanged,
    failed,
    unsupported,
    total: chunks.length,
  };
  console.log(
    `Corpus refresh complete: ${result.updated} updated, ${result.unchanged} unchanged, ` +
      `${result.failed} failed, ${result.unsupported} unsupported, ${result.total} total.`,
  );
  return result;
};

const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
};

if (isDirectRun()) {
  refreshCorpus().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
