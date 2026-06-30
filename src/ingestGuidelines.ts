import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GuidelineChunk } from './corpus.ts';

const CORPUS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'corpus', 'guidelines.jsonl');

// Only the Apple App Store Review Guidelines render as a single static HTML page we can
// parse reliably. Apple developer-doc pages and every Google Play support page are
// JavaScript-rendered (a plain fetch returns navigation chrome), so those chunks stay
// under manual curation and are intentionally skipped here.
const REFRESHABLE_HOST = 'https://developer.apple.com/app-store/review/guidelines';

const MAX_EXCERPT_CHARS = 900;
const MIN_ACCEPTABLE_CHARS = 160;
const FETCH_TIMEOUT_MS = 30000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ai-reviewer-corpus-refresh/1.0; +https://developer.apple.com)';

// If an extraction contains any of these it is almost certainly navigation chrome
// rather than guideline prose, so we keep the curated text instead.
const CHROME_MARKERS = ['Skip to main content', 'Sign in', 'Help Center', 'View in English'];

const FIELD_ORDER: (keyof GuidelineChunk)[] = [
  'id',
  'source',
  'section',
  'title',
  'url',
  'ruleIds',
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
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

const clamp = (text: string): string =>
  text.length > MAX_EXCERPT_CHARS ? `${text.slice(0, MAX_EXCERPT_CHARS).trimEnd()}\u2026` : text;

const looksLikeChrome = (text: string): boolean =>
  CHROME_MARKERS.some((marker) => text.includes(marker));

// Anchor on the full "<section> <title>" heading (e.g. "3.1.1 In-App Purchase") so a bare
// duplicated section number elsewhere on the page cannot produce a mismatched excerpt.
const extractSection = (chunk: GuidelineChunk, pageText: string): string | undefined => {
  const heading = `${chunk.section} ${chunk.title}`;
  const headingIdx = pageText.indexOf(heading);
  if (headingIdx === -1) return undefined;
  const bodyStart = headingIdx + heading.length;
  return clamp(pageText.slice(bodyStart, bodyStart + MAX_EXCERPT_CHARS).trim());
};

const fetchPage = async (url: string): Promise<string | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`  skip (HTTP ${response.status})`);
      return undefined;
    }
    return await response.text();
  } catch (error: unknown) {
    console.warn(`  skip (fetch failed): ${error instanceof Error ? error.message : error}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

const main = async (): Promise<void> => {
  const chunks = readChunks();
  const refreshable = chunks.filter((chunk) => chunk.url.startsWith(REFRESHABLE_HOST));

  let pageText: string | undefined;
  if (refreshable.length > 0) {
    const html = await fetchPage(`${REFRESHABLE_HOST}/`);
    if (html) pageText = htmlToText(html);
  }

  let updated = 0;
  let skipped = 0;

  for (const chunk of chunks) {
    if (!chunk.url.startsWith(REFRESHABLE_HOST)) {
      skipped += 1;
      continue;
    }
    if (!pageText) {
      console.warn(`  ${chunk.id}: source page unavailable, keeping curated text`);
      continue;
    }

    const excerpt = extractSection(chunk, pageText);
    if (!excerpt || excerpt.length < MIN_ACCEPTABLE_CHARS || looksLikeChrome(excerpt)) {
      console.warn(`  ${chunk.id}: no reliable excerpt, keeping curated text`);
      continue;
    }
    if (excerpt === chunk.text) continue;

    console.log(`  ${chunk.id}: refreshed (${excerpt.length} chars)`);
    chunk.text = excerpt;
    updated += 1;
  }

  writeChunks(chunks);
  console.log(
    `Corpus refresh complete: ${updated} updated, ${skipped} kept (manual-curation source), ` +
      `${chunks.length} total.`,
  );
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
