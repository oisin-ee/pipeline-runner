import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import * as Arr from "effect/Array";
import type { Option } from "effect/Option";
import { isNone, isSome, none, some } from "effect/Option";
import * as Schema from "effect/Schema";

import { mergeClaudeUserConfig } from "../claude-user-config";
import { mergeCodexConfig } from "../codex-config";
import { loadPipelineConfig } from "../config";
import type { PipelineConfig } from "../config";
import {
  renderClaudeGatewayUserConfig,
  renderCodexGatewayConfig,
} from "../mcp/host-renderers";
import { parseJson } from "../safe-json";
import { parseWithSchema, struct } from "../schema-boundary";
import { claudeCodeAdapter } from "./claude-code";
import { opencodeAdapter } from "./opencode";
import {
  CLAUDE_USER_CONFIG_PATH,
  CODEX_CONFIG_PATH,
  COMMAND_HOSTS,
  ENTRYPOINT_PATH_PATTERNS,
  GENERATED_MARKER,
  GENERATED_TS_MARKER,
  GENERATED_YAML_MARKER,
  INSTALL_HOSTS,
  invocationForHost,
  OWNER_MARKER_PREFIX,
  OWNER_TS_MARKER_PREFIX,
  OWNER_YAML_MARKER_PREFIX,
  resolveHarnessTarget,
} from "./shared";
import type {
  ActiveCommandHost,
  CommandDefinition,
  CommandHostSelection,
  CommandInstallPlanItem,
  HostAdapter,
  InstallAction,
  InstallCommandsContext,
  InstallCommandsOptions,
  InstallHost,
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
  "claude-code": claudeCodeAdapter,
  opencode: opencodeAdapter,
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

const dedupeDefinitionsByPath = (
  definitions: CommandDefinition[]
): CommandDefinition[] => {
  const lastIndexes = Arr.reduce(
    definitions,
    new Map<string, number>(),
    (indexes, definition, index) => indexes.set(definition.path, index)
  );
  return definitions.filter(
    (definition, index) => lastIndexes.get(definition.path) === index
  );
};

const selectedInstallHosts = (host: CommandHostSelection): InstallHost[] =>
  host === "all" ? [...INSTALL_HOSTS] : [host];

const isActiveCommandHost = (host: InstallHost): host is ActiveCommandHost =>
  host === "opencode" || host === "claude-code";

const selectedCommandHosts = (
  host: CommandHostSelection
): ActiveCommandHost[] =>
  selectedInstallHosts(host).filter(isActiveCommandHost);

const resourceRootsFor = (host: ActiveCommandHost): string[] =>
  ADAPTERS[host].resourceRoots;

const listFiles = async function listFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) {
    return [];
  }
  if (statSync(root).isFile()) {
    return await Promise.resolve([root]);
  }
  const entries = await readdir(root, { withFileTypes: true });
  const directFiles = entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(root, entry.name));
  const nestedFiles = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => await listFiles(join(root, entry.name)))
  );
  return [...directFiles, ...nestedFiles.flat()];
};

const generatedHostFor = (content: string): Option<ActiveCommandHost> => {
  const host = COMMAND_HOSTS.find(
    (candidateHost) =>
      content.includes(`${OWNER_MARKER_PREFIX}host=${candidateHost} -->`) ||
      content.includes(`${OWNER_TS_MARKER_PREFIX}host=${candidateHost}`) ||
      content.includes(`${OWNER_YAML_MARKER_PREFIX}host=${candidateHost}`)
  );
  return host === undefined ? none() : some(host);
};

const ownedGeneratedHost = (
  content: Option<string>,
  hosts: Set<ActiveCommandHost>
): Option<ActiveCommandHost> => {
  if (isNone(content)) {
    return none();
  }
  const generatedHost = generatedHostFor(content.value);
  if (isNone(generatedHost) || !hosts.has(generatedHost.value)) {
    return none();
  }
  return generatedHost;
};

const readScannedGeneratedFile = (absolutePath: string): Option<string> => {
  // Global scope scans live user config dirs (~/.config/opencode, …); a file
  // that vanished mid-scan or is an unreadable/broken symlink can't be one we
  // generated, so skip it rather than abort the whole install.
  try {
    return some(readFileSync(absolutePath, "utf-8"));
  } catch {
    return none();
  }
};

