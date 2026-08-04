# Setup

One-time steps to get reviews flowing into `Trainerize/ReactNativeApp`. Work through the
sections in order; the last one verifies the whole chain.

## 1. Register the GitHub App

Create it under the **Trainerize organization**, not a personal account:
Organization settings -> Developer settings -> GitHub Apps -> New GitHub App.

| Field | Value |
| --- | --- |
| Name | Store Risk Reviewer |
| Homepage URL | The `store-risk-reviewer` repo URL |
| Webhook | Active |
| Webhook URL | The worker URL from step 3 (placeholder is fine for now) |
| Webhook secret | A fresh random string; keep it |
| Where can it be installed | Only on this account |

Repository permissions:

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read & write | Read to clone the target; write is what GitHub requires to create a `repository_dispatch` |
| Pull requests | Read & write | Read PR facts, upsert the report comment |
| Checks | Write | Publish the check run on the head commit |
| Metadata | Read | Mandatory for every App |

Subscribe to events: **Pull request**.

Contents write looks broader than it should be, and it is only there for the dispatch call.
Tokens are downscoped per use, so nothing that touches the target repo can push. See
[Security model](#security-model).

After creating the App:

1. Note the **App ID**.
2. Generate a **private key** and download the `.pem`.
3. Install the App on exactly two repositories: `ReactNativeApp` and `store-risk-reviewer`.
   One installation covers both because they share an owner, and installation tokens are
   scoped to a single owner.

## 2. Add repository configuration

In `store-risk-reviewer` -> Settings -> Secrets and variables -> Actions:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `REVIEWER_APP_ID` | The App ID |
| Variable | `AI_REVIEW_MODEL` | Optional model override, e.g. `composer-2.5` |
| Secret | `REVIEWER_APP_PRIVATE_KEY` | Full contents of the downloaded `.pem` |
| Secret | `CURSOR_API_KEY` | Cursor API key used for agent calls |

## 3. Choose how pull requests start a review

A GitHub App webhook cannot start Actions by itself. Pick **one** of the paths below.

### 3a. Caller workflow in the target repo (no Cloudflare)

Add a thin workflow in the repository under review that calls this repo's reusable
workflow on `pull_request`. Example (adjust the `uses:` owner/repo if yours differs):

```yaml
name: Store risk review
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled]
    branches: [reactDev]
permissions:
  contents: read
  pull-requests: write
  checks: write
concurrency:
  group: store-risk-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    uses: OWNER/store-risk-reviewer/.github/workflows/pr-review.yml@main
    with:
      pr: ${{ github.event.pull_request.number }}
      auth: github_token          # or github_app if the App is installed here
      target_repo: ${{ github.repository }}
      app_repository: ${{ github.event.repository.name }}
    secrets:
      CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
      REVIEWER_APP_PRIVATE_KEY: ${{ secrets.REVIEWER_APP_PRIVATE_KEY }}
```

In the **target** repo, set secret `CURSOR_API_KEY` (and App secrets/vars if
`auth: github_app`). In this reviewer repo, open
Settings → Actions → General → Access and allow the target repository to use
reusable workflows.

With this path you can leave the App webhook inactive and skip the worker.

### 3b. Deploy the Cloudflare forwarder (App webhook path)

GitHub Apps deliver webhooks but cannot start a workflow, so the worker converts the
webhook into a `repository_dispatch`.

The private key needs converting first. GitHub issues PKCS#1, and WebCrypto only imports
PKCS#8:

```bash
openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
```

Set the App ID in [`worker/wrangler.toml`](../worker/wrangler.toml), then deploy:

```bash
cd worker
npm ci
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste app.pkcs8.pem
npx wrangler secret put GITHUB_WEBHOOK_SECRET    # the secret from step 1
npx wrangler deploy
```

Copy the deployed URL back into the App's **Webhook URL** field.

## 4. Verify

Work up from the pieces that need no webhook.

**Selftests, no credentials needed:**

```bash
npm ci && npm run selftest && npm run typecheck
cd worker && npm ci && node --experimental-strip-types src/selftest.ts && npx tsc --noEmit
```

**A real review without the webhook.** `workflow_dispatch` takes a PR number directly, which
exercises token minting, cloning, the agent, and comment posting:

```bash
gh workflow run pr-review.yml -f pr=1234
```

`repository_dispatch` only fires for workflow files on the **default branch**, so this is also
the only way to test changes on a branch. Merge to `main` before expecting webhooks to work.

**The webhook path.** Open or push to a pull request against `reactDev` in the target repo,
then check the App's **Advanced -> Recent Deliveries** tab. A forwarded delivery answers
`202 Dispatched review for pull request #N`; a filtered one answers `202 Ignored: <reason>`,
which is a success, not a failure. If a delivery returns 401, the webhook secret in the App
and in `wrangler secret` disagree.

## Security model

The review job checks out pull request head code in a job that holds `CURSOR_API_KEY` and an
App token. That is the same privilege shape as `pull_request_target`, and the agent reading
attacker-controlled files is a prompt-injection surface even in read-only `ask` mode. Four
things contain it:

1. **Forks need human approval.** `decide()` in [`src/resolvePr.ts`](../src/resolvePr.ts)
   refuses any pull request whose head repo differs from its base repo unless a maintainer
   applied `ai-review:approved`.
2. **Tokens are downscoped per use.** On the App path, the workflow mints a token limited to
   the target repo with `contents: read`, so the review path cannot push. The worker (if used)
   mints a separate token limited to `store-risk-reviewer` purely for the dispatch. On the
   caller-workflow path with `auth: github_token`, the job uses the caller's `GITHUB_TOKEN`
   with write limited to pull requests and checks.
3. **Dispatch / call payloads are not trusted.** Only a PR number crosses the boundary; every
   SHA, branch, and label is re-read from the API inside the workflow.
4. **Reviewer code always comes from this repo's pinned ref** (`github.workflow_sha`), never
   from the pull request under review.

Both gates are covered by the selftests, so a regression in either fails CI rather than
quietly opening the door.

## Operational notes

- **Cost.** Every qualifying push runs the agent and bills the Cursor account. `concurrency`
  with `cancel-in-progress` means a rapid series of pushes only pays for the last one.
- **Corpus refresh.** `corpus-refresh.yml` runs monthly and opens a PR when the scraped
  guidelines change. Extraction is heuristic, so review the diff and bump `CORPUS_VERSION` in
  `src/corpus.ts` before merging. Reviews also scrape at runtime and fall back to the
  checked-in corpus when a source is unreachable.
- **Changing the base branch or target repo.** Edit `reviewer.config.json` and the matching
  `[vars]` in `worker/wrangler.toml`; the worker filters on base branch before dispatching, so
  both need to agree.
