import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Finding } from './types.ts';
import { toFindings } from './validate.ts';

const CACHE_DIR = process.env.AI_REVIEW_CACHE_DIR || '.ai-review-cache';

export const cacheKey = (parts: string[]): string => {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\u0000');
  }
  return hash.digest('hex');
};

const isCachePayload = (value: unknown): value is { findings: unknown } =>
  typeof value === 'object' && value !== null && 'findings' in value;

export const readCache = (key: string, fallbackFile: string): Finding[] | undefined => {
  const file = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isCachePayload(parsed)) return undefined;
    return toFindings(parsed.findings, fallbackFile);
  } catch {
    return undefined;
  }
};

export const writeCache = (key: string, findings: Finding[]): void => {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify({ findings }));
};
