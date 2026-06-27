import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { mergeClaudeUserConfig } from "../claude-user-config";
import { mergeCodexConfig } from "../codex-config";
import { loadPipelineConfig, type PipelineConfig } from "../config";
import { isRecord } from "../json-config-merge";
import {
  renderClaudeGatewayUserConfig,
  renderCodexGatewayConfig,
} from "../mcp/host-renderers";
import { claudeCodeAdapter } from "./claude-code";
import { opencodeAdapter } from "./opencode";
import {
  type ActiveCommandHost,
  CLAUDE_USER_CONFIG_PATH,
  CODEX_CONFIG_PATH,
  COMMAND_HOSTS,
  type CommandDefinition,
  type CommandHostSelection,
  type CommandInstallPlanItem,
  ENTRYPOINT_PATH_PATTERNS,
  GENERATED_MARKER,
  GENERATED_TS_MARKER,
  GENERATED_YAML_MARKER,
  type HostAdapter,
  INSTALL_HOSTS,
  type InstallAction,
  type InstallCommandsContext,
  type InstallCommandsOptions,
  type InstallHost,
  invocationForHost,
  OWNER_MARKER_PREFIX,
  OWNER_TS_MARKER_PREFIX,
  OWNER_YAML_MARKER_PREFIX,
  resolveHarnessTarget,
} from "./shared";

type DefinitionInstallAction = Exclude<InstallAction, "delete">;
type ExistingContent = { content: string; exists: true } | { exists: false };

export interface InstallPlanWrite {
  action: DefinitionInstallAction;
  block?: CommandDefinition["block"];
  content: string;
  item: CommandInstallPlanItem;
  target: string;
}

export interface InstallPlanDelete {
  item: CommandInstallPlanItem;
  target: string;
}

export interface InstallCommandsPlan {
  deletes: InstallPlanDelete[];
  items: CommandInstallPlanItem[];
  writes: InstallPlanWrite[];
}

const ADAPTERS: Record<ActiveCommandHost, HostAdapter> = {
  opencode: opencodeAdapter,
  "claude-code": claudeCodeAdapter,
};

// AGENTS.md carries repo-scoped guidance (its Qdrant collection is derived from
// the repo dir name) and must never be emitted to the per-machine global dirs
// where it would bake one repo's cwd into a machine-wide file and make
// --check perpetually non-idempotent.
const GLOBAL_EXCLUDED_PATHS = new Set(["AGENTS.md"]);
const GENERATED_CONTENT_MARKERS = [
  GENERATED_MARKER,
  GENERATED_TS_MARKER,
  GENERATED_YAML_MARKER,
] as const;

function definitionsFor(
  host: CommandHostSelection,
  config: PipelineConfig,
  cwd: string
): CommandDefinition[] {
  const hosts = selectedCommandHosts(host);
  const rawDefinitions = hosts.flatMap((name) =>
    ADAPTERS[name].definitions(config, cwd)
  );
  return dedupeDefinitionsByPath([
    ...rawDefinitions,
    ...gatewayHostConfigDefinitions(host, config),
  ]);
}

function dedupeDefinitionsByPath(
  definitions: CommandDefinition[]
): CommandDefinition[] {
  const lastIndexes = new Map<string, number>();
  definitions.forEach((definition, index) => {
    lastIndexes.set(definition.path, index);
  });
  return definitions.filter(
    (definition, index) => lastIndexes.get(definition.path) === index
  );
}

function selectedInstallHosts(host: CommandHostSelection): InstallHost[] {
  return host === "all" ? [...INSTALL_HOSTS] : [host];
}

function isActiveCommandHost(host: InstallHost): host is ActiveCommandHost {
  return host === "opencode" || host === "claude-code";
}

function selectedCommandHosts(host: CommandHostSelection): ActiveCommandHost[] {
  return selectedInstallHosts(host).filter(isActiveCommandHost);
}

function resourceRootsFor(host: ActiveCommandHost): string[] {
  return ADAPTERS[host].resourceRoots;
}

function listFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) {
    return Promise.resolve([]);
  }
  return statSync(root).isFile()
    ? Promise.resolve([root])
    : directoryFiles(root);
}

