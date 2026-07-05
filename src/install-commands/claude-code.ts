import type { Option } from "effect/Option";
import { none, some } from "effect/Option";
import { z } from "zod";

import type { ClaudeSettingsProjection } from "../claude-settings-config";
import { mergeClaudeSettings } from "../claude-settings-config";
import type { PipelineConfig } from "../config";
import { opencodeAgentName } from "../runtime/opencode-agent-name";
import { parseJson } from "../safe-json";
import {
  agentDispatchRoutes,
  entrypointDispatchBlock,
  grants,
  header,
  markdown,
  projectAgentsMdDefinition,
  resolvedHostModel,
} from "./opencode";
import type { AgentDispatchRoute } from "./opencode";
import {
  CLAUDE_PROJECT_CONFIG_PATH,
  commandIdForHost,
  compactLines,
  entrypointDescription,
  entrypointEntries,
  instructionsPointer,
  invocationForHost,
} from "./shared";
import type {
  ActiveCommandHost,
  CommandDefinition,
  HostAdapter,
  MergeDefinitionResult,
} from "./shared";

const CLAUDE_CODE_HOST: ActiveCommandHost = "claude-code";
const CLAUDE_ALLOWED_TOOLS = "Bash(moka run *)";
const CLAUDE_AGENT_TOOLS = "Bash, Read";
const MOKA_PROFILE_PREFIX = "moka-";

const claudeSettingsProjectionSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  permissions: z.object({ allow: z.array(z.string()).optional() }).optional(),
});

type ProfileConfig = PipelineConfig["profiles"][string];

const parseClaudeSettingsProjection = (
  source: string
): ClaudeSettingsProjection =>
  claudeSettingsProjectionSchema.parse(
    parseJson(source, "Claude settings projection")
  );

const claudeAgentNameForProfile = (profileId: string): string =>
  profileId.startsWith(MOKA_PROFILE_PREFIX)
    ? profileId
    : `${MOKA_PROFILE_PREFIX}${profileId}`;

const cliRoutesForConfig = (config: PipelineConfig): AgentDispatchRoute[] =>
  entrypointEntries(config).flatMap(([, entrypoint]) =>
    "workflow" in entrypoint
      ? agentDispatchRoutes(CLAUDE_CODE_HOST, config, entrypoint.workflow)
      : []
  );

const distinctCliProfiles = (config: PipelineConfig): AgentDispatchRoute[] => {
  const seen = new Set<string>();
  const profiles: AgentDispatchRoute[] = [];
  for (const route of cliRoutesForConfig(config)) {
    if (route.kind !== "cli" || seen.has(route.profileId)) {
      continue;
    }
    seen.add(route.profileId);
    profiles.push(route);
  }
  return profiles.toSorted((a, b) => a.profileId.localeCompare(b.profileId));
};

const commandDispatchBody = (
  config: PipelineConfig,
  id: string,
  entrypoint: PipelineConfig["entrypoints"][string]
): string => entrypointDispatchBlock(CLAUDE_CODE_HOST, config, id, entrypoint);

const commandDefinitions = (config: PipelineConfig): CommandDefinition[] =>
  entrypointEntries(config).map(([id, entrypoint]) => ({
    content: markdown(
      {
        "allowed-tools": CLAUDE_ALLOWED_TOOLS,
        "argument-hint": "<task description>",
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

const agentModelProjection = (
  config: PipelineConfig,
  profile: ProfileConfig
): Record<string, string> => {
  const model = resolvedHostModel(config, CLAUDE_CODE_HOST, profile);
  return model === "" ? {} : { model };
};

const agentDefinitions = (config: PipelineConfig): CommandDefinition[] =>
  distinctCliProfiles(config).map((route) => {
    const { profile } = route;
    const agentName = claudeAgentNameForProfile(route.profileId);
    const displayName = opencodeAgentName(route.profileId);
    return {
      content: markdown(
        {
          description: profile.description ?? route.profileId,
          name: agentName,
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

const settingsDefinition = (): CommandDefinition[] => {
  const settings: Record<string, unknown> = {
    permissions: {
      allow: ["Bash(moka run *)"],
    },
  };
  return [
    {
      content: `${JSON.stringify(settings, null, 2)}\n`,
      host: CLAUDE_CODE_HOST,
      invocation: invocationForHost(CLAUDE_CODE_HOST),
      path: CLAUDE_PROJECT_CONFIG_PATH,
    },
  ];
};

const claudeCodeDefinitions = (
  config: PipelineConfig,
  cwd: string
): CommandDefinition[] => [
  ...commandDefinitions(config),
  ...agentDefinitions(config),
  ...settingsDefinition(),
  projectAgentsMdDefinition(cwd, CLAUDE_CODE_HOST),
];

/**
 * The claude-code HostAdapter. Encapsulates all Claude Code-specific command
 * generation, resource roots, and settings-merge behaviour.
 */
export const claudeCodeAdapter: HostAdapter = {
  definitions(config: PipelineConfig, cwd: string): CommandDefinition[] {
    return claudeCodeDefinitions(config, cwd);
  },
  host: "claude-code",
  isAlwaysForced(definition: CommandDefinition): boolean {
    return definition.path === CLAUDE_PROJECT_CONFIG_PATH;
  },
  mergeDefinition(
    definition: CommandDefinition,
    existingContent: string
  ): Option<MergeDefinitionResult> {
    if (definition.path !== CLAUDE_PROJECT_CONFIG_PATH) {
      return none();
    }
    const projection = parseClaudeSettingsProjection(definition.content);
    const merged = mergeClaudeSettings(existingContent, projection);
    if (!merged.ok) {
      return some({ content: definition.content, ok: false });
    }
    return some({ content: merged.content, ok: true });
  },
  resourceRoots: [".claude/commands", ".claude/agents"],
};
