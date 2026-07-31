// The reviewer runs against a checkout of the target repository, which lives somewhere
// other than this repo's own checkout. Every module that touches the target tree (git,
// the agent's working directory) resolves it through here.
export const getRepoRoot = (): string => process.env.AI_REVIEW_REPO_ROOT || process.cwd();

export const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};
