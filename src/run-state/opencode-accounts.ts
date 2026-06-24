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
import {
  applyCodexBrokerProvider,
  applyOpencodeBrokerProvider,
  type BrokerCredentials,
  renderOpencodeBrokerAuthJson,
  resolveBrokerCredentials,
} from "../broker-auth";
import { resolveHarnessTarget } from "../install-commands/shared";
import { isRecord } from "../safe-json";

/*
 * Runner credential preparation for codex + opencode.
 *
 * BROKER MODE (BROKER_API_KEY in env): codex and opencode authenticate through
 * the central CLIProxyAPI broker. The runner writes the broker provider into
 * codex's config.toml, points opencode's openai provider baseURL at the broker,
 * writes the broker api-key into opencode's auth.json, and SKIPS the bespoke
 * multi-auth account-pool staging entirely. The broker owns OAuth refresh /
 * rotation / failover, so none of the rotated-token staging dance below applies.
 *
 * LEGACY MODE (no BROKER_API_KEY — local dev / non-broker fallback): the older
 * oc-codex-multi-auth pool path. The plugin keeps two writable credential files:
 *   - its account pool (oc-codex-multi-auth-accounts.json), rewritten on token
 *     rotation, and
 *   - opencode's host auth store (~/.local/share/opencode/auth.json), whose
 *     `openai` entry is the token opencode/the plugin actually use.
 * Both rewrite via atomic write / writeFile. Mounting either secret read-only
 * DIRECTLY at its live path makes that write fail, so the plugin can never
 * publish a fresh token: opencode keeps the stale token from the mount and the
 * provider answers 401 ("Token refresh failed: 401") on every model. So each
 * secret is mounted read-only at a staging dir and copied to its writable live
 * path once at runner startup, and the active account's token is synced from the
 * pool into auth.json's openai entry.
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
  /**
   * Test override: resolved broker credentials. When omitted, resolved from the
   * environment. Pass `null` to force legacy mode regardless of the env.
   */
  broker?: BrokerCredentials | null;
  /** Test override: destination paths for the broker config writers. */
  brokerPaths?: BrokerConfigPaths;
  /** Test override: explicit (stagedPath -> destPath) pairs. */
  files?: Array<{ destPath: string; stagedPath: string }>;
}

export interface PrepareOpencodeCredentialsResult {
  /** Auth/config files written by broker mode (basenames). */
  brokerConfigured: string[];
  /** Legacy: staged credential files copied to their writable live path. */
  copied: string[];
  /** Legacy: whether the pool's openai token was synced into auth.json. */
  hostOpenaiTokenSynced: boolean;
}

interface BrokerConfigPaths {
  codexConfigPath: string;
  opencodeAuthPath: string;
  opencodeConfigPath: string;
}

/**
 * Prepare codex + opencode runner credentials. In broker mode, writes the
 * broker provider config and api-key and skips the legacy pool staging. In
 * legacy mode, copies each staged secret to its writable live path and syncs
 * the pool's active openai token into auth.json.
 */
export function prepareOpencodeCredentials(
  options: PrepareOpencodeCredentialsOptions = {}
): PrepareOpencodeCredentialsResult {
  const broker =
    options.broker === undefined ? resolveBrokerCredentials() : options.broker;
  if (broker) {
    return {
      brokerConfigured: configureBrokerCredentials(broker, options.brokerPaths),
      copied: [],
      hostOpenaiTokenSynced: false,
    };
  }
  return { brokerConfigured: [], ...prepareLegacyPoolCredentials(options) };
}

function defaultBrokerConfigPaths(): BrokerConfigPaths {
  return {
    // resolveHarnessTarget honors CODEX_HOME / OPENCODE_CONFIG_DIR so the same
    // writers target the right dirs in the runner, in tests, and locally.
    codexConfigPath: resolveHarnessTarget(".codex/config.toml"),
    opencodeAuthPath: join(
      homedir(),
      ".local",
      "share",
      "opencode",
      AUTH_FILE_NAME
    ),
    opencodeConfigPath: resolveHarnessTarget(".opencode/opencode.json"),
  };
}

function configureBrokerCredentials(
  broker: BrokerCredentials,
  pathsOverride?: BrokerConfigPaths
): string[] {
  const paths = pathsOverride ?? defaultBrokerConfigPaths();
  const configured: string[] = [];

  writeFileEnsured(
    paths.opencodeAuthPath,
    renderOpencodeBrokerAuthJson(broker),
    0o600
  );
  configured.push(basename(paths.opencodeAuthPath));

  writeFileEnsured(
    paths.codexConfigPath,
    applyCodexBrokerProvider(readIfExists(paths.codexConfigPath), broker)
  );
  configured.push(basename(paths.codexConfigPath));

  const opencodeConfig = applyOpencodeBrokerProvider(
    readIfExists(paths.opencodeConfigPath),
    broker
  );
  if ("error" in opencodeConfig) {
    throw new Error(
      `Cannot configure opencode broker provider: ${opencodeConfig.error}`
    );
  }
  writeFileEnsured(paths.opencodeConfigPath, opencodeConfig.content);
  configured.push(basename(paths.opencodeConfigPath));

  return configured;
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function writeFileEnsured(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
}

function prepareLegacyPoolCredentials(
  options: PrepareOpencodeCredentialsOptions
): Omit<PrepareOpencodeCredentialsResult, "brokerConfigured"> {
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
