import { CORPUS_VERSION } from './corpus.ts';
import { requireEnv } from './env.ts';
import { githubRequest } from './github.ts';

const BODY = [
  'Automated refresh of `src/corpus/guidelines.jsonl` from official Apple / Google sources.',
  '',
  'Review jobs also scrape ephemerally at runtime; this workflow persists updates into the',
  'default branch so a scrape outage cannot silently downgrade a review.',
  '',
  'Adapters used by `ingestGuidelines.ts`:',
  '- Apple App Store Review Guidelines (HTML section extract)',
  '- Apple DocC (`/tutorials/data/documentation/...json`)',
  '- Apple support / marketing pages (`<main>` HTML)',
  '- Google Play Help Center (answer body HTML)',
  '- Android Developers (`.devsite-article-body`, `?hl=en`)',
  '',
  `Extraction is heuristic — review the diff for accuracy and bump \`CORPUS_VERSION\` (currently \`${CORPUS_VERSION}\`) in \`src/corpus.ts\` before merging.`,
].join('\n');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const main = async (): Promise<void> => {
  const token = requireEnv('GITHUB_TOKEN');
  const repo = requireEnv('GITHUB_REPOSITORY');
  const head = requireEnv('CORPUS_BRANCH');
  const base = requireEnv('CORPUS_BASE');

  try {
    const created = await githubRequest(token, 'POST', `/repos/${repo}/pulls`, {
      title: 'chore(corpus): refresh guideline corpus',
      head,
      base,
      body: BODY,
    });
    const url = isRecord(created) && typeof created.html_url === 'string' ? created.html_url : '';
    console.log(`Opened refresh PR: ${url}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // A pull request for this branch already exists, which is the normal outcome of a
    // same-day re-run: the force push already updated it.
    if (message.includes('A pull request already exists')) {
      console.log(`Refresh PR for ${head} already exists; the force push updated it.`);
      return;
    }
    throw error;
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
