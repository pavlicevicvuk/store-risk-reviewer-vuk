/**
 * Webhook forwarder for the Store Risk Reviewer GitHub App.
 *
 * A GitHub App cannot start a workflow on its own, so this worker is the smallest possible
 * bridge: verify the webhook came from GitHub, decide whether the pull request is worth
 * reviewing, and turn it into a repository_dispatch on the reviewer repo. All the actual
 * review work happens in Actions.
 */

export type Env = {
  GITHUB_APP_ID: string;
  // PKCS#8 PEM. GitHub issues PKCS#1, so convert once:
  //   openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  REVIEWER_REPO: string;
  TARGET_REPO: string;
  BASE_BRANCH: string;
};

const REVIEWED_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'labeled']);
const DISPATCH_EVENT = 'pr_review';
const API_BASE = 'https://api.github.com';
const USER_AGENT = 'store-risk-reviewer-forwarder';

const encoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hexToBytes = (hex: string): Uint8Array | undefined => {
  if (hex.length === 0 || hex.length % 2 !== 0) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) return undefined;
    bytes[index] = byte;
  }
  return bytes;
};

// crypto.subtle.verify is constant-time, which is why we verify rather than recompute and
// string-compare the digest.
export const verifySignature = async (
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> => {
  if (!header?.startsWith('sha256=')) return false;
  const signature = hexToBytes(header.slice('sha256='.length));
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(body));
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const importPrivateKey = async (pem: string): Promise<CryptoKey> => {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const raw = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    raw,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
};

const createAppJwt = async (appId: string, privateKeyPem: string): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  // Backdate iat to tolerate clock drift between the edge and GitHub; exp must be <= 10 min.
  const payload = base64Url(
    encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })),
  );
  const unsigned = `${header}.${payload}`;
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
};

// Least privilege: this token exists only to create one dispatch on the reviewer repo, which
// GitHub gates behind contents:write.
const createInstallationToken = async (
  jwt: string,
  installationId: number,
  reviewerRepo: string,
): Promise<string> => {
  const repoName = reviewerRepo.split('/')[1] ?? reviewerRepo;
  const response = await fetch(`${API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({
      repositories: [repoName],
      permissions: { contents: 'write', metadata: 'read' },
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Could not mint installation token (${response.status}): ${text.slice(0, 300)}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed.token !== 'string') {
    throw new Error('Installation token response did not contain a token.');
  }
  return parsed.token;
};

const dispatch = async (
  token: string,
  reviewerRepo: string,
  prNumber: number,
): Promise<void> => {
  const response = await fetch(`${API_BASE}/repos/${reviewerRepo}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    // Only the pull request number travels: the workflow re-reads everything else from the
    // API so a replayed or tampered dispatch cannot redirect the run.
    body: JSON.stringify({ event_type: DISPATCH_EVENT, client_payload: { pr: prNumber } }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dispatch failed (${response.status}): ${text.slice(0, 300)}`);
  }
};

export type WebhookFacts = {
  action: string;
  repo: string;
  baseRef: string;
  prNumber: number;
  installationId: number;
  labelName: string;
};

export const readWebhook = (payload: unknown): WebhookFacts | undefined => {
  if (!isRecord(payload)) return undefined;
  const { action, repository, pull_request: pullRequest, installation, label } = payload;
  if (typeof action !== 'string' || !isRecord(repository) || !isRecord(pullRequest)) {
    return undefined;
  }
  const base = pullRequest.base;
  if (!isRecord(base)) return undefined;

  const prNumber = pullRequest.number;
  const installationId = isRecord(installation) ? installation.id : undefined;
  if (typeof prNumber !== 'number' || typeof installationId !== 'number') return undefined;

  return {
    action,
    repo: typeof repository.full_name === 'string' ? repository.full_name : '',
    baseRef: typeof base.ref === 'string' ? base.ref : '',
    prNumber,
    installationId,
    labelName: isRecord(label) && typeof label.name === 'string' ? label.name : '',
  };
};

export const shouldForward = (
  facts: WebhookFacts,
  targetRepo: string,
  baseBranch: string,
): { forward: boolean; reason: string } => {
  if (facts.repo !== targetRepo) {
    return { forward: false, reason: `repository ${facts.repo} is not ${targetRepo}` };
  }
  if (!REVIEWED_ACTIONS.has(facts.action)) {
    return { forward: false, reason: `action ${facts.action} is not reviewed` };
  }
  // "labeled" only matters as the approval path for fork pull requests; the workflow makes
  // the final call once it has read the labels from the API.
  if (facts.action === 'labeled' && !facts.labelName.startsWith('ai-review')) {
    return { forward: false, reason: `label ${facts.labelName} is unrelated` };
  }
  if (facts.baseRef !== baseBranch) {
    return { forward: false, reason: `base branch ${facts.baseRef} is not ${baseBranch}` };
  }
  return { forward: true, reason: 'ok' };
};

const accepted = (message: string): Response =>
  new Response(`${message}\n`, { status: 202, headers: { 'content-type': 'text/plain' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed\n', { status: 405 });
    }

    const body = await request.text();
    if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) {
      return new Response('Invalid signature\n', { status: 401 });
    }

    if (request.headers.get('x-github-event') !== 'pull_request') {
      return accepted('Ignored: not a pull_request event');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response('Malformed JSON\n', { status: 400 });
    }

    const facts = readWebhook(payload);
    if (!facts) return accepted('Ignored: unrecognised payload shape');

    const decision = shouldForward(facts, env.TARGET_REPO, env.BASE_BRANCH);
    if (!decision.forward) return accepted(`Ignored: ${decision.reason}`);

    const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    const token = await createInstallationToken(jwt, facts.installationId, env.REVIEWER_REPO);
    await dispatch(token, env.REVIEWER_REPO, facts.prNumber);

    return accepted(`Dispatched review for pull request #${facts.prNumber}`);
  },
};
