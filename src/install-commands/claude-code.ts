import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ClaudeSettingsProjection } from "../claude-settings-config";
import { mergeClaudeSettings } from "../claude-settings-config";
import type { PipelineConfig } from "../config";
import { opencodeAgentName } from "../runtime/opencode-agent-name";
import { runRepoIoSync } from "../runtime/services/repo-io-service";
import { parseJson } from "../safe-json";
import { mutableArray, parseWithSchema, struct } from "../schema-boundary";
import {
  agentDispatchRoutes,
  entrypointDispatchBlock,
  formatJsonDocument,
  grants,
  header,
  markdown,
  projectAgentsMdDefinitionEffect,
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

const claudeSettingsProjectionSchema = struct({
  mcpServers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  permissions: Schema.optional(
    struct({ allow: Schema.optional(mutableArray(Schema.String)) })
  ),
});

type ProfileConfig = PipelineConfig["profiles"][string];

interface DistinctCliProfilesState {
  profiles: AgentDispatchRoute[];
  seen: HashSet.HashSet<string>;
}

const parseClaudeSettingsProjection = (
  source: string
): ClaudeSettingsProjection =>
  parseWithSchema(
    claudeSettingsProjectionSchema,
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

const distinctCliProfilesInitial = (): DistinctCliProfilesState => ({
  profiles: [],
  seen: HashSet.empty<string>(),
});

const appendDistinctCliProfile = (
  state: DistinctCliProfilesState,
  route: AgentDispatchRoute
): DistinctCliProfilesState =>
  route.kind !== "cli" || HashSet.has(state.seen, route.profileId)
    ? state
    : {
        profiles: [...state.profiles, route],
        seen: HashSet.add(state.seen, route.profileId),
      };

const distinctCliProfiles = (config: PipelineConfig): AgentDispatchRoute[] =>
  Arr.reduce(
    cliRoutesForConfig(config),
    distinctCliProfilesInitial(),
    appendDistinctCliProfile
  ).profiles.toSorted((a, b) => a.profileId.localeCompare(b.profileId));

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
      content: formatJsonDocument(settings),
      host: CLAUDE_CODE_HOST,
      invocation: invocationForHost(CLAUDE_CODE_HOST),
      path: CLAUDE_PROJECT_CONFIG_PATH,
    },
  ];
};

const claudeCodeDefinitions = (
  config: PipelineConfig,
  cwd: string
): Effect.Effect<CommandDefinition[], never, Path.Path> =>
  Effect.gen(function* effectBody() {
    const agentsMdDefinition = yield* projectAgentsMdDefinitionEffect(
      cwd,
      CLAUDE_CODE_HOST
    );
    return [
      ...commandDefinitions(config),
      ...agentDefinitions(config),
      ...settingsDefinition(),
      agentsMdDefinition,
    ];
  });

/**
 * The claude-code HostAdapter. Encapsulates all Claude Code-specific command
 * generation, resource roots, and settings-merge behaviour.
 */
export const claudeCodeAdapter: HostAdapter = {
  definitions(config: PipelineConfig, cwd: string): CommandDefinition[] {
    return runRepoIoSync(
      Effect.provide(claudeCodeDefinitions(config, cwd), Path.layer)
    );
  },
  host: "claude-code",
  isAlwaysForced(definition: CommandDefinition): boolean {
    return definition.path === CLAUDE_PROJECT_CONFIG_PATH;
  },
  mergeDefinition(
    definition: CommandDefinition,
    existingContent: string
  ): Option.Option<MergeDefinitionResult> {
    if (definition.path !== CLAUDE_PROJECT_CONFIG_PATH) {
      return Option.none();
    }
    const projection = parseClaudeSettingsProjection(definition.content);
    const merged = mergeClaudeSettings(existingContent, projection);
    if (!merged.ok) {
      return Option.some({ content: definition.content, ok: false });
    }
    return Option.some({ content: merged.content, ok: true });
  },
  resourceRoots: [".claude/commands", ".claude/agents"],
};
