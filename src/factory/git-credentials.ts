import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_GIT_CREDENTIALS_DIR = "/etc/pipeline/git-credentials";

/**
 * copier fetches the (private) momokaya-template by spawning its OWN git
 * subprocess (`git ls-remote` / `clone`, via plumbum). `runAuthenticatedGit`
 * only configures credentials per-invocation with `-c` flags on the git calls
 * the lane makes itself, so copier's git sees no github.com credential and
 * dies `fatal: could not read Username for 'https://github.com'`.
 *
 * This materializes a process-wide github.com credential from the runner's
 * mounted git-credentials (username + PAT under /etc/pipeline/git-credentials)
 * as `GIT_CONFIG_*` env any child (and grandchild) git process inherits, so
 * copier's template fetch authenticates. The token is written to a 0600 store
 * file and referenced by a `credential.helper=store` entry — it never lands in
 * a URL or argv. No mounted credentials (local dev) -> empty env, so git falls
 * back to ambient auth.
 */
export const githubGitCredentialEnv = (
  credentialsDir: string = process.env.PIPELINE_GIT_CREDENTIALS_DIR ??
    DEFAULT_GIT_CREDENTIALS_DIR
): Record<string, string> => {
  const usernamePath = resolve(credentialsDir, "username");
  const passwordPath = resolve(credentialsDir, "password");
  if (!(existsSync(usernamePath) && existsSync(passwordPath))) {
    return {};
  }
  const username = readFileSync(usernamePath, "utf-8").trim();
  const password = readFileSync(passwordPath, "utf-8").trim();
  const storePath = join(
    mkdtempSync(join(tmpdir(), "factory-git-cred-")),
    ".git-credentials"
  );
  writeFileSync(
    storePath,
    `https://${encodeURIComponent(username)}:${encodeURIComponent(password)}@github.com\n`,
    { mode: 0o600 }
  );
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: `store --file=${storePath}`,
    GIT_TERMINAL_PROMPT: "0",
  };
};