const obsoleteGeneratedHost = (input: {
  absolutePath: string;
  hosts: Set<ActiveCommandHost>;
  path: string;
  wantedPaths: Set<string>;
}): Option<ActiveCommandHost> => {
  if (input.wantedPaths.has(input.path)) {
    return none();
  }
  return ownedGeneratedHost(
    readScannedGeneratedFile(input.absolutePath),
    input.hosts
  );
};

const entrypointIdFromGeneratedPath = (
  host: ActiveCommandHost,
  path: string
): Option<string> => {
  for (const pattern of ENTRYPOINT_PATH_PATTERNS[host]) {
    const match = pattern.exec(path);
    if (match !== null) {
      return some(match[1]);
    }
  }
  return none();
};

const obsoleteGeneratedItemForScannedFile = (input: {
  absolutePath: string;
  hosts: Set<ActiveCommandHost>;
  path: string;
  wantedPaths: Set<string>;
}): Option<CommandInstallPlanItem> => {
  const generatedHost = obsoleteGeneratedHost(input);
  if (isNone(generatedHost)) {
    return none();
  }
  const entrypointId = entrypointIdFromGeneratedPath(
    generatedHost.value,
    input.path
  );
  return some({
    action: "delete",
    host: generatedHost.value,
    invocation: invocationForHost(
      generatedHost.value,
      isSome(entrypointId) ? entrypointId.value : "execute"
    ),
    path: input.path,
  });
};

const obsoleteGeneratedItems = async (
  host: CommandHostSelection,
  wantedPaths: Set<string>
): Promise<CommandInstallPlanItem[]> => {
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
    .filter(isSome)
    .map((item) => item.value);
  return items.toSorted((a, b) => a.path.localeCompare(b.path));
};

interface ResolvedCommandDefinitionContent {
  conflict: boolean;
  content: string;
}

type DefinitionMerge = (
  existingContent: string,
  projectionContent: string
) => ResolvedCommandDefinitionContent;

