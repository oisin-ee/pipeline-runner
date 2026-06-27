import { flattenNodes } from "../../planning/graph";
import type { AgentResult, RunnerLaunchPlan } from "../../runner";
import {
  type RuntimeActorDescriptor,
  type RuntimeObservabilityEmitter,
  type RuntimeObservabilityEvent,
  runtimeActorId,
} from "../actor-ids";
import type {
  GateSpec,
  PipelineRuntimeEvent,
  PipelineRuntimeObservabilityLevel,
  PipelineRuntimeOptions,
  RuntimeContext,
  RuntimeGateResult,
  RuntimeNodeResult,
  RuntimeStructuredOutput,
} from "../contracts";
import {
  parseRuntimeOutput,
  validateJsonSchemaSource,
} from "../json-validation";

type RuntimeObservabilityType = RuntimeObservabilityEvent["type"];
type RuntimeActorObservabilityEvent = Extract<
  RuntimeObservabilityEvent,
  { type: `runtime.actor.${string}` }
>;
type RuntimeGateObservabilityEvent = Extract<
  RuntimeObservabilityEvent,
  { type: `runtime.gate.${string}` }
>;
type RuntimeHookObservabilityEvent = Extract<
  RuntimeObservabilityEvent,
  { type: `runtime.hook.${string}` }
>;
type RuntimeNodeObservabilityEvent = Extract<
  RuntimeObservabilityEvent,
  { type: `runtime.node.${string}` }
>;
type RuntimeRetryObservabilityEvent = Extract<
  RuntimeObservabilityEvent,
  { type: `runtime.retry.${string}` }
>;
type RuntimeStateObservabilityEvent = Extract<
  RuntimeObservabilityEvent,
  { type: `runtime.state.${string}` }
>;
type RuntimePrimaryObservabilityEvent =
  | RuntimeActorObservabilityEvent
  | RuntimeHookObservabilityEvent
  | RuntimeStateObservabilityEvent;
type RuntimeSecondaryObservabilityEvent = Exclude<
  RuntimeObservabilityEvent,
  RuntimePrimaryObservabilityEvent
>;
type RuntimeGateTerminalObservabilityEvent = Exclude<
  RuntimeGateObservabilityEvent,
  Extract<
    RuntimeGateObservabilityEvent,
    { type: "runtime.gate.finished" | "runtime.gate.started" }
  >
>;
type RuntimeHookTerminalObservabilityEvent = Exclude<
  RuntimeHookObservabilityEvent,
  Extract<
    RuntimeHookObservabilityEvent,
    { type: "runtime.hook.finished" | "runtime.hook.started" }
  >
>;
type PlannedRuntimeNode = RuntimeContext["plan"]["topologicalOrder"][number];
type RuntimeNodeProfile =
  | RuntimeContext["config"]["profiles"][string]
  | undefined;
type StructuredOutputFormat = RuntimeStructuredOutput["format"];

interface RuntimeNodeRunnerFields {
  profile?: string;
  runnerId?: string;
}

const warningRuntimeObservabilityTypes: ReadonlySet<RuntimeObservabilityType> =
  new Set([
    "runtime.gate.cancelled",
    "runtime.gate.failed",
    "runtime.hook.failed",
    "runtime.hook.timedOut",
    "runtime.retry.exhausted",
  ]);
const primaryRuntimeObservabilityPrefixes = [
  "runtime.actor.",
  "runtime.hook.",
  "runtime.state.",
];
const structuredOutputFormats: ReadonlySet<string> = new Set([
  "json",
  "json_schema",
  "jsonl",
]);

export function createPublicRuntimeObservabilityEmitter(
  reporter: (event: PipelineRuntimeEvent) => void,
  workflowId: string
): RuntimeObservabilityEmitter {
  return (event) => {
    reporter(runtimeObservabilityEventToPipelineEvent(event, workflowId));
  };
}

function runtimeObservabilityEventToPipelineEvent(
  event: RuntimeObservabilityEvent,
  workflowId: string
): PipelineRuntimeEvent {
  const nodeId = runtimeObservabilityNodeId(event);
  return {
    actor: event.actor,
    level: runtimeObservabilityLevel(event),
    name: event.type,
    ...(nodeId ? { nodeId } : {}),
    summary: runtimeObservabilitySummary(event),
    type: "runtime.observability",
    workflowId,
  };
}

