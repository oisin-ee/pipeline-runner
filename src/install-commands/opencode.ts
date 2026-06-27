// fallow-ignore-file complexity
import { basename } from "node:path";
import { Effect } from "effect";
import matter from "gray-matter";
import {
  DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST,
  type OpenCodeEcosystemManifest,
  type PipelineConfig,
} from "../config";
import { renderOpenCodeGatewayConfig } from "../mcp/host-renderers";
import { mergeOpenCodeProjectConfig } from "../opencode-project-config";
import { resolvePackageAssetPath } from "../package-assets";
import { compileWorkflowPlan } from "../planning/compile";
import { opencodeAgentName } from "../runtime/opencode-agent-name";
import { protectedPermissionOverlay } from "../runtime/protected-paths/protected-paths";
import {
  RepoIoService,
  runRepoIoSync,
} from "../runtime/services/repo-io-service";
import {
  type ActiveCommandHost,
  AGENTS_MD_END,
  AGENTS_MD_START,
  COMMAND_HOSTS,
  type CommandDefinition,
  commandIdForHost,
  compactLines,
  entrypointDescription,
  entrypointEntries,
  GENERATED_MARKER,
  GENERATED_TS_MARKER,
  type HostAdapter,
  instructionsPointer,
  invocationForHost,
  type MergeDefinitionResult,
  OPENCODE_PROJECT_CONFIG_PATH,
  OWNER_MARKER_PREFIX,
  OWNER_TS_MARKER_PREFIX,
  type ProfileEntry,
  profileEntries,
  SINGLE_OPENCODE_PLUGIN_ARRAY_RE,
} from "./shared";

const OPENCODE_ORCHESTRATOR_AGENT_ID = "MoKa Orchestrator";
type ActorConfig = PipelineConfig["profiles"][string];
type EcosystemCode = OpenCodeEcosystemManifest["ecosystem_code"][number];

interface OpencodePermissionOptions {
  allowedTaskAgents?: string[];
}

type DispatchKind = "cli" | "native-model-agent" | "native-named-agent";

export interface AgentDispatchRoute {
  kind: DispatchKind;
  model?: string;
  nativeAgentId?: string;
  needs: string[];
  nodeId: string;
  profile: PipelineConfig["profiles"][string];
  profileId: string;
  runnerId: string;
}

export function header(host: ActiveCommandHost): string {
  return [GENERATED_MARKER, `${OWNER_MARKER_PREFIX}host=${host} -->`, ""].join(
    "\n"
  );
}

export function markdown(data: Record<string, unknown>, body: string): string {
  return `${matter.stringify(body.trimEnd(), data).trimEnd()}\n`;
}

function entrypointCommandDefinitions(
  _host: ActiveCommandHost,
  config: PipelineConfig,
  makeDefinition: (
    id: string,
    entrypoint: PipelineConfig["entrypoints"][string]
  ) => CommandDefinition
): CommandDefinition[] {
  return entrypointEntries(config).map(([id, entrypoint]) =>
    makeDefinition(id, entrypoint)
  );
}

function nativeProfileEntries(
  host: ActiveCommandHost,
  config: PipelineConfig
): ProfileEntry[] {
  return profileEntries(config).filter(
    ([id, profile]) =>
      id !== config.orchestrator?.profile && canRunNatively(host, profile)
  );
}

function orchestratorProfile(config: PipelineConfig): ActorConfig | undefined {
  if (!config.orchestrator) {
    return;
  }
  const profile = config.profiles[config.orchestrator.profile];
  if (!profile) {
    throw new Error(
      `Orchestrator profile '${config.orchestrator.profile}' is not declared.`
    );
  }
  return {
    ...profile,
  };
}

export function resolvedHostModel(
  config: PipelineConfig,
  host: ActiveCommandHost,
  profile: PipelineConfig["profiles"][string]
): string | undefined {
  const runner = config.runners[profile.runner];
  const hostRunner = config.runners[host];
  if (profile.host_models?.[host]) {
    return profile.host_models[host];
  }
  if (runner?.host_models?.[host]) {
    return runner.host_models[host];
  }
  if (profile.runner === host) {
    return profile.model ?? runner?.model;
  }
  return hostRunner?.model;
}

function canRunNatively(
  host: ActiveCommandHost,
  profile: PipelineConfig["profiles"][string]
): boolean {
  if (profile.runner === host) {
    return true;
  }
  return host === "opencode" && isModelRunner(profile.runner);
}