const claudeUserConfigProjectionSchema = struct({
  mcpServers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const parseClaudeUserConfigProjection = (source: string) =>
  parseWithSchema(
    claudeUserConfigProjectionSchema,
    parseJson(source, "Claude user config projection")
  );

const CONFIG_MERGES: Partial<Record<string, DefinitionMerge>> = {
  [CLAUDE_USER_CONFIG_PATH]: (currentContent, projectionContent) => {
    const projection = parseClaudeUserConfigProjection(projectionContent);
    const merged = mergeClaudeUserConfig(projection, currentContent);
    return merged.ok
      ? { conflict: false, content: merged.content }
      : { conflict: true, content: projectionContent };
  },
  [CODEX_CONFIG_PATH]: (currentContent, projectionContent) => ({
    conflict: false,
    content: mergeCodexConfig(currentContent, projectionContent),
  }),
};

const existingContent = (target: string): ExistingContent =>
  existsSync(target)
    ? { content: readFileSync(target, "utf-8"), exists: true }
    : { exists: false };

const existingContentValue = (target: string): string => {
  const existing = existingContent(target);
  return existing.exists ? existing.content : "";
};

const isActiveDefinitionHost = (
  host: CommandDefinition["host"]
): host is ActiveCommandHost => host === "opencode" || host === "claude-code";

const adapterForDefinition = (
  definition: CommandDefinition
): Option<HostAdapter> =>
  isActiveDefinitionHost(definition.host)
    ? some(ADAPTERS[definition.host])
    : none();

const applyMergeDefinition = (
  merge: NonNullable<HostAdapter["mergeDefinition"]>,
  definition: CommandDefinition,
  currentContent: string
): ResolvedCommandDefinitionContent => {
  const merged = merge(definition, currentContent);
  if (isNone(merged)) {
    return { conflict: false, content: definition.content };
  }
  if (!merged.value.ok) {
    return { conflict: true, content: definition.content };
  }
  return { conflict: false, content: merged.value.content };
};

const resolveAdapterContent = (
  definition: CommandDefinition,
  existing: string
): ResolvedCommandDefinitionContent => {
  const adapter = adapterForDefinition(definition);
  if (isNone(adapter)) {
    return { conflict: false, content: definition.content };
  }
  return adapter.value.mergeDefinition === undefined
    ? { conflict: false, content: definition.content }
    : applyMergeDefinition(
        (definitionToMerge, currentContent) =>
          adapter.value.mergeDefinition?.(definitionToMerge, currentContent) ??
          none(),
        definition,
        existing
      );
};

const resolveDefinitionContent = (
  definition: CommandDefinition,
  target: string
): ResolvedCommandDefinitionContent => {
  const configMerge = CONFIG_MERGES[definition.path];
  if (configMerge !== undefined) {
    return configMerge(existingContentValue(target), definition.content);
  }
  const existing = existingContent(target);
  if (!existing.exists) {
    return { conflict: false, content: definition.content };
  }
  return resolveAdapterContent(definition, existing.content);
};

const gatewayHostConfigDefinition =
  (config: PipelineConfig): ((host: InstallHost) => CommandDefinition[]) =>
  (host) => {
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

const gatewayHostConfigDefinitions = (
  host: CommandHostSelection,
  config: PipelineConfig
): CommandDefinition[] => {
  if (config.mcp_gateway === undefined) {
    return [];
  }
  return selectedInstallHosts(host).flatMap(
    gatewayHostConfigDefinition(config)
  );
};

const definitionsFor = (
  host: CommandHostSelection,
  config: PipelineConfig,
  cwd: string
): CommandDefinition[] => {
  const hosts = selectedCommandHosts(host);
  const rawDefinitions = hosts.flatMap((name) =>
    ADAPTERS[name].definitions(config, cwd)
  );
  return dedupeDefinitionsByPath([
    ...rawDefinitions,
    ...gatewayHostConfigDefinitions(host, config),
  ]);
};

const actionForBlockContent = (
  current: string,
  content: string
): DefinitionInstallAction =>
  current.includes(content.trimEnd()) ? "unchanged" : "update";

const forceOrGenerated = (content: string, force: boolean): boolean =>
  force || GENERATED_CONTENT_MARKERS.some((marker) => content.includes(marker));

const actionForExistingContent = (input: {
  block?: CommandDefinition["block"];
  content: string;
  current: string;
  force: boolean;
}): DefinitionInstallAction => {
  if (input.block) {
    return actionForBlockContent(input.current, input.content);
  }
  if (input.current === input.content) {
    return "unchanged";
  }
  return forceOrGenerated(input.current, input.force) ? "update" : "conflict";
};

const actionFor = (
  path: string,
  content: string,
  force: boolean,
  block?: CommandDefinition["block"]
): DefinitionInstallAction => {
  if (!existsSync(path)) {
    return "create";
  }
  const current = readFileSync(path, "utf-8");
  return actionForExistingContent({ block, content, current, force });
};

const adapterForcesDefinition = (definition: CommandDefinition): boolean => {
  if (definition.path in CONFIG_MERGES) {
    return true;
  }
  const adapter = adapterForDefinition(definition);
  if (isNone(adapter)) {
    return false;
  }
  return adapter.value.isAlwaysForced === undefined
    ? false
    : adapter.value.isAlwaysForced(definition);
};

const installActionForDefinition = (
  definition: CommandDefinition,
  target: string,
  resolved: ResolvedCommandDefinitionContent,
  force: boolean
): DefinitionInstallAction => {
  if (resolved.conflict) {
    return "conflict";
  }
  return actionFor(
    target,
    resolved.content,
    force || adapterForcesDefinition(definition),
    definition.block
  );
};

const commandInstallPlanItem = (
  definition: CommandDefinition,
  action: DefinitionInstallAction
): CommandInstallPlanItem => ({
  action,
  host: definition.host,
  invocation: definition.invocation,
  path: definition.path,
});

const installCommandsContext = (
  options: InstallCommandsOptions
): InstallCommandsContext => {
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
};

const planDefinition = (
  definition: CommandDefinition,
  options: InstallCommandsOptions
): InstallPlanWrite => {
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
};

export const planInstallCommands = async (
  options: InstallCommandsOptions = {}
): Promise<InstallCommandsPlan> => {
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
};

const actionIsConflict = (item: CommandInstallPlanItem): boolean =>
  item.action === "conflict";

const actionIsChanged = (item: CommandInstallPlanItem): boolean =>
  item.action !== "unchanged";

const assertNoInstallConflicts = (
  options: InstallCommandsOptions,
  items: CommandInstallPlanItem[]
): void => {
  if (options.dryRun === true) {
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
};

const assertInstallCheckCurrent = (
  options: InstallCommandsOptions,
  items: CommandInstallPlanItem[]
): void => {
  if (options.check !== true) {
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
};

export const assertInstallPlanCurrent = (
  options: InstallCommandsOptions,
  plan: InstallCommandsPlan
): void => {
  assertNoInstallConflicts(options, plan.items);
  assertInstallCheckCurrent(options, plan.items);
};
