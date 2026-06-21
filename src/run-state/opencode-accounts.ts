import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/*
 * The oc-codex-multi-auth plugin rotates the OAuth refresh token on every
 * refresh and persists the new token by atomically rewriting its accounts file
 * (temp file + rename over the target). Mounting the accounts secret read-only
 * DIRECTLY at the plugin's path makes that rename fail, so the plugin can never
 * persist a rotated token: every refresh replays the stale token from the secret
 * and the provider answers 401 ("Token refresh failed: 401"), which the runner
 * surfaces as an opaque session failure on every model.
 *
 * Fix: mount the secret read-only at a staging path and copy it to the writable
 * plugin path once at runner startup. The plugin then owns a normal writable
 * file and can persist rotated tokens for the pod's lifetime.
 */
export const OPENCODE_OPENAI_ACCOUNTS_STAGING_DIR =
  "/etc/pipeline/opencode-openai-accounts";
const STAGED_ACCOUNTS_FILE = join(
  OPENCODE_OPENAI_ACCOUNTS_STAGING_DIR,
  "accounts.json"
);
const ACCOUNTS_FILE_NAME = "oc-codex-multi-auth-accounts.json";

export interface PrepareOpencodeAccountsOptions {
  destPath?: string;
  stagedPath?: string;
}

/**
 * Copy the staged codex-multi-auth accounts secret to the writable plugin path
 * so the plugin can persist rotated tokens. A no-op (copied: false) when no
 * staged secret is mounted — local dev, tests, and configs without the accounts
 * secret keep whatever account store already exists.
 */
export function prepareOpencodeAccounts(
  options: PrepareOpencodeAccountsOptions = {}
): { copied: boolean } {
  const stagedPath = options.stagedPath ?? STAGED_ACCOUNTS_FILE;
  if (!existsSync(stagedPath)) {
    return { copied: false };
  }
  const destPath =
    options.destPath ?? join(homedir(), ".opencode", ACCOUNTS_FILE_NAME);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(stagedPath, destPath);
  chmodSync(destPath, 0o600);
  return { copied: true };
}