function isModelRunner(runnerId: string): boolean {
  return COMMAND_HOSTS.some((host) => host === runnerId);
}

export function agentDispatchRoutes(
  host: ActiveCommandHost,
  config: PipelineConfig,
  workflowId = config.default_workflow
): AgentDispatchRoute[] {
  const plan = compileWorkflowPlan(config, workflowId);
  return plan.topologicalOrder.flatMap((node) => {
    if (!(node.kind === "agent" && node.profile)) {
      return [];
    }
    const profile = config.profiles[node.profile];
    if (!profile) {
      return [];
    }
    return [
      dispatchRouteForAgent(host, config, {
        needs: node.needs,
        nodeId: node.id,
        profile,
        profileId: node.profile,
      }),
    ];
  });
}

function dispatchRouteForAgent(
  host: ActiveCommandHost,
  config: PipelineConfig,
  route: Pick<AgentDispatchRoute, "needs" | "nodeId" | "profile" | "profileId">
): AgentDispatchRoute {
  const runnerId = route.profile.runner;
  if (runnerId === host) {
    const model = resolvedHostModel(config, host, route.profile);
    return {
      ...route,
      kind: "native-named-agent",
      ...(model ? { model } : {}),
      nativeAgentId: nativeAgentIdForHost(host, route.profileId),
      runnerId,
    };
  }
  if (host === "opencode" && isModelRunner(runnerId)) {
    const model = resolvedHostModel(config, host, route.profile);
    return {
      ...route,
      kind: "native-model-agent",
      ...(model ? { model } : {}),
      nativeAgentId: nativeAgentIdForHost(host, route.profileId),
      runnerId,
    };
  }
  return {
    ...route,
    kind: "cli",
    runnerId,
  };
}

function nativeAgentIdForHost(
  host: ActiveCommandHost,
  profileId: string
): string {
  return host === "opencode" ? opencodeAgentName(profileId) : profileId;
}

export function grants(actor: ActorConfig): string {
  const listGrant = (values: string[] | undefined): string =>
    (values ?? []).join(", ") || "none";

  return [
    `model: ${actor.model ?? "default"}`,
    `tools: ${listGrant(actor.tools)}`,
    `rules: ${listGrant(actor.rules)}`,
    `skills: ${listGrant(actor.skills)}`,
    `mcp_servers: ${listGrant(actor.mcp_servers)}`,
    `filesystem: ${actor.filesystem?.mode ?? "default"}`,
    `network: ${actor.network?.mode ?? "default"}`,
    ...("output" in actor ? [`output: ${actor.output?.format ?? "text"}`] : []),
  ].join("\n");
}

function orchestratorBlock(config: PipelineConfig): string {
  const profile = orchestratorProfile(config);
  if (!profile) {
    return "Configured orchestrator: none";
  }
  return [
    "Configured orchestrator:",
    grants(profile),
    `hooks: ${Object.keys(config.hooks.functions).join(", ") || "none"}`,
    "",
    instructionsPointer(profile),
  ].join("\n");
}

export function entrypointDispatchBlock(
  _host: ActiveCommandHost,
  _config: PipelineConfig,
  id: string,
  entrypoint: PipelineConfig["entrypoints"][string]
): string | undefined {
  const command = canonicalLocalRunCommand(id, entrypoint);
  return [
    `Run \`${command}\` for local supervised execution.`,
    `Configured entrypoint target: ${entrypointTargetId(entrypoint)}.`,
    "This compatibility slash command delegates to the canonical `moka run` supervisor instead of reimplementing orchestration in the host.",
    "The supervisor owns schedule generation, node execution, run state, and configured gates.",
    "Keep reporting clear that this path is CLI/supervised runtime, not host-native Task execution.",
  ].join("\n");
}

function entrypointTargetId(
  entrypoint: PipelineConfig["entrypoints"][string]
): string {
  return "workflow" in entrypoint ? entrypoint.workflow : entrypoint.schedule;
}

function canonicalLocalRunCommand(
  id: string,
  entrypoint: PipelineConfig["entrypoints"][string]
): string {
  return [
    "moka",
    "run",
    ...canonicalLocalRunFlags(id, entrypoint),
    "<task description>",
  ].join(" ");
}

