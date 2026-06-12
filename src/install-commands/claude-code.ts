import type { PipelineConfig } from "../config";
import { renderClaudeGatewayMcpServers } from "../mcp/gateway";
import {
  type AgentDispatchRoute,
  agentDispatchRoutes,
  compactLines,
  entrypointDescription,
  entrypointDispatchBlock,
  entrypointEntries,
  grants,
  header,
  instructionsPointer,
  markdown,
  opencodeAgentName,
  projectAgentsMdDefinition,
  resolvedHostModel,
  scheduledEntrypointK8sNote,
} from "./opencode";
import {
  type ActiveCommandHost,
  CLAUDE_PROJECT_CONFIG_PATH,
  type CommandDefinition,
  commandIdForHost,
  invocationForHost,
} from "./shared";

const CLAUDE_CODE_HOST: ActiveCommandHost = "claude-code";
const CLAUDE_ALLOWED_TOOLS = "Task, Bash(opencode run *)";
const CLAUDE_AGENT_TOOLS = "Bash, Read";
const MOKA_PROFILE_PREFIX = "moka-";

type ProfileConfig = PipelineConfig["profiles"][string];

function claudeAgentNameForProfile(profileId: string): string {
  return profileId.startsWith(MOKA_PROFILE_PREFIX)
    ? profileId
    : `${MOKA_PROFILE_PREFIX}${profileId}`;
}

function cliRoutesForConfig(config: PipelineConfig): AgentDispatchRoute[] {
  return entrypointEntries(config).flatMap(([, entrypoint]) =>
    "workflow" in entrypoint
      ? agentDispatchRoutes(CLAUDE_CODE_HOST, config, entrypoint.workflow)
      : []
  );
}

function distinctCliProfiles(config: PipelineConfig): AgentDispatchRoute[] {
  const seen = new Set<string>();
  const profiles: AgentDispatchRoute[] = [];
  for (const route of cliRoutesForConfig(config)) {
    if (route.kind !== "cli" || seen.has(route.profileId)) {
      continue;
    }
    seen.add(route.profileId);
    profiles.push(route);
  }
  return profiles.sort((a, b) => a.profileId.localeCompare(b.profileId));
}

function commandDispatchBody(
  config: PipelineConfig,
  id: string,
  entrypoint: PipelineConfig["entrypoints"][string]
): string {
  if (!("workflow" in entrypoint)) {
    return (
      entrypointDispatchBlock(CLAUDE_CODE_HOST, config, id, entrypoint) ?? ""
    );
  }
  const routes = agentDispatchRoutes(
    CLAUDE_CODE_HOST,
    config,
    entrypoint.workflow
  );
  return [
    `Run workflow \`${entrypoint.workflow}\` for the user task.`,
    "",
    "Delegate each agent node to a Claude Code `Task` subagent that wraps a local `opencode run` subprocess.",
    "Spawn one node at a time respecting `needs`; run nodes whose dependencies are satisfied in parallel.",
    "",
    "Node routes:",
    ...routes.map(claudeNodeRouteLine),
    "",
    "For each node prompt include:",
    "- user task",
    `- workflow id: ${entrypoint.workflow}`,
    "- node id",
    "- profile id",
    "- profile instructions reference",
    "- profile grants",
    "- dependency outputs",
    "",
    "Only package-configured gates are blocking. Do not invent RED, GREEN, full-suite, typecheck, or unrelated-drift gates.",
    "If a node returns targeted evidence and has no configured blocking gate, advance to the next node.",
    "The Task subagents wrap `opencode run` subprocesses; do not claim these worker nodes are Claude Code native agents.",
  ].join("\n");
}

function claudeNodeRouteLine(route: AgentDispatchRoute): string {
  const needs = route.needs.length > 0 ? route.needs.join(",") : "none";
  return `- ${route.nodeId}: Task subagent_type=${claudeAgentNameForProfile(route.profileId)} runner=${route.runnerId} agent="${opencodeAgentName(route.profileId)}" needs=${needs}`;
}

function commandDefinitions(config: PipelineConfig): CommandDefinition[] {
  return entrypointEntries(config).map(([id, entrypoint]) => ({
    content: markdown(
      {
        "argument-hint": "<task description>",
        "allowed-tools": CLAUDE_ALLOWED_TOOLS,
        description: entrypointDescription(id, entrypoint),
      },
      compactLines([
        header(CLAUDE_CODE_HOST).trimEnd(),
        "",
        `Invoke this command with \`${invocationForHost(CLAUDE_CODE_HOST, id)}\`.`,
        "",
        "Load and follow the `execute` skill for the execution doctrine before dispatching work.",
        "",
        scheduledEntrypointK8sNote(entrypoint),
        scheduledEntrypointK8sNote(entrypoint) ? "" : undefined,
        commandDispatchBody(config, id, entrypoint),
      ]).join("\n")
    ),
    host: CLAUDE_CODE_HOST,
    invocation: invocationForHost(CLAUDE_CODE_HOST, id),
    path: `.claude/commands/${commandIdForHost(CLAUDE_CODE_HOST, id)}.md`,
  }));
}

function agentModelProjection(
  config: PipelineConfig,
  profile: ProfileConfig
): Record<string, string> {
  const model = resolvedHostModel(config, CLAUDE_CODE_HOST, profile);
  return model ? { model } : {};
}

function agentDefinitions(config: PipelineConfig): CommandDefinition[] {
  return distinctCliProfiles(config).map((route) => {
    const profile = route.profile;
    const agentName = claudeAgentNameForProfile(route.profileId);
    const displayName = opencodeAgentName(route.profileId);
    return {
      content: markdown(
        {
          name: agentName,
          description: profile.description ?? route.profileId,
          tools: CLAUDE_AGENT_TOOLS,
          ...agentModelProjection(config, profile),
        },
        [
          header(CLAUDE_CODE_HOST).trimEnd(),
          "",
          profile.description ?? route.profileId,
          "",
          `Run EXACTLY ONE \`opencode run --agent "${displayName}" --format json --dir "$PWD" '<node prompt>'\` subprocess for this node.`,
          "Stay inside this node's scope and do not branch into adjacent nodes.",
          "Do not claim completion without fresh evidence from the subprocess output.",
          "Return only: { command, exit status, parsed evidence, touched files, blockers }.",
          "",
          "Configured grants:",
          grants(profile),
          "",
          instructionsPointer(profile),
        ].join("\n")
      ),
      host: CLAUDE_CODE_HOST,
      invocation: invocationForHost(CLAUDE_CODE_HOST),
      path: `.claude/agents/${agentName}.md`,
    };
  });
}

function settingsDefinition(config: PipelineConfig): CommandDefinition[] {
  const settings: Record<string, unknown> = {
    permissions: {
      allow: ["Task", "Bash(opencode run *)"],
    },
  };
  if (config.mcp_gateway) {
    settings.mcpServers = renderClaudeGatewayMcpServers(config);
  }
  return [
    {
      content: `${JSON.stringify(settings, null, 2)}\n`,
      host: CLAUDE_CODE_HOST,
      invocation: invocationForHost(CLAUDE_CODE_HOST),
      path: CLAUDE_PROJECT_CONFIG_PATH,
    },
  ];
}

export function claudeCodeDefinitions(
  config: PipelineConfig,
  cwd: string
): CommandDefinition[] {
  return [
    ...commandDefinitions(config),
    ...agentDefinitions(config),
    ...settingsDefinition(config),
    projectAgentsMdDefinition(cwd, CLAUDE_CODE_HOST),
  ];
}