async function directoryFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const directFiles = entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(root, entry.name));
  const nestedFiles = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => listFiles(join(root, entry.name)))
  );
  return [...directFiles, ...nestedFiles.flat()];
}

function generatedHostFor(content: string): ActiveCommandHost | undefined {
  return COMMAND_HOSTS.find(
    (host) =>
      content.includes(`${OWNER_MARKER_PREFIX}host=${host} -->`) ||
      content.includes(`${OWNER_TS_MARKER_PREFIX}host=${host}`) ||
      content.includes(`${OWNER_YAML_MARKER_PREFIX}host=${host}`)
  );
}

async function obsoleteGeneratedItems(
  host: CommandHostSelection,
  wantedPaths: Set<string>
): Promise<CommandInstallPlanItem[]> {
  const hosts = new Set<ActiveCommandHost>(selectedCommandHosts(host));
  const roots = selectedCommandHosts(host).flatMap((selectedHost) =>
    resourceRootsFor(selectedHost)
  );
  const scanned = await Promise.all(
    roots.map(async (root) => {
      const absRoot = resolveHarnessTarget(root);
      const files = await listFiles(absRoot);
      // Reconstruct the canonical repo-relative path (.opencode/…, .claude/…)
      // from the scanned root so it can be compared against wantedPaths
      // regardless of where the scope rooted the scan.
      return files.map((absolutePath) => ({
        absolutePath,
        path: join(root, relative(absRoot, absolutePath)).replaceAll("\\", "/"),
      }));
    })
  );
  const items = scanned
    .flat()
    .map(({ absolutePath, path }) =>
      obsoleteGeneratedItemForScannedFile({
        absolutePath,
        hosts,
        path,
        wantedPaths,
      })
    )
    .filter((item): item is CommandInstallPlanItem => item !== undefined);
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

function obsoleteGeneratedItemForScannedFile(input: {
  absolutePath: string;
  hosts: Set<ActiveCommandHost>;
  path: string;
  wantedPaths: Set<string>;
}): CommandInstallPlanItem | undefined {
  const generatedHost = obsoleteGeneratedHost(input);
  if (!generatedHost) {
    return;
  }
  return {
    action: "delete",
    host: generatedHost,
    invocation: invocationForHost(
      generatedHost,
      entrypointIdFromGeneratedPath(generatedHost, input.path)
    ),
    path: input.path,
  };
}

function obsoleteGeneratedHost(input: {
  absolutePath: string;
  hosts: Set<ActiveCommandHost>;
  path: string;
  wantedPaths: Set<string>;
}): ActiveCommandHost | undefined {
  if (input.wantedPaths.has(input.path)) {
    return;
  }
  return ownedGeneratedHost(
    readScannedGeneratedFile(input.absolutePath),
    input.hosts
  );
}

function ownedGeneratedHost(
  content: string | undefined,
  hosts: Set<ActiveCommandHost>
): ActiveCommandHost | undefined {
  if (!content) {
    return;
  }
  const generatedHost = generatedHostFor(content);
  if (!(generatedHost && hosts.has(generatedHost))) {
    return;
  }
  return generatedHost;
}

function readScannedGeneratedFile(absolutePath: string): string | undefined {
  // Global scope scans live user config dirs (~/.config/opencode, …); a file
  // that vanished mid-scan or is an unreadable/broken symlink can't be one we
  // generated, so skip it rather than abort the whole install.
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return;
  }
}

function entrypointIdFromGeneratedPath(
  host: ActiveCommandHost,
  path: string
): string | undefined {
  for (const pattern of ENTRYPOINT_PATH_PATTERNS[host]) {
    const match = pattern.exec(path);
    if (match) {
      return match[1];
    }
  }
  return;
}

interface ResolvedCommandDefinitionContent {
  conflict: boolean;
  content: string;
}

type DefinitionMerge = (
  existingContent: string | undefined,
  projectionContent: string
) => ResolvedCommandDefinitionContent;