function canonicalLocalRunFlags(
  id: string,
  entrypoint: PipelineConfig["entrypoints"][string]
): string[] {
  if (id === "quick") {
    return ["--effort", "quick"];
  }
  if (id === "execute") {
    return ["--effort", "thorough"];
  }
  if (id === "inspect") {
    return ["--read-only"];
  }
  if ("workflow" in entrypoint) {
    return ["--workflow", entrypoint.workflow];
  }
  return ["--entrypoint", id];
}

function localRosterAgentIds(config: PipelineConfig): string[] {
  return nativeProfileEntries("opencode", config).map(([id]) =>
    nativeAgentIdForHost("opencode", id)
  );
}

function localOrchestratorDispatchBlock(config: PipelineConfig): string {
  const roster = localRosterAgentIds(config);
  return [
    "Orchestrate through the canonical local `moka run` supervisor. Load and follow the `orchestrate` skill.",
    "For compatibility slash commands, run the `moka run` command and flags shown in the command body.",
    "Treat execution as CLI/supervised runtime, not OpenCode-native Task execution.",
    "",
    "Configured roster:",
    ...roster.map((id) => `- ${id}`),
    "",
    "Report the supervisor's evidence and configured-gate results; do not invent extra gates.",
  ].join("\n");
}

const OPENCODE_PERMISSION_TOOLS = [
  "bash",
  "edit",
  "glob",
  "grep",
  "list",
  "read",
  "write",
] as const;

const PROTECTED_FILE_TOOLS = ["edit", "write"] as const;

function opencodePermission(
  actor: ActorConfig,
  options: OpencodePermissionOptions = {}
): Record<string, string | Record<string, string>> {
  const allowed = new Set(actor.tools ?? []);
  return {
    ...opencodeToolPermissions(allowed),
    ...opencodeProtectedFilePermissions(allowed, actor.filesystem?.protected),
    external_directory: "deny",
    lsp: "allow",
    skill: opencodeSkillPermission(actor.skills ?? []),
    task: opencodeTaskPermission(allowed, options.allowedTaskAgents ?? []),
  };
}

/**
 * PIPE-90.12: overlay per-path `deny` rules for the profile's protected set onto
 * the file-mutating tools so an allowed `edit`/`write` still cannot touch the
 * ticket's acceptance criteria or adjudicating tests. opencode evaluates rules
 * last-match-wins, so `"*": "allow"` precedes the protected denies. Tools the
 * profile never granted stay fully denied by {@link opencodeToolPermissions}.
 */
function opencodeProtectedFilePermissions(
  allowed: Set<string>,
  protectedPaths: readonly string[] | undefined
): Record<string, Record<string, string>> {
  if (!protectedPaths || protectedPaths.length === 0) {
    return {};
  }
  const overlay = protectedPermissionOverlay(protectedPaths);
  return Object.fromEntries(
    PROTECTED_FILE_TOOLS.filter((tool) => allowed.has(tool)).map((tool) => [
      tool,
      { "*": "allow", ...overlay },
    ])
  );
}

function opencodeToolPermissions(
  allowed: Set<string>
): Record<(typeof OPENCODE_PERMISSION_TOOLS)[number], string> {
  return Object.fromEntries(
    OPENCODE_PERMISSION_TOOLS.map((tool) => [
      tool,
      allowed.has(tool) ? "allow" : "deny",
    ])
  ) as Record<(typeof OPENCODE_PERMISSION_TOOLS)[number], string>;
}

function opencodeSkillPermission(
  skills: string[]
): string | Record<string, string> {
  return namedOpencodePermissionMap(skills);
}

function opencodeTaskPermission(
  allowed: Set<string>,
  allowedTaskAgents: string[]
): string | Record<string, string> {
  return allowedTaskAgents.length > 0
    ? namedOpencodePermissionMap(allowedTaskAgents)
    : toolPermission(allowed, "task");
}

function namedOpencodePermissionMap(
  names: string[]
): string | Record<string, string> {
  return names.length > 0
    ? {
        "*": "deny",
        ...Object.fromEntries(names.map((name) => [name, "allow"])),
      }
    : "deny";
}

function toolPermission(allowed: Set<string>, tool: string): string {
  return allowed.has(tool) ? "allow" : "deny";
}

/**
 * PIPE-83.11: whether to synthesize the singleton pipeline gateway into this
 * repo's `.opencode/opencode.json`. A "global"-scoped gateway is registered
 * once in the global opencode config (via `moka gateway configure-host
 * --scope global`) and inherited, so it is not embedded per project.
 */