function runtimeObservabilityLevel(
  event: RuntimeObservabilityEvent
): PipelineRuntimeObservabilityLevel {
  return warningRuntimeObservabilityTypes.has(event.type) ? "warn" : "info";
}

function runtimeObservabilityNodeId(
  event: RuntimeObservabilityEvent
): string | undefined {
  return "nodeId" in event ? event.nodeId : undefined;
}

function runtimeObservabilitySummary(event: RuntimeObservabilityEvent): string {
  return isRuntimePrimaryObservabilityEvent(event)
    ? runtimePrimaryObservabilitySummary(event)
    : runtimeSecondaryObservabilitySummary(event);
}

function isRuntimePrimaryObservabilityEvent(
  event: RuntimeObservabilityEvent
): event is RuntimePrimaryObservabilityEvent {
  return primaryRuntimeObservabilityPrefixes.some((prefix) =>
    event.type.startsWith(prefix)
  );
}

function runtimePrimaryObservabilitySummary(
  event: RuntimePrimaryObservabilityEvent
): string {
  if (isRuntimeActorObservabilityEvent(event)) {
    return runtimeActorObservabilitySummary(event);
  }
  if (isRuntimeHookObservabilityEvent(event)) {
    return runtimeHookObservabilitySummary(event);
  }
  if (isRuntimeStateObservabilityEvent(event)) {
    return runtimeStateObservabilitySummary(event);
  }
  return assertNeverRuntimeObservabilityEvent(event);
}

function runtimeSecondaryObservabilitySummary(
  event: RuntimeSecondaryObservabilityEvent
): string {
  if (isRuntimeGateObservabilityEvent(event)) {
    return runtimeGateObservabilitySummary(event);
  }
  if (isRuntimeNodeObservabilityEvent(event)) {
    return runtimeNodeObservabilitySummary(event);
  }
  if (isRuntimeRetryObservabilityEvent(event)) {
    return runtimeRetryObservabilitySummary(event);
  }
  return assertNeverRuntimeObservabilityEvent(event);
}

function isRuntimeActorObservabilityEvent(
  event: RuntimeObservabilityEvent
): event is RuntimeActorObservabilityEvent {
  return event.type.startsWith("runtime.actor.");
}

function isRuntimeGateObservabilityEvent(
  event: RuntimeObservabilityEvent
): event is RuntimeGateObservabilityEvent {
  return event.type.startsWith("runtime.gate.");
}

function isRuntimeHookObservabilityEvent(
  event: RuntimeObservabilityEvent
): event is RuntimeHookObservabilityEvent {
  return event.type.startsWith("runtime.hook.");
}

function isRuntimeNodeObservabilityEvent(
  event: RuntimeObservabilityEvent
): event is RuntimeNodeObservabilityEvent {
  return event.type.startsWith("runtime.node.");
}

function isRuntimeRetryObservabilityEvent(
  event: RuntimeObservabilityEvent
): event is RuntimeRetryObservabilityEvent {
  return event.type.startsWith("runtime.retry.");
}

function isRuntimeStateObservabilityEvent(
  event: RuntimeObservabilityEvent
): event is RuntimeStateObservabilityEvent {
  return event.type.startsWith("runtime.state.");
}

function runtimeActorObservabilitySummary(
  event: RuntimeActorObservabilityEvent
): string {
  switch (event.type) {
    case "runtime.actor.event":
      return `${event.actor.kind} actor ${event.actor.id} received ${event.eventType}`;
    case "runtime.actor.snapshot":
      return `${event.actor.kind} actor ${event.actor.id} snapshot recorded`;
    default:
      return assertNeverRuntimeObservabilityEvent(event);
  }
}

function runtimeGateObservabilitySummary(
  event: RuntimeGateObservabilityEvent
): string {
  if (event.type === "runtime.gate.started") {
    return `gate ${event.gateId} started for node ${event.nodeId}`;
  }
  if (event.type === "runtime.gate.finished") {
    return `gate ${event.gateId} ${gateOutcome(event)} for node ${event.nodeId}${gateReasonClause(event)}`;
  }
  return runtimeGateTerminalObservabilitySummary(event);
}

function runtimeGateTerminalObservabilitySummary(
  event: RuntimeGateTerminalObservabilityEvent
): string {
  return `gate ${event.gateId} ${gateTerminalOutcome(event)} for node ${event.nodeId}: ${event.reason}`;
}

