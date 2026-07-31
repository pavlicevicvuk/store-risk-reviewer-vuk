const API_BASE = (): string => process.env.GITHUB_API_URL || 'https://api.github.com';

const PAGE_SIZE = 100;

// GitHub rejects issue comment bodies and check-run summaries over 65536 characters. A long
// findings list can realistically approach that, so clamp with a visible notice.
const MAX_BODY_CHARS = 65000;

export const truncateForGitHub = (body: string): string =>
  body.length <= MAX_BODY_CHARS
    ? body
    : `${body.slice(0, MAX_BODY_CHARS)}\n\n_Report truncated to fit GitHub's comment size limit._\n`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const githubRequest = async (
  token: string,
  method: string,
  path: string,
  body: unknown,
): Promise<unknown> => {
  const response = await fetch(`${API_BASE()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'store-risk-reviewer',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }
  if (!text) return null;
  return JSON.parse(text);
};

export type IssueComment = { id: number; body: string };

const toComment = (value: unknown): IssueComment | undefined => {
  if (!isRecord(value)) return undefined;
  const { id, body } = value;
  if (typeof id !== 'number') return undefined;
  return { id, body: typeof body === 'string' ? body : '' };
};

export const listIssueComments = async (
  token: string,
  repo: string,
  issueNumber: number,
): Promise<IssueComment[]> => {
  const comments: IssueComment[] = [];
  for (let page = 1; ; page += 1) {
    const payload = await githubRequest(
      token,
      'GET',
      `/repos/${repo}/issues/${issueNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`,
      undefined,
    );
    if (!Array.isArray(payload)) break;
    for (const entry of payload) {
      const comment = toComment(entry);
      if (comment) comments.push(comment);
    }
    if (payload.length < PAGE_SIZE) break;
  }
  return comments;
};

export const upsertMarkerComment = async (
  token: string,
  repo: string,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<'created' | 'updated'> => {
  const clamped = truncateForGitHub(body);
  const comments = await listIssueComments(token, repo, issueNumber);
  const existing = comments.filter((comment) => comment.body.includes(marker)).pop();

  if (existing) {
    await githubRequest(token, 'PATCH', `/repos/${repo}/issues/comments/${existing.id}`, {
      body: clamped,
    });
    return 'updated';
  }
  await githubRequest(token, 'POST', `/repos/${repo}/issues/${issueNumber}/comments`, {
    body: clamped,
  });
  return 'created';
};

export type CheckConclusion = 'success' | 'neutral' | 'failure';

export const createCheckRun = async (
  token: string,
  repo: string,
  headSha: string,
  name: string,
  conclusion: CheckConclusion,
  title: string,
  summary: string,
): Promise<void> => {
  await githubRequest(token, 'POST', `/repos/${repo}/check-runs`, {
    name,
    head_sha: headSha,
    status: 'completed',
    conclusion,
    output: { title, summary: truncateForGitHub(summary) },
  });
};