export function shouldEmbedProjectGateway(config: PipelineConfig): boolean {
  return (
    config.mcp_gateway !== undefined &&
    config.mcp_gateway.host_scope !== "global"
  );
}

function renderOpenCodeProjectConfig(config: PipelineConfig): string {
  const base = shouldEmbedProjectGateway(config)
    ? (JSON.parse(renderOpenCodeGatewayConfig(config)) as Record<
        string,
        unknown
      >)
    : { $schema: "https://opencode.ai/config.json" };
  return formatOpenCodeProjectJson({
    ...base,
    lsp: true,
    ...opencodePluginConfig(),
  });
}

function opencodePluginConfig(): { plugin?: string[] } {
  const plugins = DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST.ecosystem_code
    .flatMap((item) => npmPluginPackage(item))
    .sort((a, b) => a.localeCompare(b));
  return plugins.length > 0 ? { plugin: plugins } : {};
}

function npmPluginPackage(item: EcosystemCode): string[] {
  if (item.plugin?.kind === "npm") {
    return [item.plugin.package];
  }
  return [];
}

function formatOpenCodeProjectJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2).replace(
    SINGLE_OPENCODE_PLUGIN_ARRAY_RE,
    '\n  "plugin": [$1]'
  )}\n`;
}

function localPluginDefinitionsEffect(): Effect.Effect<
  CommandDefinition[],
  unknown,
  RepoIoService
> {
  return Effect.gen(function* () {
    const definitions = yield* Effect.all(
      DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST.ecosystem_code.map(
        localPluginDefinitionEffect
      )
    );
    return definitions.flat();
  });
}

function localPluginDefinitionEffect(
  item: EcosystemCode
): Effect.Effect<CommandDefinition[], unknown, RepoIoService> {
  const pluginConfig = item.plugin;
  if (pluginConfig?.kind !== "local") {
    return Effect.succeed([]);
  }
  const source = resolvePackageAssetPath(pluginConfig.source_path);
  return Effect.gen(function* () {
    const service = yield* RepoIoService;
    const plugin = (yield* service.readText(source)).trimEnd();
    return [
      {
        content: [
          GENERATED_TS_MARKER,
          `${OWNER_TS_MARKER_PREFIX}host=opencode`,
          "",
          plugin,
          "",
        ].join("\n"),
        host: "opencode" as const,
        invocation: invocationForHost("opencode"),
        path: pluginConfig.target_path,
      },
    ];
  });
}

function opencodeDefinitionsEffect(
  config: PipelineConfig,
  cwd: string
): Effect.Effect<CommandDefinition[], unknown, RepoIoService> {
  return Effect.gen(function* () {
    const orchestrator = orchestratorProfile(config);
    const pluginDefinitions = yield* localPluginDefinitionsEffect();
    return [
      ...entrypointCommandDefinitions("opencode", config, (id, entrypoint) => ({
        content: markdown(
          {
            ...(orchestrator ? { agent: OPENCODE_ORCHESTRATOR_AGENT_ID } : {}),
            description: entrypointDescription(id, entrypoint),
          },
          compactLines([
            header("opencode").trimEnd(),
            "",
            `Invoke this command with \`${invocationForHost("opencode", id)}\`.`,
            "",
            orchestratorBlock(config),
            "",
            entrypointDispatchBlock("opencode", config, id, entrypoint),
          ]).join("\n")
        ),
        host: "opencode",
        invocation: invocationForHost("opencode", id),
        path: `.opencode/commands/${commandIdForHost("opencode", id)}.md`,
      })),
      {
        content: renderOpenCodeProjectConfig(config),
        host: "opencode" as const,
        invocation: invocationForHost("opencode"),
        path: ".opencode/opencode.json",
      },
      ...(orchestrator
        ? [
            {
              content: markdown(
                {
                  description:
                    "Orchestrate the configured pipeline and enforce gates.",
                  mode: "primary",
                  name: OPENCODE_ORCHESTRATOR_AGENT_ID,
                  permission: opencodePermission(orchestrator, {
                    allowedTaskAgents: localRosterAgentIds(config),
                  }),
                },
                compactLines([
                  header("opencode").trimEnd(),
                  "",
                  orchestratorBlock(config),
                  "",
                  localOrchestratorDispatchBlock(config),
                ]).join("\n")
              ),
              host: "opencode" as const,
              invocation: invocationForHost("opencode"),
              path: `.opencode/agents/${OPENCODE_ORCHESTRATOR_AGENT_ID}.md`,
            },
          ]
        : []),
      ...nativeProfileEntries("opencode", config).map(([id, profile]) => ({
        content: markdown(
          {
            name: nativeAgentIdForHost("opencode", id),
            description: profile.description ?? id,
            hidden: false,
            mode: "all",
            ...opencodeModelProjection(config, profile),
            permission: opencodePermission(profile),
          },
          [
            header("opencode").trimEnd(),
            "",
            profile.description ?? id,
            "",
            "Configured grants:",
            grants(profile),
            "",
            instructionsPointer(profile),
          ].join("\n")
        ),
        host: "opencode" as const,
        invocation: invocationForHost("opencode"),
        path: `.opencode/agents/${nativeAgentIdForHost("opencode", id)}.md`,
      })),
      ...pluginDefinitions,
      projectAgentsMdDefinition(cwd, "opencode"),
    ];
  });
}