function gateOutcome(event: { passed: boolean }): string {
  return event.passed ? "passed" : "failed";
}

function gateReasonClause(event: { reason?: string }): string {
  return event.reason ? `: ${event.reason}` : "";
}

function gateTerminalOutcome(
  event: RuntimeGateTerminalObservabilityEvent
): "cancelled" | "failed" {
  return event.type === "runtime.gate.cancelled" ? "cancelled" : "failed";
}

function runtimeHookObservabilitySummary(
  event: RuntimeHookObservabilityEvent
): string {
  if (event.type === "runtime.hook.started") {
    return `hook ${event.hookId} started${hookNodeClause(event)}`;
  }
  if (event.type === "runtime.hook.finished") {
    return `hook ${event.hookId} ${hookOutcome(event)}${hookNodeClause(event)}${hookReasonClause(event)}`;
  }
  return runtimeHookTerminalObservabilitySummary(event);
}

function runtimeHookTerminalObservabilitySummary(
  event: RuntimeHookTerminalObservabilityEvent
): string {
  return `hook ${event.hookId} ${hookTerminalOutcome(event)}${hookNodeClause(event)}: ${event.reason}`;
}

function hookNodeClause(event: { nodeId?: string }): string {
  return event.nodeId ? ` for node ${event.nodeId}` : "";
}

function hookOutcome(event: { passed: boolean }): string {
  return event.passed ? "passed" : "failed";
}

function hookReasonClause(event: { reason?: string }): string {
  return event.reason ? `: ${event.reason}` : "";
}

function hookTerminalOutcome(
  event: RuntimeHookTerminalObservabilityEvent
): "failed" | "skipped" | "timed out" {
  switch (event.type) {
    case "runtime.hook.failed":
      return "failed";
    case "runtime.hook.skipped":
      return "skipped";
    case "runtime.hook.timedOut":
      return "timed out";
    default:
      return assertNeverRuntimeObservabilityEvent(event);
  }
}

function runtimeNodeObservabilitySummary(
  event: RuntimeNodeObservabilityEvent
): string {
  switch (event.type) {
    case "runtime.node.finished":
      return `node ${event.nodeId} finished with status ${event.status}`;
    case "runtime.node.started":
      return `node ${event.nodeId} started`;
    default:
      return assertNeverRuntimeObservabilityEvent(event);
  }
}

function runtimeRetryObservabilitySummary(
  event: RuntimeRetryObservabilityEvent
): string {
  switch (event.type) {
    case "runtime.retry.exhausted":
      return `node ${event.nodeId} retry exhausted after attempt ${event.attempt} (${event.reason})`;
    case "runtime.retry.scheduled":
      return `node ${event.nodeId} retry scheduled for attempt ${event.attempt} (${event.reason})`;
    default:
      return assertNeverRuntimeObservabilityEvent(event);
  }
}

function runtimeStateObservabilitySummary(
  event: RuntimeStateObservabilityEvent
): string {
  switch (event.type) {
    case "runtime.state.enter":
      return `${event.actor.kind} actor ${event.actor.id} entered ${event.state}`;
    case "runtime.state.exit":
      return `${event.actor.kind} actor ${event.actor.id} exited ${event.state}`;
    default:
      return assertNeverRuntimeObservabilityEvent(event);
  }
}

function assertNeverRuntimeObservabilityEvent(event: never): never {
  throw new Error(`Unhandled runtime observability event: ${String(event)}`);
}

export function runtimeSystemId(context: RuntimeContext): string {
  return runtimeActorId("pipeline", {
    runId: context.runId,
    workflowId: context.workflowId,
  });
}

export function runtimeNodeActorDescriptor(
  context: RuntimeContext,
  nodeId: string
): RuntimeActorDescriptor {
  return {
    id: runtimeActorId("node", {
      nodeId,
      runId: context.runId,
      workflowId: context.workflowId,
    }),
    kind: "node",
    systemId: runtimeSystemId(context),
  };
}

export function emit(
  context: RuntimeContext,
  event: PipelineRuntimeEvent
): void {
  context.reporter?.(event);
}

export function emitWorkflowFinish(
  context: RuntimeContext,
  outcome: "CANCELLED" | "FAIL" | "PASS"
): void {
  emit(context, {
    outcome,
    type: "workflow.finish",
    workflowId: context.workflowId,
  });
}

