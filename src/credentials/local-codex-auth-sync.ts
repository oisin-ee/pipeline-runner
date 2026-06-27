import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Point each local dev repo's opencode openai provider at the central
 * CLIProxyAPI broker. codex + opencode authenticate through the broker
 * (which owns OAuth refresh / rotation / failover), so there is no per-project
 * account pool to declare.
 */
export function syncLocalCodexAuth(
  options: SyncLocalCodexAuthOptions
): SyncLocalCodexAuthResult {
  const broker =
    options.broker === undefined ? resolveBrokerCredentials() : options.broker;
  return broker
    ? syncLocalCodexAuthWithBroker(options, broker)
    : brokerRequiredResult(options.root);
}

function brokerRequiredResult(root: string): SyncLocalCodexAuthResult {
  return {
    items: [
      {
        action: "error",
        message:
          "BROKER_API_KEY is required: codex + opencode authenticate through the central CLIProxyAPI broker.",
        path: root,
      },
    ],
    ok: false,
  };
}

function syncLocalCodexAuthWithBroker(
  options: SyncLocalCodexAuthOptions,
  broker: BrokerCredentials
): SyncLocalCodexAuthResult {
  const items = discoverGitRepositories(options.root).map((repo) =>
    syncProjectBrokerConfig(repo, broker, options)
  );
  const hasRequiredChanges = items.some(
    (item) => item.action === "create" || item.action === "update"
  );
  const hasErrors = items.some((item) => item.action === "error");
  const checkFailed = options.check === true && hasRequiredChanges;
  return { items, ok: !(hasErrors || checkFailed) };
}

export function formatCodexAuthSyncResult(
  result: SyncLocalCodexAuthResult
): string {
  const lines = result.items.map((item) => {
    const suffix = item.message ? `: ${item.message}` : "";
    return `${item.action} ${item.path}${suffix}`;
  });
  if (!result.ok) {
    lines.push("codex-auth sync-local check failed");
  }
  return lines.join("\n");
}

function syncProjectBrokerConfig(
  repo: string,
  broker: BrokerCredentials,
  options: Pick<SyncLocalCodexAuthOptions, "check" | "dryRun">
): CodexAuthSyncItem {
  const path = join(repo, ".opencode/opencode.json");
  const currentText = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const result = applyOpencodeBrokerProvider(currentText, broker);
  if ("error" in result) {
    return { action: "error", message: result.error, path };
  }
  return writeIfChanged(path, currentText, result.content, options);
}

function writeIfChanged(
  path: string,
  currentText: string | undefined,
  nextText: string,
  options: Pick<SyncLocalCodexAuthOptions, "check" | "dryRun">
): CodexAuthSyncItem {
  const action = changedAction(currentText, nextText);
  if (action === "unchanged") {
    return { action: "unchanged", path };
  }
  if (writesEnabled(options)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, nextText);
  }
  return { action, path };
}

function changedAction(
  currentText: string | undefined,
  nextText: string
): Exclude<CodexAuthSyncAction, "error"> {
  if (currentText === nextText) {
    return "unchanged";
  }
  return currentText === undefined ? "create" : "update";
}

function writesEnabled(
  options: Pick<SyncLocalCodexAuthOptions, "check" | "dryRun">
): boolean {
  return !(options.check || options.dryRun);
}

function discoverGitRepositories(root: string): string[] {
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => isDirectory(path) && existsSync(join(path, ".git")))
    .sort((a, b) => a.localeCompare(b));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
