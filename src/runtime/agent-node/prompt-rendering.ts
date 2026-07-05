import { Effect, Option } from "effect";

import type { PipelineConfig } from "../../config";
import { gatewayServerForProfile } from "../../mcp/gateway-config";
import { resolvePackageAssetPath } from "../../package-assets";
import { resolveFileReference } from "../../path-refs";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { PipelineTaskContext, RuntimeContext } from "../contracts";
import { renderHandoff } from "../handoff";
import { readJsonSchemaSource } from "../json-validation";
import { AgentNodeRuntimeService } from "../services/agent-node-runtime-service";

type AgentProfile = PipelineConfig["profiles"][string];
interface PathReference {
  path?: string;
  source_root?: "package" | "project";
}

type RuntimePathResolver = (worktreePath: string, path: string) => string;
type McpServer = ReturnType<typeof gatewayServerForProfile>[string];

const OPEN_PULL_REQUEST_BUILTIN = "open-pull-request";

interface ProfileGrantDescriptor {
  label: string;
  values: (profile?: AgentProfile) => string[];
}

const PROFILE_GRANT_DESCRIPTORS: readonly ProfileGrantDescriptor[] = [
  { label: "tools", values: (profile) => profile?.tools ?? [] },
  { label: "rules", values: (profile) => profile?.rules ?? [] },
  { label: "skills", values: (profile) => profile?.skills ?? [] },
  { label: "mcp_servers", values: (profile) => profile?.mcp_servers ?? [] },
];

const RUNTIME_PATH_RESOLVERS: Record<
  NonNullable<PathReference["source_root"]>,
  RuntimePathResolver
> = {
  package: (_worktreePath, path) => resolvePackageAssetPath(path),
  project: (worktreePath, path) => resolveFileReference(worktreePath, path),
};

