// fallow-ignore-file complexity
import { basename } from "node:path";

import { Effect } from "effect";
import type { Option } from "effect/Option";
import { isNone, isSome, none, some } from "effect/Option";
import matter from "gray-matter";
import { z } from "zod";

import { DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST } from "../config";
import type { OpenCodeEcosystemManifest, PipelineConfig } from "../config";
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
import { parseJson } from "../safe-json";
import {
  AGENTS_MD_END,
  AGENTS_MD_START,
  COMMAND_HOSTS,
  commandIdForHost,
  compactLines,
  entrypointDescription,
  entrypointEntries,
  GENERATED_MARKER,
  GENERATED_TS_MARKER,
  instructionsPointer,
  invocationForHost,
  OPENCODE_PROJECT_CONFIG_PATH,
  OWNER_MARKER_PREFIX,
  OWNER_TS_MARKER_PREFIX,
  profileEntries,
  SINGLE_OPENCODE_PLUGIN_ARRAY_RE,
} from "./shared";
import type {
  ActiveCommandHost,
  CommandDefinition,
  HostAdapter,
  MergeDefinitionResult,
  ProfileEntry,
} from "./shared";

const OPENCODE_ORCHESTRATOR_AGENT_ID = "MoKa Orchestrator";
type ActorConfig = PipelineConfig["profiles"][string];
type EcosystemCode = OpenCodeEcosystemManifest["ecosystem_code"][number];

interface OpencodePermissionOptions {
  allowedTaskAgents: string[];
}

