import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_VERSION = '2026-07-29.1';

export type GuidelineChunk = {
  id: string;
  source: 'apple' | 'google';
  section: string;
  title: string;
  url: string;
  ruleIds: string[];
  text: string;
};

const CORPUS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'corpus', 'guidelines.jsonl');

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isChunk = (value: unknown): value is GuidelineChunk => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    (record.source === 'apple' || record.source === 'google') &&
    typeof record.section === 'string' &&
    typeof record.title === 'string' &&
    typeof record.url === 'string' &&
    typeof record.text === 'string' &&
    isStringArray(record.ruleIds)
  );
};

let cache: GuidelineChunk[] | undefined;

export const clearCorpusCache = (): void => {
  cache = undefined;
};

export const loadCorpus = (): GuidelineChunk[] => {
  if (cache) return cache;
  let raw = '';
  try {
    raw = readFileSync(CORPUS_PATH, 'utf8');
  } catch {
    cache = [];
    return cache;
  }
  const chunks: GuidelineChunk[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isChunk(parsed)) chunks.push(parsed);
    } catch {
      // Skip malformed lines so one bad entry can't break the run.
    }
  }
  cache = chunks;
  return cache;
};

export const getExcerptsForRule = (ruleId: string): GuidelineChunk[] =>
  loadCorpus().filter((chunk) => chunk.ruleIds.includes(ruleId));

const SOURCE_LABEL: Record<GuidelineChunk['source'], string> = {
  apple: 'Apple App Store Review',
  google: 'Google Play',
};

// Just the official Apple/Google guideline excerpts, with none of the curated rule pack.
export const serializeGuidelinesForPrompt = (): string =>
  loadCorpus()
    .map((chunk) =>
      [
        `- [${chunk.id}] (${SOURCE_LABEL[chunk.source]} ${chunk.section}) ${chunk.title}`,
        `  Guideline: ${chunk.text}`,
        `  Source: ${chunk.url}`,
      ].join('\n'),
    )
    .join('\n');
