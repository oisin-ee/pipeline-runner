import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { loadPipelineConfig, type PipelineConfig } from "./config";
import { claudeCodeAdapter } from "./install-commands/claude-code";
import { opencodeAdapter } from "./install-commands/opencode";
import {
  type ActiveCommandHost,
  COMMAND_HOSTS,
  type CommandDefinition,
  type CommandHostSelection,
  type CommandInstallPlanItem,
  ENTRYPOINT_PATH_PATTERNS,
  GENERATED_MARKER,
  GENERATED_TS_MARKER,
  GENERATED_YAML_MARKER,
  type HostAdapter,
  type InstallAction,
  type InstallCommandsContext,
  type InstallCommandsOptions,
  type InstallCommandsResult,
  invocationForHost,
  OWNER_MARKER_PREFIX,
  OWNER_TS_MARKER_PREFIX,
  OWNER_YAML_MARKER_PREFIX,
  resolveHarnessTarget,
} from "./install-commands/shared";

export type {
  CommandHostSelection,
  InstallCommandsOptions,
  InstallCommandsResult,
} from "./install-commands/shared";

const ADAPTERS: Record<ActiveCommandHost, HostAdapter> = {
  opencode: opencodeAdapter,
  "claude-code": claudeCodeAdapter,
};

function definitionsFor(
  host: CommandHostSelection,
  config: PipelineConfig,
  cwd: string
): CommandDefinition[] {
  const hosts = host === "all" ? COMMAND_HOSTS : [host];
  const rawDefinitions = hosts.flatMap((name) =>
    ADAPTERS[name].definitions(config, cwd)
  );
  return dedupeDefinitionsByPath(rawDefinitions);
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

function selectedHosts(host: CommandHostSelection): ActiveCommandHost[] {
  return host === "all" ? [...COMMAND_HOSTS] : [host];
}

function resourceRootsFor(host: ActiveCommandHost): string[] {
  return ADAPTERS[host].resourceRoots;
}

async function listFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) {
    return [];
  }
  if (statSync(root).isFile()) {
    return [root];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return listFiles(path);
      }
      return [path];
    })
  );
  return files.flat();
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
  const hosts = new Set<ActiveCommandHost>(selectedHosts(host));
  const roots = selectedHosts(host).flatMap((selectedHost) =>
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
  return scanned
    .flat()
    .flatMap(({ absolutePath, path }) => {
      // Global scope scans live user config dirs (~/.config/opencode, …); a
      // file that vanished mid-scan or is an unreadable/broken symlink can't be
      // one we generated, so skip it rather than abort the whole install.
      let content: string;
      try {
        content = readFileSync(absolutePath, "utf8");
      } catch {
        return [];
      }
      const generatedHost = generatedHostFor(content);
      if (!(generatedHost && hosts.has(generatedHost))) {
        return [];
      }
      if (wantedPaths.has(path)) {
        return [];
      }
      return [
        {
          action: "delete" as const,
          host: generatedHost,
          invocation: invocationForHost(
            generatedHost,
            entrypointIdFromGeneratedPath(generatedHost, path)
          ),
          path,
        },
      ];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
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

function resolveDefinitionContent(
  definition: CommandDefinition,
  target: string
): ResolvedCommandDefinitionContent {
  const adapter = ADAPTERS[definition.host as ActiveCommandHost] as
    | HostAdapter
    | undefined;
  if (!(adapter?.mergeDefinition && existsSync(target))) {
    return { conflict: false, content: definition.content };
  }
  return applyMergeDefinition(
    adapter.mergeDefinition.bind(adapter),
    definition,
    target
  );
}

function applyMergeDefinition(
  merge: NonNullable<HostAdapter["mergeDefinition"]>,
  definition: CommandDefinition,
  target: string
): ResolvedCommandDefinitionContent {
  const merged = merge(definition, readFileSync(target, "utf8"));
  if (!merged) {
    return { conflict: false, content: definition.content };
  }
  if (!merged.ok) {
    return { conflict: true, content: definition.content };
  }
  return { conflict: false, content: merged.content };
}

function actionFor(
  path: string,
  content: string,
  force: boolean,
  block?: CommandDefinition["block"]
): InstallAction {
  if (!existsSync(path)) {
    return "create";
  }
  const current = readFileSync(path, "utf8");
  if (block) {
    if (current.includes(content.trimEnd())) {
      return "unchanged";
    }
    return "update";
  }
  if (current === content) {
    return "unchanged";
  }
  if (
    !(
      current.includes(GENERATED_MARKER) ||
      current.includes(GENERATED_TS_MARKER) ||
      current.includes(GENERATED_YAML_MARKER) ||
      force
    )
  ) {
    return "conflict";
  }
  return "update";
}

function upsertGeneratedBlock(
  current: string,
  content: string,
  block: NonNullable<CommandDefinition["block"]>
): string {
  const startIndex = current.indexOf(block.start);
  const endIndex = current.indexOf(block.end);
  if (startIndex >= 0 && endIndex >= startIndex) {
    const afterEnd = endIndex + block.end.length;
    const lineEnd = current.indexOf("\n", afterEnd);
    const replaceEnd = lineEnd >= 0 ? lineEnd + 1 : afterEnd;
    return `${current.slice(0, startIndex)}${content}${current.slice(replaceEnd)}`;
  }
  const separator = current.trimEnd().length > 0 ? "\n\n" : "";
  return `${current.trimEnd()}${separator}${content}`;
}

function adapterForcesDefinition(definition: CommandDefinition): boolean {
  const fn = ADAPTERS[definition.host as ActiveCommandHost]?.isAlwaysForced;
  return fn ? fn(definition) : false;
}

function installActionForDefinition(
  definition: CommandDefinition,
  target: string,
  resolved: ResolvedCommandDefinitionContent,
  force: boolean
): InstallAction {
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

async function writeDefinition(
  definition: CommandDefinition,
  target: string,
  content: string
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  if (definition.block && existsSync(target)) {
    await writeFile(
      target,
      upsertGeneratedBlock(
        readFileSync(target, "utf8"),
        content,
        definition.block
      )
    );
    return;
  }
  await writeFile(target, content);
}

function shouldSkipInstallWrite(
  options: InstallCommandsOptions,
  action: InstallAction
): boolean {
  return Boolean(
    options.check ||
      options.dryRun ||
      action === "unchanged" ||
      action === "conflict"
  );
}

async function installDefinition(
  definition: CommandDefinition,
  options: InstallCommandsOptions
): Promise<CommandInstallPlanItem> {
  const target = resolveHarnessTarget(definition.path);
  const resolved = resolveDefinitionContent(definition, target);
  const action = installActionForDefinition(
    definition,
    target,
    resolved,
    Boolean(options.force)
  );
  const item = commandInstallPlanItem(definition, action);
  if (!shouldSkipInstallWrite(options, action)) {
    await writeDefinition(definition, target, resolved.content);
  }
  return item;
}

function commandInstallPlanItem(
  definition: CommandDefinition,
  action: InstallAction
): CommandInstallPlanItem {
  return {
    action,
    host: definition.host,
    invocation: definition.invocation,
    path: definition.path,
  };
}

// AGENTS.md carries repo-scoped guidance (its Qdrant collection is derived from
// the repo dir name) and must never be emitted to the per-machine global dirs
// where it would bake one repo's cwd into a machine-wide file and make
// --check perpetually non-idempotent.
const GLOBAL_EXCLUDED_PATHS = new Set(["AGENTS.md"]);

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

async function installDefinitions(
  definitions: CommandDefinition[],
  options: InstallCommandsOptions
): Promise<CommandInstallPlanItem[]> {
  const items: CommandInstallPlanItem[] = [];
  for (const definition of definitions) {
    items.push(await installDefinition(definition, options));
  }
  return items;
}

function shouldRemoveObsoleteItems(options: InstallCommandsOptions): boolean {
  return !(options.check || options.dryRun);
}

async function removeObsoleteItems(
  items: CommandInstallPlanItem[],
  options: InstallCommandsOptions
): Promise<void> {
  if (!shouldRemoveObsoleteItems(options)) {
    return;
  }
  for (const item of items) {
    await rm(resolveHarnessTarget(item.path), { force: true });
  }
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

export async function installCommands(
  options: InstallCommandsOptions = {}
): Promise<InstallCommandsResult> {
  const context = installCommandsContext(options);
  const items = await installDefinitions(context.definitions, options);
  const obsoleteItems = await obsoleteGeneratedItems(
    context.host,
    context.wantedPaths
  );
  items.push(...obsoleteItems);
  await removeObsoleteItems(obsoleteItems, options);
  assertNoInstallConflicts(options, items);
  assertInstallCheckCurrent(options, items);
  return { items };
}

export function parseCommandHost(
  value: string | undefined
): CommandHostSelection {
  const host = value ?? "all";
  if (host === "all" || COMMAND_HOSTS.includes(host as ActiveCommandHost)) {
    return host as CommandHostSelection;
  }
  throw new Error(
    `Unsupported host "${host}". Supported values: all, ${COMMAND_HOSTS.join(", ")}.`
  );
}

export function formatInstallCommandsResult(
  result: InstallCommandsResult
): string {
  return result.items
    .map(
      (item) => `${item.action} ${item.host}: ${item.path} (${item.invocation})`
    )
    .join("\n");
}
