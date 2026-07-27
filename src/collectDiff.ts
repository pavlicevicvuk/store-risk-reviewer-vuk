import { execFileSync } from 'node:child_process';

import type { DiffFile } from './types.ts';

const MAX_BUFFER = 128 * 1024 * 1024;

const runGit = (args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAX_BUFFER });

// Content-addressed id of the file at the reviewed head; drives per-file cache reuse. Returns
// '' when git cannot resolve it (e.g. rename edge cases) so the caller treats the file as
// uncacheable rather than keying on a bogus value.
const resolveBlobSha = (headRef: string, path: string): string => {
  try {
    return runGit(['rev-parse', `${headRef}:${path}`]).trim();
  } catch {
    return '';
  }
};

const parseNameStatusLine = (line: string): { status: string; path: string } | undefined => {
  const parts = line.split('\t').filter((part) => part.length > 0);
  if (parts.length < 2) return undefined;
  const status = parts[0] ?? '';
  const path = parts[parts.length - 1] ?? '';
  if (!status || !path) return undefined;
  return { status, path };
};

export const collectDiff = (baseRef: string, headRef: string): DiffFile[] => {
  const range = `${baseRef}...${headRef}`;
  const nameStatus = runGit(['diff', '--name-status', range]).trim();
  if (!nameStatus) return [];

  const files: DiffFile[] = [];
  for (const line of nameStatus.split('\n')) {
    const parsed = parseNameStatusLine(line);
    if (!parsed) continue;
    if (parsed.status.startsWith('D')) continue;
    const patch = runGit(['diff', range, '--', parsed.path]);
    if (!patch.trim()) continue;
    files.push({
      path: parsed.path,
      status: parsed.status,
      patch,
      blobSha: resolveBlobSha(headRef, parsed.path),
    });
  }
  return files;
};