const CONFIG_MERGES: Record<string, DefinitionMerge> = {
  [CLAUDE_USER_CONFIG_PATH]: (existingContent, projectionContent) => {
    const projection = JSON.parse(projectionContent);
    if (!isRecord(projection)) {
      return { conflict: true, content: projectionContent };
    }
    const merged = mergeClaudeUserConfig(existingContent, projection);
    return merged.ok
      ? { conflict: false, content: merged.content }
      : { conflict: true, content: projectionContent };
  },
  [CODEX_CONFIG_PATH]: (existingContent, projectionContent) => ({
    conflict: false,
    content: mergeCodexConfig(existingContent, projectionContent),
  }),
};

function resolveDefinitionContent(
  definition: CommandDefinition,
  target: string
): ResolvedCommandDefinitionContent {
  const configMerge = CONFIG_MERGES[definition.path];
  if (configMerge) {
    return configMerge(existingContentValue(target), definition.content);
  }
  const existing = existingContent(target);
  if (!existing.exists) {
    return { conflict: false, content: definition.content };
  }
  return resolveAdapterContent(definition, existing.content);
}

function existingContent(target: string): ExistingContent {
  return existsSync(target)
    ? { content: readFileSync(target, "utf8"), exists: true }
    : { exists: false };
}

function existingContentValue(target: string): string | undefined {
  const existing = existingContent(target);
  return existing.exists ? existing.content : undefined;
}

function resolveAdapterContent(
  definition: CommandDefinition,
  existing: string
): ResolvedCommandDefinitionContent {
  const adapter = adapterForDefinition(definition);
  const merge = adapter?.mergeDefinition;
  return merge
    ? applyMergeDefinition(merge.bind(adapter), definition, existing)
    : { conflict: false, content: definition.content };
}

function adapterForDefinition(
  definition: CommandDefinition
): HostAdapter | undefined {
  return isActiveDefinitionHost(definition.host)
    ? ADAPTERS[definition.host]
    : undefined;
}

function isActiveDefinitionHost(
  host: CommandDefinition["host"]
): host is ActiveCommandHost {
  return host === "opencode" || host === "claude-code";
}

function applyMergeDefinition(
  merge: NonNullable<HostAdapter["mergeDefinition"]>,
  definition: CommandDefinition,
  existingContent: string
): ResolvedCommandDefinitionContent {
  const merged = merge(definition, existingContent);
  if (!merged) {
    return { conflict: false, content: definition.content };
  }
  if (!merged.ok) {
    return { conflict: true, content: definition.content };
  }
  return { conflict: false, content: merged.content };
}

function gatewayHostConfigDefinitions(
  host: CommandHostSelection,
  config: PipelineConfig
): CommandDefinition[] {
  if (!config.mcp_gateway) {
    return [];
  }
  return selectedInstallHosts(host).flatMap(
    gatewayHostConfigDefinition(config)
  );
}

function gatewayHostConfigDefinition(
  config: PipelineConfig
): (host: InstallHost) => CommandDefinition[] {
  return (host) => {
    if (host === "claude-code") {
      return [
        {
          content: renderClaudeGatewayUserConfig(config),
          host,
          invocation: invocationForHost(host),
          path: CLAUDE_USER_CONFIG_PATH,
        },
      ];
    }
    if (host === "codex") {
      return [
        {
          content: renderCodexGatewayConfig(config),
          host,
          invocation: "codex",
          path: CODEX_CONFIG_PATH,
        },
      ];
    }
    return [];
  };
}

function actionFor(
  path: string,
  content: string,
  force: boolean,
  block?: CommandDefinition["block"]
): DefinitionInstallAction {
  if (!existsSync(path)) {
    return "create";
  }
  const current = readFileSync(path, "utf8");
  return actionForExistingContent({ block, content, current, force });
}

function actionForExistingContent(input: {
  block?: CommandDefinition["block"];
  content: string;
  current: string;
  force: boolean;
}): DefinitionInstallAction {
  if (input.block) {
    return actionForBlockContent(input.current, input.content);
  }
  if (input.current === input.content) {
    return "unchanged";
  }
  return forceOrGenerated(input.current, input.force) ? "update" : "conflict";
}

