import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/*
 * The oc-codex-multi-auth plugin keeps two writable credential files:
 *   - its account pool (oc-codex-multi-auth-accounts.json), rewritten on token
 *     rotation, and
 *   - opencode's host auth store (~/.local/share/opencode/auth.json), into which
 *     it backfills the ACTIVE account's current openai token — this is the token
 *     opencode actually sends.
 * Both rewrite via atomic write / writeFile. Mounting either secret read-only
 * DIRECTLY at its live path makes that write fail, so the plugin can never
 * publish a fresh token: opencode keeps sending the stale token from the mount
 * and the provider answers 401 ("Token refresh failed: 401") on every model.
 *
 * Fix: mount each secret read-only at a staging dir and copy it to its writable
 * live path once at runner startup. The plugin then owns normal writable files
 * and can persist rotations + backfill the fresh token for the pod's lifetime.
 */
export const OPENCODE_OPENAI_ACCOUNTS_STAGING_DIR =
  "/etc/pipeline/opencode-openai-accounts";
export const OPENCODE_AUTH_STAGING_DIR = "/etc/pipeline/opencode-auth";

interface WritableCredentialFile {
  /** Writable destination, as path segments under $HOME. */
  destFromHome: string[];
  /** Read-only staged source (the secret mount). */
  stagedPath: string;
}

const WRITABLE_OPENCODE_CREDENTIAL_FILES: WritableCredentialFile[] = [
  {
    destFromHome: [".opencode", "oc-codex-multi-auth-accounts.json"],
    stagedPath: join(OPENCODE_OPENAI_ACCOUNTS_STAGING_DIR, "accounts.json"),
  },
  {
    destFromHome: [".local", "share", "opencode", "auth.json"],
    stagedPath: join(OPENCODE_AUTH_STAGING_DIR, "auth.json"),
  },
];

export interface PrepareOpencodeCredentialsOptions {
  /** Test override: explicit (stagedPath -> destPath) pairs. */
  files?: Array<{ destPath: string; stagedPath: string }>;
}

/**
 * Copy each staged opencode credential secret to its writable live path so the
 * plugin can rewrite tokens. Only files whose staged source exists are copied
 * (local dev / tests / configs without a given secret keep whatever store is
 * already present). Returns the basenames copied, for run-log evidence.
 */
export function prepareOpencodeCredentials(
  options: PrepareOpencodeCredentialsOptions = {}
): { copied: string[] } {
  const home = homedir();
  const files =
    options.files ??
    WRITABLE_OPENCODE_CREDENTIAL_FILES.map((file) => ({
      destPath: join(home, ...file.destFromHome),
      stagedPath: file.stagedPath,
    }));
  const copied: string[] = [];
  for (const { stagedPath, destPath } of files) {
    if (!existsSync(stagedPath)) {
      continue;
    }
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(stagedPath, destPath);
    chmodSync(destPath, 0o600);
    copied.push(basename(destPath));
  }
  return { copied };
}
