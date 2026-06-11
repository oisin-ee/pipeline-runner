import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import { mergeOpenCodeProjectConfig } from "./opencode-project-config";

const CODEX_MULTI_AUTH_PLUGIN = "oc-codex-multi-auth";
const GLOBAL_CODEX_AUTH_CONFIG_PATH = join(
  homedir(),
  ".opencode/openai-codex-auth-config.json"
);

export type CodexAuthSyncAction = "create" | "error" | "unchanged" | "update";

export interface CodexAuthSyncItem {
  action: CodexAuthSyncAction;
  message?: string;
  path: string;
}

export interface SyncLocalCodexAuthOptions {
  check?: boolean;
  dryRun?: boolean;
  globalConfigPath?: string;
  root: string;
}

export interface SyncLocalCodexAuthResult {
  items: CodexAuthSyncItem[];
  ok: boolean;
}

export function syncLocalCodexAuth(
  options: SyncLocalCodexAuthOptions
): SyncLocalCodexAuthResult {
  const items = [
    syncGlobalPluginConfig(
      options.globalConfigPath ?? GLOBAL_CODEX_AUTH_CONFIG_PATH,
      options
    ),
    ...discoverGitRepositories(options.root).map((repo) =>
      syncProjectOpenCodeConfig(repo, options)
    ),
  ];
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

function syncGlobalPluginConfig(
  path: string,
  options: Pick<SyncLocalCodexAuthOptions, "check" | "dryRun">
): CodexAuthSyncItem {
  const currentText = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const parsed = parseJsonObject(currentText ?? "{}");
  if (!parsed.ok) {
    return { action: "error", message: formatParseErrors(parsed.errors), path };
  }
  const nextText = `${JSON.stringify(
    { ...parsed.value, perProjectAccounts: false },
    null,
    2
  )}\n`;
  return writeIfChanged(path, currentText, nextText, options);
}

function syncProjectOpenCodeConfig(
  repo: string,
  options: Pick<SyncLocalCodexAuthOptions, "check" | "dryRun">
): CodexAuthSyncItem {
  const path = join(repo, ".opencode/opencode.json");
  const currentText = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const merged = mergeOpenCodeProjectConfig(currentText, {
    plugin: [CODEX_MULTI_AUTH_PLUGIN],
  });
  if (!merged.ok) {
    return { action: "error", message: formatParseErrors(merged.errors), path };
  }
  return writeIfChanged(path, currentText, merged.content, options);
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

function parseJsonObject(
  content: string
):
  | { ok: true; value: Record<string, unknown> }
  | { errors: ParseError[]; ok: false } {
  const errors: ParseError[] = [];
  const value = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !isRecord(value)) {
    return { errors, ok: false };
  }
  return { ok: true, value };
}

function formatParseErrors(errors: ParseError[]): string {
  return errors.length > 0
    ? `invalid JSONC (${errors.length} parse error${errors.length === 1 ? "" : "s"})`
    : "expected a JSON object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