export function projectAgentsMdDefinition(
  cwd: string,
  host: ActiveCommandHost
): CommandDefinition {
  const repoName = basename(cwd);
  return {
    block: {
      end: AGENTS_MD_END,
      start: AGENTS_MD_START,
    },
    content: [
      AGENTS_MD_START,
      GENERATED_MARKER,
      `${OWNER_MARKER_PREFIX}host=opencode -->`,
      "",
      "## Pipeline Guidance",
      "",
      "This repository uses package-owned `@oisincoveney/pipeline` config.",
      "",
      '- Use `moka run "<task>"` first for local supervised execution from the package-owned pipeline config.',
      "- Use `/moka-quick`, `/moka-execute`, or `/moka-inspect` as compatibility slash-command entrypoints when available.",
      "- Load and follow the relevant skill from `.agents/skills` before doing specialized work.",
      "- Prefer the package-defined pipeline profiles and generated command surfaces over ad hoc subagent prompts.",
      "- When the user needs to run a command, copy the command into the clipboard and tell the user what needs to be returned.",
      "",
      "## Pipeline Memory",
      "",
      `Use Qdrant collection \`${repoName}\` for this repository.`,
      "",
      "- Use the Qdrant interface exposed by the active host; do not assume `qdrant-find` or `qdrant-store` are shell commands.",
      `- Before research, call MCP tool \`qdrant_qdrant_find\` with \`collection_name: ${repoName}\` when MCP tools are available; otherwise use the host's \`qdrant-find\` command/alias if one exists.`,
      `- During LEARN, call MCP tool \`qdrant_qdrant_store\` with \`collection_name: ${repoName}\` for durable lessons worth reusing; otherwise use the host's \`qdrant-store\` command/alias if one exists.`,
      "- Include metadata with at least `repo`, `phase`, `workflow` or `entrypoint`, `task`, and `outcome` when storing lessons.",
      "",
      AGENTS_MD_END,
      "",
    ].join("\n"),
    host,
    invocation: invocationForHost(host),
    path: "AGENTS.md",
  };
}

function opencodeModelProjection(
  config: PipelineConfig,
  profile: PipelineConfig["profiles"][string]
): Record<string, string> {
  const model = resolvedHostModel(config, "opencode", profile);
  return model ? { model } : {};
}

/**
 * The opencode HostAdapter. Encapsulates all opencode-specific command
 * generation, resource roots, and config-merge behaviour.
 */
export const opencodeAdapter: HostAdapter = {
  host: "opencode",
  resourceRoots: [
    ".opencode/commands",
    ".opencode/agents",
    ".opencode/plugins",
    ".opencode/skills",
  ],
  definitions(config: PipelineConfig, cwd: string): CommandDefinition[] {
    return runRepoIoSync(opencodeDefinitionsEffect(config, cwd));
  },
  mergeDefinition(
    definition: CommandDefinition,
    existingContent: string
  ): MergeDefinitionResult | undefined {
    if (definition.path !== OPENCODE_PROJECT_CONFIG_PATH) {
      return;
    }
    const projection = JSON.parse(definition.content) as Record<
      string,
      unknown
    >;
    const merged = mergeOpenCodeProjectConfig(existingContent, projection);
    if (!merged.ok) {
      return { ok: false, content: definition.content };
    }
    return { ok: true, content: merged.content };
  },
  isAlwaysForced(definition: CommandDefinition): boolean {
    return definition.path === OPENCODE_PROJECT_CONFIG_PATH;
  },
};
