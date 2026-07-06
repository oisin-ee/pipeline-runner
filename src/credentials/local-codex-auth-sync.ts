import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BrokerCredentials } from "./broker";
import { resolveBrokerCredentials } from "./broker";
import { applyOpencodeBrokerProvider } from "./opencode-config";

export type CodexAuthSyncAction = "create" | "error" | "unchanged" | "update";

export interface CodexAuthSyncItem {
  action: CodexAuthSyncAction;
  message?: string;
  path: string;
}

export interface SyncLocalCodexAuthOptions {
  /**
   * Test override: resolved broker credentials. When omitted, resolved from the
   * environment.
   */
  broker?: BrokerCredentials;
  check?: boolean;
  dryRun?: boolean;
  root: string;
}

export interface SyncLocalCodexAuthResult {
  items: CodexAuthSyncItem[];
  ok: boolean;
}

type CurrentProjectConfig = { content: string; kind: "present" } | { kind: "missing" };

const brokerRequiredResult = (root: string): SyncLocalCodexAuthResult => ({
  items: [
    {
      action: "error",
      message: "BROKER_API_KEY is required: codex + opencode authenticate through the central CLIProxyAPI broker.",
      path: root,
    },
  ],
  ok: false,
});

export const formatCodexAuthSyncResult = (result: SyncLocalCodexAuthResult): string => {
  const lines = result.items.map((item) => {
    const suffix = item.message !== undefined && item.message !== "" ? `: ${item.message}` : "";
    return `${item.action} ${item.path}${suffix}`;
  });
  if (!result.ok) {
    lines.push("codex-auth sync-local check failed");
  }
  return lines.join("\n");
};

const changedAction = (currentText: CurrentProjectConfig, nextText: string): Exclude<CodexAuthSyncAction, "error"> => {
  if (currentText.kind === "present" && currentText.content === nextText) {
    return "unchanged";
  }
  return currentText.kind === "missing" ? "create" : "update";
};

const writesEnabled = (options: Pick<SyncLocalCodexAuthOptions, "check" | "dryRun">): boolean =>
  !(options.check === true || options.dryRun === true);

const writeIfChanged = (
  path: string,
  currentText: CurrentProjectConfig,
  nextText: string,
  options: Pick<SyncLocalCodexAuthOptions, "check" | "dryRun">,
): CodexAuthSyncItem => {
  const action = changedAction(currentText, nextText);
  if (action === "unchanged") {
    return { action: "unchanged", path };
  }
  if (writesEnabled(options)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, nextText);
  }
  return { action, path };
};

const syncProjectBrokerConfig = (
  repo: string,
  broker: BrokerCredentials,
  options: Pick<SyncLocalCodexAuthOptions, "check" | "dryRun">,
): CodexAuthSyncItem => {
  const path = join(repo, ".opencode/opencode.json");
  const currentText = existsSync(path)
    ? { content: readFileSync(path, "utf-8"), kind: "present" as const }
    : { kind: "missing" as const };
  const result =
    currentText.kind === "present"
      ? applyOpencodeBrokerProvider(currentText.content, broker)
      : applyOpencodeBrokerProvider(undefined, broker);
  if ("error" in result) {
    return { action: "error", message: result.error, path };
  }
  return writeIfChanged(path, currentText, result.content, options);
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const discoverGitRepositories = (root: string): string[] =>
  readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => isDirectory(path) && existsSync(join(path, ".git")))
    .toSorted((a, b) => a.localeCompare(b));

const syncLocalCodexAuthWithBroker = (
  options: SyncLocalCodexAuthOptions,
  broker: BrokerCredentials,
): SyncLocalCodexAuthResult => {
  const items = discoverGitRepositories(options.root).map((repo) => syncProjectBrokerConfig(repo, broker, options));
  const hasRequiredChanges = items.some((item) => item.action === "create" || item.action === "update");
  const hasErrors = items.some((item) => item.action === "error");
  const checkFailed = options.check === true && hasRequiredChanges;
  return { items, ok: !(hasErrors || checkFailed) };
};

/**
 * Point each local dev repo's opencode openai provider at the central
 * CLIProxyAPI broker. codex + opencode authenticate through the broker
 * (which owns OAuth refresh / rotation / failover), so there is no per-project
 * account pool to declare.
 */
export const syncLocalCodexAuth = (options: SyncLocalCodexAuthOptions): SyncLocalCodexAuthResult => {
  const broker = options.broker ?? resolveBrokerCredentials();
  return broker === undefined ? brokerRequiredResult(options.root) : syncLocalCodexAuthWithBroker(options, broker);
};