export function emitWorkflowPlanned(context: RuntimeContext): void {
  emit(context, {
    edges: context.plan.topologicalOrder.flatMap((node) =>
      node.needs.map((source) => ({
        source,
        target: node.id,
      }))
    ),
    nodes: context.plan.topologicalOrder.map((node) => {
      const planned = {
        id: node.id,
        kind: node.kind,
        needs: node.needs,
      } as {
        id: string;
        kind: PipelineRuntimeEvent extends infer Event
          ? Event extends { type: "workflow.planned"; nodes: Array<infer Node> }
            ? Node extends { kind: infer Kind }
              ? Kind
              : never
            : never
          : never;
        needs: string[];
        profile?: string;
        runnerId?: string;
      };
      if (node.profile) {
        planned.profile = node.profile;
        const profile = context.config.profiles[node.profile];
        if (profile?.runner) {
          planned.runnerId = profile.runner;
        }
      }
      return planned;
    }),
    type: "workflow.planned",
    workflowId: context.workflowId,
  });
}

export function emitWorkflowStarted(context: RuntimeContext): void {
  emit(context, {
    // Include parallel children so the run-control store registers every node
    // the runtime will report on; otherwise a parallel child's session/result
    // update is rejected as an unknown node id.
    nodeIds: flattenNodes(
      context.plan.topologicalOrder,
      (node) => node.children
    ).map((node) => node.id),
    type: "workflow.start",
    workflowId: context.workflowId,
  });
}

export function emitGateStart(
  context: RuntimeContext,
  nodeId: string,
  gate: GateSpec,
  gateId: string
): void {
  emit(context, {
    gateId,
    kind: gate.kind,
    nodeId,
    type: "gate.start",
  });
  if (gate.kind === "artifact") {
    emit(context, {
      nodeId,
      path: gate.path ?? "",
      required: gate.required !== false,
      type: "artifact.check.start",
    });
  }
}

export function emitGateFinish(
  context: RuntimeContext,
  gate: GateSpec,
  result: RuntimeGateResult
): void {
  emitArtifactGateFinish(context, gate, result);
  emit(context, {
    evidence: result.evidence,
    gateId: result.gateId,
    kind: result.kind,
    nodeId: result.nodeId,
    passed: result.passed,
    type: "gate.finish",
    ...gateResultReasonFields(result),
  });
}

function emitArtifactGateFinish(
  context: RuntimeContext,
  gate: GateSpec,
  result: RuntimeGateResult
): void {
  if (gate.kind !== "artifact") {
    return;
  }
  emit(context, {
    nodeId: result.nodeId,
    passed: result.passed,
    path: gate.path ?? "",
    required: gate.required !== false,
    type: "artifact.check.finish",
    ...gateResultReasonFields(result),
  });
}

function gateResultReasonFields(
  result: RuntimeGateResult
): Pick<Extract<PipelineRuntimeEvent, { type: "gate.finish" }>, "reason"> {
  return result.reason ? { reason: result.reason } : {};
}

export function emitNodeStart(
  context: RuntimeContext,
  node: PlannedRuntimeNode,
  attempt: number
): void {
  const profile = runtimeNodeProfile(context, node);
  emit(context, {
    attempt,
    nodeId: node.id,
    type: "node.start",
    ...runtimeNodeRunnerFields(node, profile),
  });
  context.observability?.({
    actor: runtimeNodeActorDescriptor(context, node.id),
    nodeId: node.id,
    timestamp: now(),
    type: "runtime.node.started",
  });
}

export function emitNodeFinish(
  context: RuntimeContext,
  result: RuntimeNodeResult
): void {
  const node = runtimeNodeById(context, result.nodeId);
  const profile = runtimeNodeProfile(context, node);
  emit(context, {
    attempt: result.attempts,
    exitCode: result.exitCode,
    nodeId: result.nodeId,
    ...runtimeNodeRunnerFields(node, profile),
    status: result.status,
    type: "node.finish",
  });
  context.observability?.({
    actor: runtimeNodeActorDescriptor(context, result.nodeId),
    nodeId: result.nodeId,
    status: result.status,
    timestamp: now(),
    type: "runtime.node.finished",
  });
}