const openCodeProjectConfigProjectionSchema = z.object({
  $schema: z.string().optional(),
  lsp: z.unknown().optional(),
  mcp: z.record(z.string(), z.unknown()).optional(),
  plugin: z.array(z.unknown()).optional(),
  provider: z
    .record(
      z.string(),
      z.object({
        models: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .optional(),
});

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

export const header = (host: ActiveCommandHost): string =>
  [GENERATED_MARKER, `${OWNER_MARKER_PREFIX}host=${host} -->`, ""].join("\n");

export const markdown = (data: Record<string, unknown>, body: string): string =>
  `${matter.stringify(body.trimEnd(), data).trimEnd()}\n`;

const entrypointCommandDefinitions = (
  _host: ActiveCommandHost,
  config: PipelineConfig,
  makeDefinition: (
    id: string,
    entrypoint: PipelineConfig["entrypoints"][string]
  ) => CommandDefinition
): CommandDefinition[] =>
  entrypointEntries(config).map(([id, entrypoint]) =>
    makeDefinition(id, entrypoint)
  );

const orchestratorProfile = (config: PipelineConfig): Option<ActorConfig> => {
  if (config.orchestrator === undefined) {
    return none();
  }
  if (!Object.hasOwn(config.profiles, config.orchestrator.profile)) {
    throw new Error(
      `Orchestrator profile '${config.orchestrator.profile}' is not declared.`
    );
  }
  const profile = config.profiles[config.orchestrator.profile];
  return some({
    ...profile,
  });
};

export const resolvedHostModel = (
  config: PipelineConfig,
  host: ActiveCommandHost,
  profile: PipelineConfig["profiles"][string]
): string => {
  const runner = Object.hasOwn(config.runners, profile.runner)
    ? config.runners[profile.runner]
    : undefined;
  const hostRunner = Object.hasOwn(config.runners, host)
    ? config.runners[host]
    : undefined;
  const profileHostModel = profile.host_models?.[host];
  if (profileHostModel !== undefined && profileHostModel !== "") {
    return profileHostModel;
  }
  const runnerHostModel =
    runner === undefined ? undefined : runner.host_models?.[host];
  if (runnerHostModel !== undefined && runnerHostModel !== "") {
    return runnerHostModel;
  }
  if (profile.runner === host) {
    return profile.model ?? runner?.model ?? "";
  }
  return hostRunner?.model ?? "";
};

const isModelRunner = (runnerId: string): boolean =>
  COMMAND_HOSTS.some((host) => host === runnerId);

const canRunNatively = (
  host: ActiveCommandHost,
  profile: PipelineConfig["profiles"][string]
): boolean => {
  if (profile.runner === host) {
    return true;
  }
  return host === "opencode" && isModelRunner(profile.runner);
};

const nativeProfileEntries = (
  host: ActiveCommandHost,
  config: PipelineConfig
): ProfileEntry[] =>
  profileEntries(config).filter(
    ([id, profile]) =>
      id !== config.orchestrator?.profile && canRunNatively(host, profile)
  );

const nativeAgentIdForHost = (
  host: ActiveCommandHost,
  profileId: string
): string => (host === "opencode" ? opencodeAgentName(profileId) : profileId);

const dispatchRouteForAgent = (
  host: ActiveCommandHost,
  config: PipelineConfig,
  route: Pick<AgentDispatchRoute, "needs" | "nodeId" | "profile" | "profileId">
): AgentDispatchRoute => {
  const runnerId = route.profile.runner;
  if (runnerId === host) {
    const model = resolvedHostModel(config, host, route.profile);
    return {
      ...route,
      kind: "native-named-agent",
      ...(model === "" ? {} : { model }),
      nativeAgentId: nativeAgentIdForHost(host, route.profileId),
      runnerId,
    };
  }
  if (host === "opencode" && isModelRunner(runnerId)) {
    const model = resolvedHostModel(config, host, route.profile);
    return {
      ...route,
      kind: "native-model-agent",
      ...(model === "" ? {} : { model }),
      nativeAgentId: nativeAgentIdForHost(host, route.profileId),
      runnerId,
    };
  }
  return {
    ...route,
    kind: "cli",
    runnerId,
  };
};

export const agentDispatchRoutes = (
  host: ActiveCommandHost,
  config: PipelineConfig,
  workflowId = config.default_workflow
): AgentDispatchRoute[] => {
  const plan = compileWorkflowPlan(config, workflowId);
  return plan.topologicalOrder.flatMap((node) => {
    if (
      node.kind !== "agent" ||
      node.profile === undefined ||
      node.profile === ""
    ) {
      return [];
    }
    const profile = config.profiles[node.profile];
    if (!Object.hasOwn(config.profiles, node.profile)) {
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
};

export const grants = (actor: ActorConfig): string => {
  const listGrant = (values: readonly string[] = []): string =>
    values.join(", ") || "none";

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
};

const orchestratorBlock = (config: PipelineConfig): string => {
  const profile = orchestratorProfile(config);
  if (isNone(profile)) {
    return "Configured orchestrator: none";
  }
  return [
    "Configured orchestrator:",
    grants(profile.value),
    `hooks: ${Object.keys(config.hooks.functions).join(", ") || "none"}`,
    "",
    instructionsPointer(profile.value),
  ].join("\n");
};

const entrypointTargetId = (
  entrypoint: PipelineConfig["entrypoints"][string]
): string =>
  "workflow" in entrypoint ? entrypoint.workflow : entrypoint.schedule;

const canonicalLocalRunFlags = (
  id: string,
  entrypoint: PipelineConfig["entrypoints"][string]
): string[] => {
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
};

const canonicalLocalRunCommand = (
  id: string,
  entrypoint: PipelineConfig["entrypoints"][string]
): string =>
  [
    "moka",
    "run",
    ...canonicalLocalRunFlags(id, entrypoint),
    "<task description>",
  ].join(" ");

export const entrypointDispatchBlock = (
  _host: ActiveCommandHost,
  _config: PipelineConfig,
  id: string,
  entrypoint: PipelineConfig["entrypoints"][string]
): string => {
  const command = canonicalLocalRunCommand(id, entrypoint);
  return [
    `Run \`${command}\` for local supervised execution.`,
    `Configured entrypoint target: ${entrypointTargetId(entrypoint)}.`,
    "This compatibility slash command delegates to the canonical `moka run` supervisor instead of reimplementing orchestration in the host.",
    "The supervisor owns schedule generation, node execution, run state, and configured gates.",
    "Keep reporting clear that this path is CLI/supervised runtime, not host-native Task execution.",
  ].join("\n");
};

const localRosterAgentIds = (config: PipelineConfig): string[] =>
  nativeProfileEntries("opencode", config).map(([id]) =>
    nativeAgentIdForHost("opencode", id)
  );

const localOrchestratorDispatchBlock = (config: PipelineConfig): string => {
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
};

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

/**
 * PIPE-90.12: overlay per-path `deny` rules for the profile's protected set onto
 * the file-mutating tools so an allowed `edit`/`write` still cannot touch the
 * ticket's acceptance criteria or adjudicating tests. opencode evaluates rules
 * last-match-wins, so `"*": "allow"` precedes the protected denies. Tools the
 * profile never granted stay fully denied by {@link opencodeToolPermissions}.
 */
const opencodeProtectedFilePermissions = (
  allowed: Set<string>,
  protectedPaths: readonly string[] = []
): Record<string, Record<string, string>> => {
  if (protectedPaths.length === 0) {
    return {};
  }
  const overlay = protectedPermissionOverlay(protectedPaths);
  return Object.fromEntries(
    PROTECTED_FILE_TOOLS.filter((tool) => allowed.has(tool)).map((tool) => [
      tool,
      { "*": "allow", ...overlay },
    ])
  );
};

const opencodeToolPermissions = (
  allowed: Set<string>
): Record<(typeof OPENCODE_PERMISSION_TOOLS)[number], string> => ({
  bash: allowed.has("bash") ? "allow" : "deny",
  edit: allowed.has("edit") ? "allow" : "deny",
  glob: allowed.has("glob") ? "allow" : "deny",
  grep: allowed.has("grep") ? "allow" : "deny",
  list: allowed.has("list") ? "allow" : "deny",
  read: allowed.has("read") ? "allow" : "deny",
  write: allowed.has("write") ? "allow" : "deny",
});

const namedOpencodePermissionMap = (
  names: string[]
): string | Record<string, string> =>
  names.length > 0
    ? {
        "*": "deny",
        ...Object.fromEntries(names.map((name) => [name, "allow"])),
      }
    : "deny";

const opencodeSkillPermission = (
  skills: string[]
): string | Record<string, string> => namedOpencodePermissionMap(skills);

const toolPermission = (allowed: Set<string>, tool: string): string =>
  allowed.has(tool) ? "allow" : "deny";

const opencodeTaskPermission = (
  allowed: Set<string>,
  allowedTaskAgents: string[]
): string | Record<string, string> =>
  allowedTaskAgents.length > 0
    ? namedOpencodePermissionMap(allowedTaskAgents)
    : toolPermission(allowed, "task");

const opencodePermission = (
  actor: ActorConfig,
  options: OpencodePermissionOptions = { allowedTaskAgents: [] }
): Record<string, string | Record<string, string>> => {
  const allowed = new Set(actor.tools ?? []);
  return {
    ...opencodeToolPermissions(allowed),
    ...opencodeProtectedFilePermissions(
      allowed,
      actor.filesystem?.protected ?? []
    ),
    external_directory: "deny",
    lsp: "allow",
    skill: opencodeSkillPermission(actor.skills ?? []),
    task: opencodeTaskPermission(allowed, options.allowedTaskAgents),
  };
};

/**
 * PIPE-83.11: whether to synthesize the singleton pipeline gateway into this
 * repo's `.opencode/opencode.json`. A "global"-scoped gateway is registered
 * once in the global opencode config (via `moka gateway configure-host
 * --scope global`) and inherited, so it is not embedded per project.
 */
export const shouldEmbedProjectGateway = (config: PipelineConfig): boolean =>
  config.mcp_gateway !== undefined &&
  config.mcp_gateway.host_scope !== "global";

const npmPluginPackage = (item: EcosystemCode): string[] => {
  if (item.plugin?.kind === "npm") {
    return [item.plugin.package];
  }
  return [];
};

const opencodePluginConfig = (): { plugin?: string[] } => {
  const plugins = DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST.ecosystem_code
    .flatMap((item) => npmPluginPackage(item))
    .toSorted((a, b) => a.localeCompare(b));
  return plugins.length > 0 ? { plugin: plugins } : {};
};

const formatOpenCodeProjectJson = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value, null, 2).replace(
    SINGLE_OPENCODE_PLUGIN_ARRAY_RE,
    '\n  "plugin": [$1]'
  )}\n`;

const parseOpenCodeProjectConfigProjection = (source: string) =>
  openCodeProjectConfigProjectionSchema.parse(
    parseJson(source, "OpenCode project config projection")
  );

const renderOpenCodeProjectConfig = (config: PipelineConfig): string => {
  const base = shouldEmbedProjectGateway(config)
    ? parseOpenCodeProjectConfigProjection(renderOpenCodeGatewayConfig(config))
    : { $schema: "https://opencode.ai/config.json" };
  return formatOpenCodeProjectJson({
    ...base,
    lsp: true,
    ...opencodePluginConfig(),
  });
};

const localPluginDefinitionEffect = (
  item: EcosystemCode
): Effect.Effect<CommandDefinition[], unknown, RepoIoService> => {
  const pluginConfig = item.plugin;
  if (pluginConfig?.kind !== "local") {
    return Effect.succeed([]);
  }
  const source = resolvePackageAssetPath(pluginConfig.source_path);
  return Effect.gen(function* effectBody() {
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
};

const localPluginDefinitionsEffect = (): Effect.Effect<
  CommandDefinition[],
  unknown,
  RepoIoService
> =>
  Effect.gen(function* effectBody() {
    const definitions = yield* Effect.all(
      DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST.ecosystem_code.map(
        localPluginDefinitionEffect
      )
    );
    return definitions.flat();
  });

export const projectAgentsMdDefinition = (
  cwd: string,
  host: ActiveCommandHost
): CommandDefinition => {
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
};

const opencodeModelProjection = (
  config: PipelineConfig,
  profile: PipelineConfig["profiles"][string]
): Record<string, string> => {
  const model = resolvedHostModel(config, "opencode", profile);
  return model === "" ? {} : { model };
};

const opencodeDefinitionsEffect = (
  config: PipelineConfig,
  cwd: string
): Effect.Effect<CommandDefinition[], unknown, RepoIoService> =>
  Effect.gen(function* effectBody() {
    const orchestrator = orchestratorProfile(config);
    const pluginDefinitions = yield* localPluginDefinitionsEffect();
    return [
      ...entrypointCommandDefinitions("opencode", config, (id, entrypoint) => ({
        content: markdown(
          {
            ...(isSome(orchestrator)
              ? { agent: OPENCODE_ORCHESTRATOR_AGENT_ID }
              : {}),
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
      ...(isSome(orchestrator)
        ? [
            {
              content: markdown(
                {
                  description:
                    "Orchestrate the configured pipeline and enforce gates.",
                  mode: "primary",
                  name: OPENCODE_ORCHESTRATOR_AGENT_ID,
                  permission: opencodePermission(orchestrator.value, {
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
            description: profile.description ?? id,
            hidden: false,
            mode: "all",
            name: nativeAgentIdForHost("opencode", id),
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

/**
 * The opencode HostAdapter. Encapsulates all opencode-specific command
 * generation, resource roots, and config-merge behaviour.
 */
export const opencodeAdapter: HostAdapter = {
  definitions(config: PipelineConfig, cwd: string): CommandDefinition[] {
    return runRepoIoSync(opencodeDefinitionsEffect(config, cwd));
  },
  host: "opencode",
  isAlwaysForced(definition: CommandDefinition): boolean {
    return definition.path === OPENCODE_PROJECT_CONFIG_PATH;
  },
  mergeDefinition(
    definition: CommandDefinition,
    existingContent: string
  ): Option<MergeDefinitionResult> {
    if (definition.path !== OPENCODE_PROJECT_CONFIG_PATH) {
      return none();
    }
    const projection = parseOpenCodeProjectConfigProjection(definition.content);
    const merged = mergeOpenCodeProjectConfig(existingContent, projection);
    if (!merged.ok) {
      return some({ content: definition.content, ok: false });
    }
    return some({ content: merged.content, ok: true });
  },
  resourceRoots: [
    ".opencode/commands",
    ".opencode/agents",
    ".opencode/plugins",
    ".opencode/skills",
  ],
};
