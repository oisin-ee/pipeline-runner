import { mergeClaudeSettings } from "../claude-settings-config";
import type { PipelineConfig } from "../config";
import { renderClaudeGatewayMcpServers } from "../mcp/gateway";
import { opencodeAgentName } from "../runtime/opencode-agent-name";
import {
  type AgentDispatchRoute,
  agentDispatchRoutes,
  entrypointDispatchBlock,
  grants,
  header,
  markdown,
  projectAgentsMdDefinition,
  resolvedHostModel,
} from "./opencode";
import {
  type ActiveCommandHost,
  CLAUDE_PROJECT_CONFIG_PATH,
  type CommandDefinition,
  commandIdForHost,
  compactLines,
  entrypointDescription,
  entrypointEntries,
  type HostAdapter,
  instructionsPointer,
  invocationForHost,
  type MergeDefinitionResult,
} from "./shared";

const CLAUDE_CODE_HOST: ActiveCommandHost = "claude-code";
const CLAUDE_ALLOWED_TOOLS = "Bash(moka run *)";
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
  return (
    entrypointDispatchBlock(CLAUDE_CODE_HOST, config, id, entrypoint) ?? ""
  );
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
      allow: ["Bash(moka run *)"],
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

function claudeCodeDefinitions(
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

/**
 * The claude-code HostAdapter. Encapsulates all Claude Code-specific command
 * generation, resource roots, and settings-merge behaviour.
 */
export const claudeCodeAdapter: HostAdapter = {
  host: "claude-code",
  resourceRoots: [".claude/commands", ".claude/agents"],
  definitions(config: PipelineConfig, cwd: string): CommandDefinition[] {
    return claudeCodeDefinitions(config, cwd);
  },
  mergeDefinition(
    definition: CommandDefinition,
    existingContent: string
  ): MergeDefinitionResult | undefined {
    if (definition.path !== CLAUDE_PROJECT_CONFIG_PATH) {
      return;
    }
    const projection = JSON.parse(definition.content) as Record<
      string,
      unknown
    >;
    const merged = mergeClaudeSettings(
      existingContent,
      projection as Parameters<typeof mergeClaudeSettings>[1]
    );
    if (!merged.ok) {
      return { ok: false, content: definition.content };
    }
    return { ok: true, content: merged.content };
  },
  isAlwaysForced(definition: CommandDefinition): boolean {
    return definition.path === CLAUDE_PROJECT_CONFIG_PATH;
  },
};