export function emitNodeOutputRecorded(
  context: RuntimeContext,
  node: PlannedRuntimeNode,
  attempt: number,
  output: string
): void {
  const profile = runtimeNodeProfile(context, node);
  const format = runtimeNodeOutputFormat(profile);
  const parsed = parseRuntimeOutput(format, output);
  const event = nodeOutputRecordedEvent({
    attempt,
    format,
    node,
    parsed,
    profile,
  });
  recordStructuredOutput(context, {
    attempt: event.attempt,
    format: event.format,
    nodeId: node.id,
    output: event.output,
    parseError: event.parseError,
    profileId: node.profile,
    schemaPath: event.schemaPath,
  });
  emit(context, event);
}

function runtimeNodeById(
  context: RuntimeContext,
  nodeId: string
): PlannedRuntimeNode | undefined {
  return context.plan.topologicalOrder.find((item) => item.id === nodeId);
}

function runtimeNodeProfile(
  context: RuntimeContext,
  node?: PlannedRuntimeNode
): RuntimeNodeProfile {
  return node?.profile ? context.config.profiles[node.profile] : undefined;
}

function runtimeNodeRunnerFields(
  node?: PlannedRuntimeNode,
  profile?: RuntimeNodeProfile
): RuntimeNodeRunnerFields {
  return {
    ...runtimeNodeProfileField(node),
    ...runtimeNodeRunnerIdField(profile),
  };
}

function runtimeNodeProfileField(
  node?: PlannedRuntimeNode
): Pick<RuntimeNodeRunnerFields, "profile"> {
  return node?.profile ? { profile: node.profile } : {};
}

function runtimeNodeRunnerIdField(
  profile?: RuntimeNodeProfile
): Pick<RuntimeNodeRunnerFields, "runnerId"> {
  return profile?.runner ? { runnerId: profile.runner } : {};
}

function runtimeNodeOutputFormat(profile: RuntimeNodeProfile): string {
  return profile?.output?.format ?? "text";
}

function nodeOutputRecordedEvent(input: {
  attempt: number;
  format: string;
  node: PlannedRuntimeNode;
  parsed: ReturnType<typeof parseRuntimeOutput>;
  profile: RuntimeNodeProfile;
}): Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }> {
  return {
    attempt: input.attempt,
    format: input.format,
    nodeId: input.node.id,
    output: input.parsed.output,
    type: "node.output.recorded",
    ...nodeOutputProfileField(input.node),
    ...nodeOutputSchemaField(input.profile),
    ...nodeOutputParseErrorField(input.parsed),
  };
}

function nodeOutputProfileField(
  node: PlannedRuntimeNode
): Pick<
  Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>,
  "profile"
> {
  return node.profile ? { profile: node.profile } : {};
}

function nodeOutputSchemaField(
  profile: RuntimeNodeProfile
): Pick<
  Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>,
  "schemaPath"
> {
  return profile?.output?.schema_path
    ? { schemaPath: profile.output.schema_path }
    : {};
}

function nodeOutputParseErrorField(
  parsed: ReturnType<typeof parseRuntimeOutput>
): Pick<
  Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>,
  "parseError"
> {
  return parsed.error ? { parseError: parsed.error } : {};
}

function recordStructuredOutput(
  context: RuntimeContext,
  output: {
    attempt: number;
    format: string;
    nodeId: string;
    output: unknown;
    parseError?: string;
    profileId?: string;
    schemaPath?: string;
  }
): void {
  if (!isStructuredOutputFormat(output.format)) {
    return;
  }
  const validation = structuredOutputValidation(context, output);
  context.nodeStateStore.recordStructuredOutput({
    attempt: output.attempt,
    format: output.format,
    nodeId: structuredOutputNodeId(context, output.nodeId),
    output: output.output,
    ...structuredOutputParentFields(context),
    ...structuredOutputProfileFields(output),
    validation,
  });
}

function isStructuredOutputFormat(
  format: string
): format is StructuredOutputFormat {
  return structuredOutputFormats.has(format);
}

function structuredOutputNodeId(
  context: RuntimeContext,
  nodeId: string
): string {
  return context.parentParallelNodeId
    ? `${context.parentParallelNodeId}.${nodeId}`
    : nodeId;
}

function structuredOutputParentFields(
  context: RuntimeContext
): Pick<RuntimeStructuredOutput, "parentParallelNodeId"> {
  return context.parentParallelNodeId
    ? { parentParallelNodeId: context.parentParallelNodeId }
    : {};
}

