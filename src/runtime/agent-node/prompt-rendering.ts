import { Effect } from "effect";
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
  values: (profile: AgentProfile | undefined) => string[] | undefined;
}

const PROFILE_GRANT_DESCRIPTORS: readonly ProfileGrantDescriptor[] = [
  { label: "tools", values: (profile) => profile?.tools },
  { label: "rules", values: (profile) => profile?.rules },
  { label: "skills", values: (profile) => profile?.skills },
  { label: "mcp_servers", values: (profile) => profile?.mcp_servers },
];

const RUNTIME_PATH_RESOLVERS: Record<
  NonNullable<PathReference["source_root"]>,
  RuntimePathResolver
> = {
  package: (_worktreePath, path) => resolvePackageAssetPath(path),
  project: (worktreePath, path) => resolveFileReference(worktreePath, path),
};

export function renderAgentPromptEffect(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Effect.Effect<string, unknown, AgentNodeRuntimeService> {
  return Effect.gen(function* () {
    const profile = node.profile
      ? context.config.profiles[node.profile]
      : undefined;
    const instructions = profile
      ? yield* readInstructionsEffect(
          context.worktreePath,
          profile.instructions
        )
      : "";
    const repoMap = yield* repoMapSectionEffect(node, context);
    const pathReferences = yield* renderProfilePathReferences(profile, context);
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
}

function repoMapSectionEffect(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Effect.Effect<string, never, AgentNodeRuntimeService> {
  const repoMap = context.config.repo_map;
  if (!repoMap?.enabled) {
    return Effect.succeed("");
  }
  return Effect.gen(function* () {
    const service = yield* AgentNodeRuntimeService;
    const result = yield* Effect.tryPromise({
      catch: () => "",
      try: () =>
        service.buildRepoMap({
          artifacts: node.needs.flatMap(
            (need) => context.nodeStateStore.handoff(need)?.artifacts ?? []
          ),
          taskText: context.task,
          tokenBudget: repoMap.token_budget,
          worktreePath: context.worktreePath,
        }),
    });
    return result.context;
  }).pipe(Effect.catch(() => Effect.succeed("")));
}

function agentPromptSections(inputs: {
  context: RuntimeContext;
  instructions: string;
  node: PlannedWorkflowNode;
  pathReferences: string[];
  profile: AgentProfile | undefined;
  repoMap: string;
}): string[] {
  const { context, instructions, node, pathReferences, profile, repoMap } =
    inputs;
  return [
    ...runtimeInstructionSections(instructions, repoMap),
    ...nodeIdentitySections(context, node),
    renderTaskContext(effectiveTaskContext(node, context)),
    renderDeferredDeliverySection(node, context),
    renderProfileOutputContract(profile, context.worktreePath),
    renderGateOutputContract(node),
    "",
    "Declared grants:",
    ...profileGrantLines(profile),
    ...pathReferences,
    renderMcpReferences(context.config, profile),
    "",
    ...dependencyOutputSections(node, context),
  ];
}

function runtimeInstructionSections(
  instructions: string,
  repoMap: string
): string[] {
  return [instructions.trim(), "", repoMap];
}

function nodeIdentitySections(
  context: RuntimeContext,
  node: PlannedWorkflowNode
): string[] {
  return [
    `Task: ${context.task}`,
    `Workflow: ${context.workflowId}`,
    `Node: ${node.id}`,
    profileSection(node.profile),
  ];
}

function profileSection(profileId: string | undefined): string {
  return profileId ? `Profile: ${profileId}` : "";
}

function profileGrantLines(profile: AgentProfile | undefined): string[] {
  return PROFILE_GRANT_DESCRIPTORS.map((descriptor) =>
    grantLine(descriptor.label, descriptor.values(profile))
  );
}

function grantLine(label: string, values: string[] | undefined): string {
  const rendered = values?.join(", ") || "none";
  return `- ${label}: ${rendered}`;
}

function renderProfilePathReferences(
  profile: AgentProfile | undefined,
  context: RuntimeContext
): Effect.Effect<string[], unknown, AgentNodeRuntimeService> {
  return Effect.all([
    renderPathReferencesEffect(
      "Loaded rules",
      profile?.rules,
      context.config.rules,
      context.worktreePath
    ),
    renderPathReferencesEffect(
      "Loaded skills",
      profile?.skills,
      context.config.skills,
      context.worktreePath
    ),
  ]);
}

function renderDependencySection(
  nodeId: string,
  context: Pick<RuntimeContext, "nodeStateStore">
): string {
  const handoff = context.nodeStateStore.handoff(nodeId);
  return handoff
    ? renderHandoff(nodeId, handoff)
    : `## ${nodeId}\n${context.nodeStateStore.outputText(nodeId)}`;
}

function renderGateOutputContract(node: PlannedWorkflowNode): string {
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
}

function hasStdoutAcceptanceGate(node: PlannedWorkflowNode): boolean {
  return (node.gates ?? []).some(
    (gate) =>
      gate.kind === "acceptance" &&
      (gate.target === undefined || gate.target === "stdout")
  );
}

function acceptanceGateOutputContract(): string {
  return [
    "",
    "Gate output contract:",
    "Return only valid JSON. Do not use Markdown fences or add prose outside the JSON object.",
    'Top-level fields: "verdict" ("PASS" or "FAIL"), "evidence" (string array), "acceptance" (array), optional "violations" (string array).',
    'Each "acceptance" entry must include "id", "verdict" ("PASS" or "FAIL"), and non-empty "evidence" (string array) for every canonical acceptance criterion id.',
    'Use top-level "verdict":"PASS" only when every required acceptance criterion passes with evidence.',
  ].join("\n");
}

function renderDeferredDeliverySection(
  node: PlannedWorkflowNode,
  context: Pick<RuntimeContext, "plan">
): string {
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
}

function downstreamBuiltinIds(
  node: PlannedWorkflowNode,
  topologicalOrder: readonly PlannedWorkflowNode[],
  builtin: string
): string[] {
  const nodesById = new Map(
    topologicalOrder.map((candidate) => [candidate.id, candidate])
  );
  const seen = new Set<string>();
  const pending = [...node.dependents];
  const matches: string[] = [];
  while (pending.length > 0) {
    const id = pending.shift();
    if (!id || seen.has(id)) {
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
}

function verdictGateOutputContract(): string {
  return [
    "",
    "Gate output contract:",
    "Return only valid JSON. Do not use Markdown fences or add prose outside the JSON object.",
    'Top-level fields: "verdict" ("PASS" or "FAIL"), "evidence" (string array), optional "violations" (string array).',
    'Use "verdict":"PASS" only when the verification or review passes.',
  ].join("\n");
}

function renderProfileOutputContract(
  profile: AgentProfile | undefined,
  worktreePath: string
): string {
  const schema = profileOutputSchemaSource(profile, worktreePath);
  return schema ? profileOutputContract(schema) : "";
}

function profileOutputSchemaSource(
  profile: AgentProfile | undefined,
  worktreePath: string
): string | undefined {
  if (!profile) {
    return;
  }
  return outputSchemaSource(profile.output, worktreePath);
}

function outputSchemaSource(
  output: AgentProfile["output"] | undefined,
  worktreePath: string
): string | undefined {
  if (!output) {
    return;
  }
  if (output.format !== "json_schema") {
    return;
  }
  return output.schema_path
    ? readJsonSchemaSource(output.schema_path, worktreePath)
    : undefined;
}

function profileOutputContract(schema: string): string {
  return [
    "",
    "Profile output contract:",
    "Return only valid JSON matching the expected schema.",
    "Do not use Markdown fences or add prose outside the JSON object.",
    "",
    "Expected schema:",
    schema,
  ].join("\n");
}

function effectiveTaskContext(
  node: PlannedWorkflowNode,
  context: Pick<RuntimeContext, "taskContext">
): PipelineTaskContext | undefined {
  return node.taskContext ?? context.taskContext;
}

function inheritedOutputSections(
  node: PlannedWorkflowNode,
  context: Pick<RuntimeContext, "nodeStateStore">
): string[] {
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
}

function dependencyOutputSections(
  node: PlannedWorkflowNode,
  context: Pick<RuntimeContext, "nodeStateStore">
): string[] {
  return [
    ...inheritedOutputSections(node, context),
    "Dependency outputs:",
    ...node.needs.map((need) => renderDependencySection(need, context)),
  ];
}

function renderTaskContext(
  taskContext: PipelineTaskContext | undefined
): string {
  if (!taskContext) {
    return "";
  }
  return [
    "",
    "Canonical task context:",
    ...taskContextSummaryLines(taskContext),
    ...acceptanceCriterionLines(taskContext),
  ]
    .filter(Boolean)
    .join("\n");
}

function taskContextSummaryLines(taskContext: PipelineTaskContext): string[] {
  return [
    optionalLine("ID", taskContext.id),
    optionalLine("Title", taskContext.title),
    optionalLine("Description", taskContext.description),
  ];
}

function optionalLine(label: string, value: string | undefined): string {
  return value ? `${label}: ${value}` : "";
}

function acceptanceCriterionLines(taskContext: PipelineTaskContext): string[] {
  const acceptance = taskContext.acceptanceCriteria ?? [];
  return acceptance.length
    ? [
        "Acceptance criteria:",
        ...acceptance.map(
          (criterion) => `- ${criterion.id}: ${criterion.text}`
        ),
      ]
    : [];
}

function readInstructionsEffect(
  worktreePath: string,
  instructions: AgentProfile["instructions"]
): Effect.Effect<string, unknown, AgentNodeRuntimeService> {
  if (instructions.inline) {
    return Effect.succeed(instructions.inline);
  }
  if (instructions.path) {
    const instructionPath = instructions.path;
    return AgentNodeRuntimeService.pipe(
      Effect.flatMap((service) =>
        service.readText(resolveFileReference(worktreePath, instructionPath))
      )
    );
  }
  return Effect.succeed("");
}

function renderPathReferencesEffect(
  heading: string,
  ids: string[] | undefined,
  registry: Record<
    string,
    { path: string; source_root?: "package" | "project" }
  >,
  worktreePath: string
): Effect.Effect<string, unknown, AgentNodeRuntimeService> {
  if (!ids?.length) {
    return Effect.succeed("");
  }
  return Effect.gen(function* () {
    const sections = yield* Effect.all(
      ids.map((id) => renderPathReferenceEffect(id, registry, worktreePath))
    );
    return ["", `${heading}:`, ...sections].join("\n");
  });
}

function renderPathReferenceEffect(
  id: string,
  registry: Record<
    string,
    { path: string; source_root?: "package" | "project" }
  >,
  worktreePath: string
): Effect.Effect<string, unknown, AgentNodeRuntimeService> {
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
}

function resolveRuntimePathReference(
  worktreePath: string,
  ref: PathReference | undefined
): string {
  return RUNTIME_PATH_RESOLVERS[pathSourceRoot(ref)](
    worktreePath,
    pathReferenceValue(ref)
  );
}

function pathSourceRoot(
  ref: PathReference | undefined
): NonNullable<PathReference["source_root"]> {
  return ref?.source_root ?? "project";
}

function pathReferenceValue(ref: PathReference | undefined): string {
  return ref?.path ?? "";
}

function renderMcpReferences(
  config: PipelineConfig,
  profile: AgentProfile | undefined
): string {
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
}

function renderMcpServerReference(id: string, server: McpServer): string {
  if (isHttpMcpServer(server)) {
    return renderHttpMcpServerReference(id, server);
  }
  return renderStdioMcpServerReference(id, server);
}

function isHttpMcpServer(
  server: McpServer
): server is NonNullable<McpServer> & { url: string } {
  return typeof server?.url === "string" && server.url.length > 0;
}

function renderHttpMcpServerReference(
  id: string,
  server: NonNullable<McpServer> & { url: string }
): string {
  return [
    `## ${id}`,
    "transport: http",
    `url: ${server.url}`,
    `headers: ${renderObjectKeys(server.headers)}`,
    `bearer_token_env_var: ${server.bearer_token_env_var ?? "none"}`,
  ].join("\n");
}

function renderStdioMcpServerReference(id: string, server: McpServer): string {
  const fields = stdioMcpServerFields(server);
  return [
    `## ${id}`,
    "transport: stdio",
    `command: ${fields.command}`,
    `args: ${fields.args}`,
    `env: ${fields.env}`,
  ].join("\n");
}

function stdioMcpServerFields(server: McpServer): {
  args: string;
  command: string;
  env: string;
} {
  if (!server) {
    return { args: "none", command: "", env: "none" };
  }
  return populatedStdioMcpServerFields(server);
}

function populatedStdioMcpServerFields(server: NonNullable<McpServer>): {
  args: string;
  command: string;
  env: string;
} {
  return {
    args: renderList(server.args),
    command: server.command ?? "",
    env: renderObjectKeys(server.env),
  };
}

function renderList(values: string[] | undefined): string {
  return values?.join(" ") || "none";
}

function renderObjectKeys(value: Record<string, unknown> | undefined): string {
  return Object.keys(value ?? {}).join(", ") || "none";
}
