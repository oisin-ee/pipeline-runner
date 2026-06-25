import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  applyOpencodeBrokerProvider,
  type BrokerCredentials,
  resolveBrokerCredentials,
} from "./broker-auth";

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
 * multi-auth account pool to declare. Requires BROKER_API_KEY in the env (or an
 * explicit `broker` override).
 */
export function syncLocalCodexAuth(
  options: SyncLocalCodexAuthOptions
): SyncLocalCodexAuthResult {
  const broker =
    options.broker === undefined ? resolveBrokerCredentials() : options.broker;
  if (!broker) {
    return {
      items: [
        {
          action: "error",
          message:
            "BROKER_API_KEY is required: codex + opencode authenticate through the central CLIProxyAPI broker.",
          path: options.root,
        },
      ],
      ok: false,
    };
  }
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
  if (currentText === nextText) {
    return { action: "unchanged", path };
  }
  const action = currentText === undefined ? "create" : "update";
  if (!(options.check || options.dryRun)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, nextText);
  }
  return { action, path };
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