function actionForBlockContent(
  current: string,
  content: string
): DefinitionInstallAction {
  return current.includes(content.trimEnd()) ? "unchanged" : "update";
}

function forceOrGenerated(content: string, force: boolean): boolean {
  return (
    force ||
    GENERATED_CONTENT_MARKERS.some((marker) => content.includes(marker))
  );
}

function adapterForcesDefinition(definition: CommandDefinition): boolean {
  if (definition.path in CONFIG_MERGES) {
    return true;
  }
  const fn = adapterForDefinition(definition)?.isAlwaysForced;
  return fn ? fn(definition) : false;
}

function installActionForDefinition(
  definition: CommandDefinition,
  target: string,
  resolved: ResolvedCommandDefinitionContent,
  force: boolean
): DefinitionInstallAction {
  if (resolved.conflict) {
    return "conflict";
  }
  return actionFor(
    target,
    resolved.content,
    force || adapterForcesDefinition(definition),
    definition.block
  );
}

function commandInstallPlanItem(
  definition: CommandDefinition,
  action: DefinitionInstallAction
): CommandInstallPlanItem {
  return {
    action,
    host: definition.host,
    invocation: definition.invocation,
    path: definition.path,
  };
}

function installCommandsContext(
  options: InstallCommandsOptions
): InstallCommandsContext {
  const cwd = options.cwd ?? process.cwd();
  const host = options.host ?? "all";
  const config = loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });
  const definitions = definitionsFor(host, config, cwd).filter(
    (definition) => !GLOBAL_EXCLUDED_PATHS.has(definition.path)
  );
  return {
    cwd,
    definitions,
    host,
    wantedPaths: new Set(definitions.map((definition) => definition.path)),
  };
}

function planDefinition(
  definition: CommandDefinition,
  options: InstallCommandsOptions
): InstallPlanWrite {
  const target = resolveHarnessTarget(definition.path);
  const resolved = resolveDefinitionContent(definition, target);
  const action = installActionForDefinition(
    definition,
    target,
    resolved,
    Boolean(options.force)
  );
  return {
    action,
    block: definition.block,
    content: resolved.content,
    item: commandInstallPlanItem(definition, action),
    target,
  };
}

export async function planInstallCommands(
  options: InstallCommandsOptions = {}
): Promise<InstallCommandsPlan> {
  const context = installCommandsContext(options);
  const writes = context.definitions.map((definition) =>
    planDefinition(definition, options)
  );
  const obsoleteItems = await obsoleteGeneratedItems(
    context.host,
    context.wantedPaths
  );
  return {
    deletes: obsoleteItems.map((item) => ({
      item,
      target: resolveHarnessTarget(item.path),
    })),
    items: [...writes.map((write) => write.item), ...obsoleteItems],
    writes,
  };
}

function actionIsConflict(item: CommandInstallPlanItem): boolean {
  return item.action === "conflict";
}

function actionIsChanged(item: CommandInstallPlanItem): boolean {
  return item.action !== "unchanged";
}

function assertNoInstallConflicts(
  options: InstallCommandsOptions,
  items: CommandInstallPlanItem[]
): void {
  if (options.dryRun) {
    return;
  }
  const conflicts = items.filter(actionIsConflict);
  if (conflicts.length === 0) {
    return;
  }
  throw new Error(
    [
      "Refusing to overwrite manually edited command files.",
      ...conflicts.map((item) => `- ${item.path}`),
      "Re-run with --force to overwrite them.",
    ].join("\n")
  );
}

function assertInstallCheckCurrent(
  options: InstallCommandsOptions,
  items: CommandInstallPlanItem[]
): void {
  if (!options.check) {
    return;
  }
  const changedItems = items.filter(actionIsChanged);
  if (changedItems.length === 0) {
    return;
  }
  throw new Error(
    [
      "Installed command files are not up to date.",
      ...changedItems.map((item) => `- ${item.path}: ${item.action}`),
    ].join("\n")
  );
}

export function assertInstallPlanCurrent(
  options: InstallCommandsOptions,
  plan: InstallCommandsPlan
): void {
  assertNoInstallConflicts(options, plan.items);
  assertInstallCheckCurrent(options, plan.items);
}
