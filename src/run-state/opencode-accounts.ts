import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isRecord } from "../safe-json";

/*
 * The oc-codex-multi-auth plugin keeps two writable credential files:
 *   - its account pool (oc-codex-multi-auth-accounts.json), rewritten on token
 *     rotation, and
 *   - opencode's host auth store (~/.local/share/opencode/auth.json), whose
 *     `openai` entry is the token opencode/the plugin actually use.
 * Both rewrite via atomic write / writeFile. Mounting either secret read-only
 * DIRECTLY at its live path makes that write fail, so the plugin can never
 * publish a fresh token: opencode keeps the stale token from the mount and the
 * provider answers 401 ("Token refresh failed: 401") on every model.
 *
 * Fix: mount each secret read-only at a staging dir and copy it to its writable
 * live path once at runner startup. Then ALSO sync the active account's token
 * from the pool into auth.json's openai entry — the plugin only backfills a
 * MISSING host entry (index.js: `if (hasExistingOAuth) return`), NOT an expired
 * one, so a stale openai token mounted in auth.json would otherwise be used as-is
 * and force a refresh on a rotated refresh token (the observed 401). Writing the
 * pool's current token keeps the host entry consistent with the account pool.
 */
export const OPENCODE_OPENAI_ACCOUNTS_STAGING_DIR =
  "/etc/pipeline/opencode-openai-accounts";
export const OPENCODE_AUTH_STAGING_DIR = "/etc/pipeline/opencode-auth";

const ACCOUNTS_FILE_NAME = "oc-codex-multi-auth-accounts.json";
const AUTH_FILE_NAME = "auth.json";
const HOST_OPENAI_PROVIDER = "openai";

interface WritableCredentialFile {
  /** Writable destination, as path segments under $HOME. */
  destFromHome: string[];
  /** Read-only staged source (the secret mount). */
  stagedPath: string;
}

const WRITABLE_OPENCODE_CREDENTIAL_FILES: WritableCredentialFile[] = [
  {
    destFromHome: [".opencode", ACCOUNTS_FILE_NAME],
    stagedPath: join(OPENCODE_OPENAI_ACCOUNTS_STAGING_DIR, "accounts.json"),
  },
  {
    destFromHome: [".local", "share", "opencode", AUTH_FILE_NAME],
    stagedPath: join(OPENCODE_AUTH_STAGING_DIR, AUTH_FILE_NAME),
  },
];

export interface PrepareOpencodeCredentialsOptions {
  /** Test override: explicit (stagedPath -> destPath) pairs. */
  files?: Array<{ destPath: string; stagedPath: string }>;
}

export interface PrepareOpencodeCredentialsResult {
  copied: string[];
  hostOpenaiTokenSynced: boolean;
}

/**
 * Copy each staged opencode credential secret to its writable live path, then
 * sync the account pool's active openai token into auth.json's openai entry.
 * Only files whose staged source exists are copied (local dev / tests / configs
 * without a given secret keep whatever store is already present).
 */
export function prepareOpencodeCredentials(
  options: PrepareOpencodeCredentialsOptions = {}
): PrepareOpencodeCredentialsResult {
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
  const accountsPath = files.find(
    (file) => basename(file.destPath) === ACCOUNTS_FILE_NAME
  )?.destPath;
  const authPath = files.find(
    (file) => basename(file.destPath) === AUTH_FILE_NAME
  )?.destPath;
  const hostOpenaiTokenSynced =
    accountsPath !== undefined &&
    authPath !== undefined &&
    syncHostOpenaiToken(accountsPath, authPath);
  return { copied, hostOpenaiTokenSynced };
}

interface OAuthToken {
  access: string;
  expires: number;
  refresh: string;
}

function activeAccountOAuth(accountsRaw: unknown): OAuthToken | undefined {
  if (!isRecord(accountsRaw)) {
    return;
  }
  const accounts = accountsRaw.accounts;
  if (!Array.isArray(accounts)) {
    return;
  }
  const account = accounts[activeAccountIndex(accountsRaw)] ?? accounts[0];
  return isRecord(account) ? oauthFromAccount(account) : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function oauthFromAccount(
  account: Record<string, unknown>
): OAuthToken | undefined {
  const { accessToken, refreshToken, expiresAt } = account;
  if (
    nonEmptyString(accessToken) &&
    nonEmptyString(refreshToken) &&
    typeof expiresAt === "number"
  ) {
    return { access: accessToken, expires: expiresAt, refresh: refreshToken };
  }
  return;
}

// Mirror the plugin's host backfill, which resolves the codex-family active
// account (index.js: resolveActiveIndex(storage, "codex")), falling back to the
// global active index.
function activeAccountIndex(accountsRaw: Record<string, unknown>): number {
  const byFamily = accountsRaw.activeIndexByFamily;
  if (isRecord(byFamily) && typeof byFamily.codex === "number") {
    return byFamily.codex;
  }
  return typeof accountsRaw.activeIndex === "number"
    ? accountsRaw.activeIndex
    : 0;
}

function syncHostOpenaiToken(accountsPath: string, authPath: string): boolean {
  if (!(existsSync(accountsPath) && existsSync(authPath))) {
    return false;
  }
  const token = activeAccountOAuth(
    JSON.parse(readFileSync(accountsPath, "utf8"))
  );
  if (!token) {
    return false;
  }
  const auth = JSON.parse(readFileSync(authPath, "utf8"));
  if (!isRecord(auth)) {
    return false;
  }
  const next = {
    ...auth,
    [HOST_OPENAI_PROVIDER]: {
      access: token.access,
      expires: token.expires,
      refresh: token.refresh,
      type: "oauth",
    },
  };
  writeFileSync(authPath, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  return true;
}