const repoMapSectionEffect = (
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Effect.Effect<string, never, AgentNodeRuntimeService> => {
  const repoMap = context.config.repo_map;
  if (repoMap === undefined || !repoMap.enabled) {
    return Effect.succeed("");
  }
  return Effect.gen(function* effectBody() {
    const service = yield* AgentNodeRuntimeService;
    const result = yield* Effect.tryPromise({
      catch: () => "",
      try: async () =>
        await service.buildRepoMap({
          artifacts: node.needs.flatMap((need) =>
            Option.match(context.nodeStateStore.handoff(need), {
              onNone: () => [],
              onSome: (handoff) => handoff.artifacts,
            })
          ),
          taskText: context.task,
          tokenBudget: repoMap.token_budget,
          worktreePath: context.worktreePath,
        }),
    });
    return result.context;
  }).pipe(Effect.catch(() => Effect.succeed("")));
};

const runtimeInstructionSections = (
  instructions: string,
  repoMap: string
): string[] => [instructions.trim(), "", repoMap];

const profileSection = (profileId?: string): string =>
  profileId === undefined || profileId.length === 0
    ? ""
    : `Profile: ${profileId}`;

const nodeIdentitySections = (
  context: RuntimeContext,
  node: PlannedWorkflowNode
): string[] => [
  `Task: ${context.task}`,
  `Workflow: ${context.workflowId}`,
  `Node: ${node.id}`,
  profileSection(node.profile),
];

const grantLine = (label: string, values: string[]): string => {
  const rendered = values.length > 0 ? values.join(", ") : "none";
  return `- ${label}: ${rendered}`;
};

const profileGrantLines = (profile?: AgentProfile): string[] =>
  PROFILE_GRANT_DESCRIPTORS.map((descriptor) =>
    grantLine(descriptor.label, descriptor.values(profile))
  );

const renderDependencySection = (
  nodeId: string,
  context: Pick<RuntimeContext, "nodeStateStore">
): string => {
  return Option.match(context.nodeStateStore.handoff(nodeId), {
    onNone: () => `## ${nodeId}\n${context.nodeStateStore.outputText(nodeId)}`,
    onSome: (handoff) => renderHandoff(nodeId, handoff),
  });
};

const hasStdoutAcceptanceGate = (node: PlannedWorkflowNode): boolean =>
  (node.gates ?? []).some(
    (gate) =>
      gate.kind === "acceptance" &&
      (gate.target === undefined || gate.target === "stdout")
  );

const acceptanceGateOutputContract = (): string =>
  [
    "",
    "Gate output contract:",
    "Return only valid JSON. Do not use Markdown fences or add prose outside the JSON object.",
    'Top-level fields: "verdict" ("PASS" or "FAIL"), "evidence" (string array), "acceptance" (array), optional "violations" (string array).',
    'Each "acceptance" entry must include "id", "verdict" ("PASS" or "FAIL"), and non-empty "evidence" (string array) for every canonical acceptance criterion id.',
    'Use top-level "verdict":"PASS" only when every required acceptance criterion passes with evidence.',
  ].join("\n");

const downstreamBuiltinIds = (
  node: PlannedWorkflowNode,
  topologicalOrder: readonly PlannedWorkflowNode[],
  builtin: string
): string[] => {
  const nodesById = new Map(
    topologicalOrder.map((candidate) => [candidate.id, candidate])
  );
  const seen = new Set<string>();
  const pending = [...node.dependents];
  const matches: string[] = [];
  while (pending.length > 0) {
    const id = pending.shift();
    if (id === undefined || id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const candidate = nodesById.get(id);
    if (!candidate) {
      continue;
    }
    if (candidate.kind === "builtin" && candidate.builtin === builtin) {
      matches.push(candidate.id);
    }
    pending.push(...candidate.dependents);
  }
  return matches;
};

const renderDeferredDeliverySection = (
  node: PlannedWorkflowNode,
  context: Pick<RuntimeContext, "plan">
): string => {
  if (hasStdoutAcceptanceGate(node)) {
    return "";
  }
  const deliveryNodeIds = downstreamBuiltinIds(
    node,
    context.plan.topologicalOrder,
    OPEN_PULL_REQUEST_BUILTIN
  );
  if (deliveryNodeIds.length === 0) {
    return "";
  }
  return [
    "",
    "Deferred delivery checks:",
    `- Downstream node(s) ${deliveryNodeIds.join(", ")} own pull-request creation after this node.`,
    "- Do not fail this node solely because a pull request does not exist yet.",
    "- Verify only code, tests, review evidence, and artifacts available before delivery.",
    "- Leave PR existence/URL evidence to downstream delivery or acceptance nodes.",
  ].join("\n");
};

const verdictGateOutputContract = (): string =>
  [
    "",
    "Gate output contract:",
    "Return only valid JSON. Do not use Markdown fences or add prose outside the JSON object.",
    'Top-level fields: "verdict" ("PASS" or "FAIL"), "evidence" (string array), optional "violations" (string array).',
    'Use "verdict":"PASS" only when the verification or review passes.',
  ].join("\n");

const renderGateOutputContract = (node: PlannedWorkflowNode): string => {
  if (hasStdoutAcceptanceGate(node)) {
    return acceptanceGateOutputContract();
  }
  const gates = node.gates ?? [];
  const hasVerdictGate = gates.some(
    (gate) =>
      gate.kind === "verdict" &&
      (gate.target === undefined || gate.target === "stdout")
  );
  return hasVerdictGate ? verdictGateOutputContract() : "";
};

const outputSchemaSource = (
  worktreePath: string,
  output?: AgentProfile["output"]
): Option.Option<string> => {
  if (output === undefined) {
    return Option.none();
  }
  if (output.format !== "json_schema") {
    return Option.none();
  }
  return output.schema_path === undefined || output.schema_path.length === 0
    ? Option.none()
    : Option.some(readJsonSchemaSource(output.schema_path, worktreePath));
};

const profileOutputSchemaSource = (
  worktreePath: string,
  profile?: AgentProfile
): Option.Option<string> => {
  if (profile === undefined) {
    return Option.none();
  }
  return outputSchemaSource(worktreePath, profile.output);
};

const profileOutputContract = (schema: string): string =>
  [
    "",
    "Profile output contract:",
    "Return only valid JSON matching the expected schema.",
    "Do not use Markdown fences or add prose outside the JSON object.",
    "",
    "Expected schema:",
    schema,
  ].join("\n");

const renderProfileOutputContract = (
  worktreePath: string,
  profile?: AgentProfile
): string => {
  const schema = profileOutputSchemaSource(worktreePath, profile);
  return Option.match(schema, {
    onNone: () => "",
    onSome: profileOutputContract,
  });
};

const effectiveTaskContext = (
  node: PlannedWorkflowNode,
  context: Pick<RuntimeContext, "taskContext">
): Option.Option<PipelineTaskContext> =>
  Option.orElse(Option.fromUndefinedOr(node.taskContext), () =>
    Option.fromUndefinedOr(context.taskContext)
  );

const inheritedOutputSections = (
  node: PlannedWorkflowNode,
  context: Pick<RuntimeContext, "nodeStateStore">
): string[] => {
  const inherited = context.nodeStateStore.inheritedOutputIdsExcluding(
    node.needs
  );
  if (inherited.length === 0) {
    return [];
  }
  return [
    "Inherited dependency outputs:",
    ...inherited.map((id) => renderDependencySection(id, context)),
    "",
  ];
};

const dependencyOutputSections = (
  node: PlannedWorkflowNode,
  context: Pick<RuntimeContext, "nodeStateStore">
): string[] => [
  ...inheritedOutputSections(node, context),
  "Dependency outputs:",
  ...node.needs.map((need) => renderDependencySection(need, context)),
];

const optionalLine = (label: string, value?: string): string =>
  value === undefined || value.length === 0 ? "" : `${label}: ${value}`;

const taskContextSummaryLines = (
  taskContext: PipelineTaskContext
): string[] => [
  optionalLine("ID", taskContext.id),
  optionalLine("Title", taskContext.title),
  optionalLine("Description", taskContext.description),
];

const acceptanceCriterionLines = (
  taskContext: PipelineTaskContext
): string[] => {
  const acceptance = taskContext.acceptanceCriteria ?? [];
  return acceptance.length > 0
    ? [
        "Acceptance criteria:",
        ...acceptance.map(
          (criterion) => `- ${criterion.id}: ${criterion.text}`
        ),
      ]
    : [];
};

const renderTaskContext = (
  taskContext: Option.Option<PipelineTaskContext>
): string =>
  Option.match(taskContext, {
    onNone: () => "",
    onSome: (value) =>
      [
        "",
        "Canonical task context:",
        ...taskContextSummaryLines(value),
        ...acceptanceCriterionLines(value),
      ]
        .filter(Boolean)
        .join("\n"),
  });

const readInstructionsEffect = (
  worktreePath: string,
  instructions: AgentProfile["instructions"]
): Effect.Effect<string, unknown, AgentNodeRuntimeService> => {
  if (instructions.inline !== undefined && instructions.inline.length > 0) {
    return Effect.succeed(instructions.inline);
  }
  if (instructions.path !== undefined && instructions.path.length > 0) {
    const instructionPath = instructions.path;
    return AgentNodeRuntimeService.pipe(
      Effect.flatMap((service) =>
        service.readText(resolveFileReference(worktreePath, instructionPath))
      )
    );
  }
  return Effect.succeed("");
};

const pathSourceRoot = (
  ref?: PathReference
): NonNullable<PathReference["source_root"]> => ref?.source_root ?? "project";

const pathReferenceValue = (ref?: PathReference): string => ref?.path ?? "";

const resolveRuntimePathReference = (
  worktreePath: string,
  ref?: PathReference
): string =>
  RUNTIME_PATH_RESOLVERS[pathSourceRoot(ref)](
    worktreePath,
    pathReferenceValue(ref)
  );

const renderPathReferenceEffect = (
  id: string,
  registry: Partial<
    Record<string, { path: string; source_root?: "package" | "project" }>
  >,
  worktreePath: string
): Effect.Effect<string, unknown, AgentNodeRuntimeService> => {
  const ref = registry[id];
  const path = ref?.path ?? "";
  const resolved = resolveRuntimePathReference(worktreePath, ref);
  return AgentNodeRuntimeService.pipe(
    Effect.flatMap((service) => service.readText(resolved)),
    Effect.map((content) =>
      [`## ${id}`, `Path: ${path}`, "", content.trimEnd()].join("\n")
    ),
    Effect.catchCause(() =>
      Effect.succeed(
        [
          `## ${id}`,
          `Path: ${path}`,
          "",
          "(install-managed harness asset; loaded by the host agent runtime)",
        ].join("\n")
      )
    )
  );
};

const renderPathReferencesEffect = (
  heading: string,
  registry: Partial<
    Record<string, { path: string; source_root?: "package" | "project" }>
  >,
  worktreePath: string,
  ids?: string[]
): Effect.Effect<string, unknown, AgentNodeRuntimeService> => {
  if (ids === undefined || ids.length === 0) {
    return Effect.succeed("");
  }
  return Effect.gen(function* effectBody() {
    const sections = yield* Effect.all(
      ids.map((id) => renderPathReferenceEffect(id, registry, worktreePath))
    );
    return ["", `${heading}:`, ...sections].join("\n");
  });
};

const renderProfilePathReferences = (
  context: RuntimeContext,
  profile?: AgentProfile
): Effect.Effect<string[], unknown, AgentNodeRuntimeService> =>
  Effect.all([
    renderPathReferencesEffect(
      "Loaded rules",
      context.config.rules,
      context.worktreePath,
      profile?.rules
    ),
    renderPathReferencesEffect(
      "Loaded skills",
      context.config.skills,
      context.worktreePath,
      profile?.skills
    ),
  ]);

const isHttpMcpServer = (
  server: McpServer
): server is NonNullable<McpServer> & { url: string } =>
  typeof server.url === "string" && server.url.length > 0;

const renderList = (values?: string[]): string => values?.join(" ") ?? "none";

const renderObjectKeys = (value?: Record<string, unknown>): string =>
  Object.keys(value ?? {}).join(", ") || "none";

const renderHttpMcpServerReference = (
  id: string,
  server: NonNullable<McpServer> & { url: string }
): string =>
  [
    `## ${id}`,
    "transport: http",
    `url: ${server.url}`,
    `headers: ${renderObjectKeys(server.headers)}`,
    `bearer_token_env_var: ${server.bearer_token_env_var ?? "none"}`,
  ].join("\n");

const populatedStdioMcpServerFields = (
  server: NonNullable<McpServer>
): {
  args: string;
  command: string;
  env: string;
} => ({
  args: renderList(server.args),
  command: server.command ?? "",
  env: renderObjectKeys(server.env),
});

const stdioMcpServerFields = (
  server: McpServer
): {
  args: string;
  command: string;
  env: string;
} => populatedStdioMcpServerFields(server);

const renderStdioMcpServerReference = (
  id: string,
  server: McpServer
): string => {
  const fields = stdioMcpServerFields(server);
  return [
    `## ${id}`,
    "transport: stdio",
    `command: ${fields.command}`,
    `args: ${fields.args}`,
    `env: ${fields.env}`,
  ].join("\n");
};

const renderMcpServerReference = (id: string, server: McpServer): string => {
  if (isHttpMcpServer(server)) {
    return renderHttpMcpServerReference(id, server);
  }
  return renderStdioMcpServerReference(id, server);
};

const renderMcpReferences = (
  config: PipelineConfig,
  profile?: AgentProfile
): string => {
  const servers = gatewayServerForProfile(config, profile);
  if (Object.keys(servers).length === 0) {
    return "";
  }
  return [
    "",
    "Loaded MCP servers:",
    ...Object.entries(servers).map(([id, server]) =>
      renderMcpServerReference(id, server)
    ),
  ].join("\n");
};

const agentPromptSections = (inputs: {
  context: RuntimeContext;
  instructions: string;
  node: PlannedWorkflowNode;
  pathReferences: string[];
  profile?: AgentProfile;
  repoMap: string;
}): string[] => {
  const { context, instructions, node, pathReferences, profile, repoMap } =
    inputs;
  return [
    ...runtimeInstructionSections(instructions, repoMap),
    ...nodeIdentitySections(context, node),
    renderTaskContext(effectiveTaskContext(node, context)),
    renderDeferredDeliverySection(node, context),
    renderProfileOutputContract(context.worktreePath, profile),
    renderGateOutputContract(node),
    "",
    "Declared grants:",
    ...profileGrantLines(profile),
    ...pathReferences,
    renderMcpReferences(context.config, profile),
    "",
    ...dependencyOutputSections(node, context),
  ];
};

export const renderAgentPromptEffect = (
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Effect.Effect<string, unknown, AgentNodeRuntimeService> =>
  Effect.gen(function* effectBody() {
    const profile =
      node.profile !== undefined && node.profile.length > 0
        ? context.config.profiles[node.profile]
        : undefined;
    const instructions =
      profile === undefined
        ? ""
        : yield* readInstructionsEffect(
            context.worktreePath,
            profile.instructions
          );
    const repoMap = yield* repoMapSectionEffect(node, context);
    const pathReferences = yield* renderProfilePathReferences(context, profile);
    return agentPromptSections({
      context,
      instructions,
      node,
      pathReferences,
      profile,
      repoMap,
    })
      .filter(Boolean)
      .join("\n");
  });
