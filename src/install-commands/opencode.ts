import { readFileSync } from "node:fs";
import { basename } from "node:path";
import matter from "gray-matter";
import {
  DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST,
  type OpenCodeEcosystemManifest,
  type PipelineConfig,
} from "../config";
import { renderOpenCodeGatewayConfig } from "../mcp/gateway";
import { mergeOpenCodeProjectConfig } from "../opencode-project-config";
import { resolvePackageAssetPath } from "../package-assets";
import { compileWorkflowPlan } from "../planning/compile";
import { opencodeAgentName } from "../runtime/opencode-agent-name";
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
  return [
    `model: ${actor.model ?? "default"}`,
    `tools: ${(actor.tools ?? []).join(", ") || "none"}`,
    `rules: ${(actor.rules ?? []).join(", ") || "none"}`,
    `skills: ${(actor.skills ?? []).join(", ") || "none"}`,
    `mcp_servers: ${(actor.mcp_servers ?? []).join(", ") || "none"}`,
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

function dispatchBlock(
  host: ActiveCommandHost,
  config: PipelineConfig,
  workflowId = config.default_workflow
): string | undefined {
  const routes = agentDispatchRoutes(host, config, workflowId);
  if (routes.length === 0) {
    return;
  }
  const plan = compileWorkflowPlan(config, workflowId);
  const nativeRoutes = routes.filter((route) => route.kind !== "cli");
  const cliRoutes = routes.filter((route) => route.kind === "cli");
  return [
    `Run workflow \`${plan.workflowId}\` for the user task.`,
    "",
    nativeDispatchBlock(host, nativeRoutes),
    cliDispatchBlock(host, cliRoutes),
    nodePromptContract(plan.workflowId, routes),
    "Only package-configured gates are blocking. Do not invent RED, GREEN, full-suite, typecheck, or unrelated-drift gates.",
    "If a node returns targeted evidence and has no configured blocking gate, advance to the next node.",
    "Do not bypass configured runner subprocesses or package-configured gates when executing nodes.",
    "Use the listed Task tool routes for native nodes, and run nodes with satisfied dependencies in parallel whenever the host supports concurrent subagent work.",
    hostSpecificDispatchGuard(host, nativeRoutes, cliRoutes),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function entrypointDispatchBlock(
  host: ActiveCommandHost,
  config: PipelineConfig,
  id: string,
  entrypoint: PipelineConfig["entrypoints"][string]
): string | undefined {
  if ("workflow" in entrypoint) {
    return dispatchBlock(host, config, entrypoint.workflow);
  }
  return [
    `Generate a schedule for entrypoint \`${id}\` and the user task.`,
    `The schedule policy is \`${entrypoint.schedule}\`.`,
    id === "quick"
      ? "Run `moka submit --quick <task description>` to submit the graph as an Argo Workflow."
      : `Run \`moka submit <task description>\` to submit the \`${id}\` graph as an Argo Workflow.`,
    "The pipeline runtime executes as Argo DAG tasks using the package-owned runner image.",
    "Configure the target in `~/.config/moka/config.yaml`; use `--kubeconfig <path>` and `--namespace <namespace>` only for explicit command overrides.",
    "Use `moka submit --schedule <schedule.yaml> <task description>` only when rerunning an existing schedule artifact.",
  ].join("\n");
}

export function scheduledEntrypointK8sNote(
  entrypoint: PipelineConfig["entrypoints"][string]
): string | undefined {
  if ("workflow" in entrypoint) {
    return;
  }
  return "Submit Momokaya work as Argo Workflows through `moka submit` and `moka submit --quick`.";
}

function localRosterAgentIds(config: PipelineConfig): string[] {
  return nativeProfileEntries("opencode", config).map(([id]) =>
    nativeAgentIdForHost("opencode", id)
  );
}

function localOrchestratorDispatchBlock(config: PipelineConfig): string {
  const roster = localRosterAgentIds(config);
  return [
    "Orchestrate locally. Load and follow the `orchestrate` skill.",
    "Do not submit to Argo or run `moka submit`. Spawn the roster as native Task subagents on this machine and run nodes with satisfied dependencies in parallel.",
    "",
    "Roster (Task tool subagent_type):",
    ...roster.map((id) => `- ${id}`),
    "",
    "Gather each subagent's structured output, enforce only package-configured gates, and report only the evidence the subagents returned.",
  ].join("\n");
}

function nativeDispatchBlock(
  host: ActiveCommandHost,
  routes: AgentDispatchRoute[]
): string | undefined {
  if (routes.length === 0) {
    return;
  }
  return [
    `${hostDisplayName(host)} native routes:`,
    ...routes.map(nativeDispatchLine),
    "",
  ].join("\n");
}

function nativeDispatchLine(route: AgentDispatchRoute): string {
  const needs = needsSummary(route.needs);
  const model = route.model ? ` model=${route.model}` : "";
  return `- ${route.nodeId}: Task tool subagent_type=${route.nativeAgentId}${model} runner=${route.runnerId} needs=${needs}`;
}

function cliDispatchBlock(
  host: ActiveCommandHost,
  routes: AgentDispatchRoute[]
): string | undefined {
  if (routes.length === 0) {
    return;
  }
  const nativeNotice = `These nodes are not ${hostDisplayName(host)} native routes.`;
  return [nativeNotice, "CLI routes:", ...routes.map(cliDispatchLine), ""].join(
    "\n"
  );
}

function cliDispatchLine(route: AgentDispatchRoute): string {
  return `- ${route.nodeId}: ${route.runnerId} CLI profile=${route.profileId} command=\`${runnerCliCommand(route)}\` needs=${needsSummary(route.needs)}`;
}

function runnerCliCommand(route: AgentDispatchRoute): string {
  if (route.runnerId === "opencode") {
    return `opencode run --agent "${opencodeAgentName(route.profileId)}" --format json --dir <repo-root> <node prompt>`;
  }
  throw new Error(
    `runner '${route.runnerId}' cannot be represented as a supported native or CLI route`
  );
}

function nodePromptContract(
  workflowId: string,
  routes: AgentDispatchRoute[]
): string {
  const hasCliRoutes = routes.some((route) => route.kind === "cli");
  const lead = hasCliRoutes
    ? "For each CLI node prompt include:"
    : "For each native node prompt include:";
  return [
    lead,
    "- user task",
    `- workflow id: ${workflowId}`,
    "- node id",
    "- profile id",
    "- runner id",
    "- profile instructions reference",
    "- profile grants",
    "- dependency outputs",
    "",
  ].join("\n");
}

function hostSpecificDispatchGuard(
  host: ActiveCommandHost,
  nativeRoutes: AgentDispatchRoute[],
  cliRoutes: AgentDispatchRoute[]
): string | undefined {
  if (cliRoutes.length > 0 && nativeRoutes.length > 0) {
    return `Do not claim CLI routes are ${hostDisplayName(host)} native routes.`;
  }
  if (cliRoutes.length > 0 && nativeRoutes.length === 0) {
    return `Do not claim these nodes are ${hostDisplayName(host)} subagents.`;
  }
  return;
}

function hostDisplayName(host: ActiveCommandHost): string {
  const names: Record<ActiveCommandHost, string> = {
    opencode: "OpenCode",
    "claude-code": "Claude Code",
  };
  return names[host];
}

function needsSummary(needs: string[]): string {
  return needs.length > 0 ? needs.join(",") : "none";
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

function opencodePermission(
  actor: ActorConfig,
  options: OpencodePermissionOptions = {}
): Record<string, string | Record<string, string>> {
  const allowed = new Set(actor.tools ?? []);
  return {
    ...opencodeToolPermissions(allowed),
    external_directory: "deny",
    lsp: "allow",
    skill: opencodeSkillPermission(actor.skills ?? []),
    task: opencodeTaskPermission(allowed, options.allowedTaskAgents ?? []),
  };
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

function renderOpenCodeProjectConfig(config: PipelineConfig): string {
  const base = config.mcp_gateway
    ? (JSON.parse(renderOpenCodeGatewayConfig(config)) as Record<
        string,
        unknown
      >)
    : { $schema: "https://opencode.ai/config.json" };
  return formatOpenCodeProjectJson({
    ...base,
    lsp: true,
    ...opencodePluginConfig(),
    ...opencodeProviderConfig(),
  });
}

function opencodeProviderConfig(): {
  provider?: Record<string, { models: Record<string, unknown> }>;
} {
  const provider: Record<string, { models: Record<string, unknown> }> = {};
  for (const model of DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST.provider_models) {
    provider[model.provider] ??= { models: {} };
    provider[model.provider].models[model.id] = { options: model.options };
  }
  return Object.keys(provider).length > 0 ? { provider } : {};
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

function localPluginDefinitions(): CommandDefinition[] {
  return DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST.ecosystem_code.flatMap((item) => {
    if (item.plugin?.kind !== "local") {
      return [];
    }
    const source = resolvePackageAssetPath(item.plugin.source_path);
    const plugin = readFileSync(source, "utf8").trimEnd();
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
        path: item.plugin.target_path,
      },
    ];
  });
}

function opencodeDefinitions(
  config: PipelineConfig,
  cwd: string
): CommandDefinition[] {
  const orchestrator = orchestratorProfile(config);
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
          scheduledEntrypointK8sNote(entrypoint),
          scheduledEntrypointK8sNote(entrypoint) ? "" : undefined,
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
    ...localPluginDefinitions(),
    projectAgentsMdDefinition(cwd, "opencode"),
  ];
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
      "- Use `/moka-quick`, `/moka-execute`, or `/moka-inspect` for OpenCode slash-command entrypoints when available.",
      "- Load and follow the relevant skill from `.agents/skills` before doing specialized work.",
      "- Prefer the package-defined pipeline profiles and generated command surfaces over ad hoc subagent prompts.",
      "- When the user needs to run a command, copy the command into the clipboard and tell the user what needs to be returned.",
      "",
      "## Pipeline Memory",
      "",
      `Use Qdrant collection \`${repoName}\` for this repository.`,
      "",
      `- Call \`qdrant-find\` before research with \`collection_name: ${repoName}\` unless the user explicitly disables memory.`,
      `- Call \`qdrant-store\` during LEARN with \`collection_name: ${repoName}\` for durable lessons worth reusing.`,
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
    return opencodeDefinitions(config, cwd);
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