function structuredOutputProfileFields(output: {
  profileId?: string;
  schemaPath?: string;
}): Pick<RuntimeStructuredOutput, "profileId" | "schemaPath"> {
  return {
    ...(output.profileId ? { profileId: output.profileId } : {}),
    ...(output.schemaPath ? { schemaPath: output.schemaPath } : {}),
  };
}

function structuredOutputValidation(
  context: RuntimeContext,
  output: {
    output: unknown;
    parseError?: string;
    schemaPath?: string;
  }
): RuntimeStructuredOutput["validation"] {
  if (output.parseError) {
    return {
      evidence: [output.parseError],
      passed: false,
      reason: "structured output parse failed",
      status: "invalid",
    };
  }
  return output.schemaPath
    ? structuredOutputSchemaValidation(
        context,
        output.output,
        output.schemaPath
      )
    : {
        evidence: ["structured output has no schema"],
        passed: true,
        status: "not_applicable",
      };
}

function structuredOutputSchemaValidation(
  context: RuntimeContext,
  output: unknown,
  schemaPath: string
): RuntimeStructuredOutput["validation"] {
  const validation = validateJsonSchemaSource(
    JSON.stringify(output),
    schemaPath,
    context.worktreePath
  );
  return {
    evidence: validation.evidence,
    passed: validation.passed,
    ...(validation.reason ? { reason: validation.reason } : {}),
    status: validation.passed ? "valid" : "invalid",
  };
}

export function emitAgentStart(
  context: RuntimeContext,
  plan: RunnerLaunchPlan,
  attempt: number
): void {
  emit(context, {
    attempt,
    nodeId: plan.nodeId,
    type: "agent.start",
    ...(plan.profileId ? { profile: plan.profileId } : {}),
    runnerId: plan.runnerId,
  });
}

export function emitAgentFinish(
  context: RuntimeContext,
  plan: RunnerLaunchPlan,
  attempt: number,
  result: AgentResult
): void {
  emit(context, {
    attempt,
    exitCode: result.exitCode,
    nodeId: plan.nodeId,
    type: "agent.finish",
    ...(plan.profileId ? { profile: plan.profileId } : {}),
    runnerId: plan.runnerId,
  });
}

export function childReporter(
  context: RuntimeContext,
  parentNodeId: string
): PipelineRuntimeOptions["reporter"] {
  if (!context.reporter) {
    return;
  }
  return (event) => {
    context.reporter?.(prefixChildRuntimeEvent(parentNodeId, event));
  };
}

function prefixChildRuntimeEvent(
  parentNodeId: string,
  event: PipelineRuntimeEvent
): PipelineRuntimeEvent {
  return prefixWorkflowGraphEvent(
    parentNodeId,
    prefixNodeIdsEvent(parentNodeId, prefixNodeIdEvent(parentNodeId, event))
  );
}

function prefixNodeIdEvent(
  parentNodeId: string,
  event: PipelineRuntimeEvent
): PipelineRuntimeEvent {
  return "nodeId" in event && typeof event.nodeId === "string"
    ? {
        ...event,
        nodeId: prefixedChildNodeId(parentNodeId, event.nodeId),
        parentNodeId,
      }
    : { ...event, parentNodeId };
}

function prefixNodeIdsEvent(
  parentNodeId: string,
  event: PipelineRuntimeEvent
): PipelineRuntimeEvent {
  return event.type === "workflow.start"
    ? {
        ...event,
        nodeIds: event.nodeIds.map((nodeId) =>
          prefixedChildNodeId(parentNodeId, nodeId)
        ),
      }
    : event;
}

function prefixWorkflowGraphEvent(
  parentNodeId: string,
  event: PipelineRuntimeEvent
): PipelineRuntimeEvent {
  return event.type === "workflow.planned"
    ? {
        ...event,
        edges: event.edges.map((edge) => ({
          source: prefixedChildNodeId(parentNodeId, edge.source),
          target: prefixedChildNodeId(parentNodeId, edge.target),
        })),
        nodes: event.nodes.map((node) => ({
          ...node,
          id: prefixedChildNodeId(parentNodeId, node.id),
        })),
      }
    : event;
}

function prefixedChildNodeId(parentNodeId: string, nodeId: string): string {
  return `${parentNodeId}.${nodeId}`;
}

function now(): string {
  return new Date().toISOString();
}
