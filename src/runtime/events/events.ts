import { Option } from "effect";

import { flattenNodes } from "../../planning/graph";
import type { AgentResult, RunnerLaunchPlan } from "../../runner";
import { runtimeActorId } from "../actor-ids";
import type {
  RuntimeActorDescriptor,
  RuntimeObservabilityEmitter,
  RuntimeObservabilityEvent,
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
type RuntimeNodeProfile = RuntimeContext["config"]["profiles"][string];
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

const runtimeObservabilityLevel = (
  event: RuntimeObservabilityEvent
): PipelineRuntimeObservabilityLevel =>
  warningRuntimeObservabilityTypes.has(event.type) ? "warn" : "info";

const runtimeObservabilityNodeId = (
  event: RuntimeObservabilityEvent
): Option.Option<string> =>
  "nodeId" in event ? Option.fromUndefinedOr(event.nodeId) : Option.none();

const isRuntimePrimaryObservabilityEvent = (
  event: RuntimeObservabilityEvent
): event is RuntimePrimaryObservabilityEvent =>
  primaryRuntimeObservabilityPrefixes.some((prefix) =>
    event.type.startsWith(prefix)
  );

const isRuntimeActorObservabilityEvent = (
  event: RuntimeObservabilityEvent
): event is RuntimeActorObservabilityEvent =>
  event.type.startsWith("runtime.actor.");

const isRuntimeGateObservabilityEvent = (
  event: RuntimeObservabilityEvent
): event is RuntimeGateObservabilityEvent =>
  event.type.startsWith("runtime.gate.");

const isRuntimeHookObservabilityEvent = (
  event: RuntimeObservabilityEvent
): event is RuntimeHookObservabilityEvent =>
  event.type.startsWith("runtime.hook.");

const isRuntimeNodeObservabilityEvent = (
  event: RuntimeObservabilityEvent
): event is RuntimeNodeObservabilityEvent =>
  event.type.startsWith("runtime.node.");

const isRuntimeRetryObservabilityEvent = (
  event: RuntimeObservabilityEvent
): event is RuntimeRetryObservabilityEvent =>
  event.type.startsWith("runtime.retry.");

const isRuntimeStateObservabilityEvent = (
  event: RuntimeObservabilityEvent
): event is RuntimeStateObservabilityEvent =>
  event.type.startsWith("runtime.state.");

const gateOutcome = (event: { passed: boolean }): string =>
  event.passed ? "passed" : "failed";

const gateReasonClause = (event: { reason?: string }): string =>
  event.reason === undefined || event.reason.length === 0
    ? ""
    : `: ${event.reason}`;

const gateTerminalOutcome = (
  event: RuntimeGateTerminalObservabilityEvent
): "cancelled" | "failed" =>
  event.type === "runtime.gate.cancelled" ? "cancelled" : "failed";

const runtimeGateTerminalObservabilitySummary = (
  event: RuntimeGateTerminalObservabilityEvent
): string =>
  `gate ${event.gateId} ${gateTerminalOutcome(event)} for node ${event.nodeId}: ${event.reason}`;

const runtimeGateObservabilitySummary = (
  event: RuntimeGateObservabilityEvent
): string => {
  if (event.type === "runtime.gate.started") {
    return `gate ${event.gateId} started for node ${event.nodeId}`;
  }
  if (event.type === "runtime.gate.finished") {
    return `gate ${event.gateId} ${gateOutcome(event)} for node ${event.nodeId}${gateReasonClause(event)}`;
  }
  return runtimeGateTerminalObservabilitySummary(event);
};

const hookNodeClause = (event: { nodeId?: string }): string =>
  event.nodeId === undefined || event.nodeId.length === 0
    ? ""
    : ` for node ${event.nodeId}`;

const hookOutcome = (event: { passed: boolean }): string =>
  event.passed ? "passed" : "failed";

const hookReasonClause = (event: { reason?: string }): string =>
  event.reason === undefined || event.reason.length === 0
    ? ""
    : `: ${event.reason}`;

const assertNeverRuntimeObservabilityEvent = (event: never): never => {
  throw new Error(`Unhandled runtime observability event: ${String(event)}`);
};

const runtimeActorObservabilitySummary = (
  event: RuntimeActorObservabilityEvent
): string => {
  switch (event.type) {
    case "runtime.actor.event": {
      return `${event.actor.kind} actor ${event.actor.id} received ${event.eventType}`;
    }
    case "runtime.actor.snapshot": {
      return `${event.actor.kind} actor ${event.actor.id} snapshot recorded`;
    }
    default: {
      return assertNeverRuntimeObservabilityEvent(event);
    }
  }
};

const hookTerminalOutcome = (
  event: RuntimeHookTerminalObservabilityEvent
): "failed" | "skipped" | "timed out" => {
  switch (event.type) {
    case "runtime.hook.failed": {
      return "failed";
    }
    case "runtime.hook.skipped": {
      return "skipped";
    }
    case "runtime.hook.timedOut": {
      return "timed out";
    }
    default: {
      return assertNeverRuntimeObservabilityEvent(event);
    }
  }
};

const runtimeHookTerminalObservabilitySummary = (
  event: RuntimeHookTerminalObservabilityEvent
): string =>
  `hook ${event.hookId} ${hookTerminalOutcome(event)}${hookNodeClause(event)}: ${event.reason}`;

const runtimeHookObservabilitySummary = (
  event: RuntimeHookObservabilityEvent
): string => {
  if (event.type === "runtime.hook.started") {
    return `hook ${event.hookId} started${hookNodeClause(event)}`;
  }
  if (event.type === "runtime.hook.finished") {
    return `hook ${event.hookId} ${hookOutcome(event)}${hookNodeClause(event)}${hookReasonClause(event)}`;
  }
  return runtimeHookTerminalObservabilitySummary(event);
};

const runtimeNodeObservabilitySummary = (
  event: RuntimeNodeObservabilityEvent
): string => {
  switch (event.type) {
    case "runtime.node.finished": {
      return `node ${event.nodeId} finished with status ${event.status}`;
    }
    case "runtime.node.started": {
      return `node ${event.nodeId} started`;
    }
    default: {
      return assertNeverRuntimeObservabilityEvent(event);
    }
  }
};

const runtimeRetryObservabilitySummary = (
  event: RuntimeRetryObservabilityEvent
): string => {
  switch (event.type) {
    case "runtime.retry.exhausted": {
      return `node ${event.nodeId} retry exhausted after attempt ${event.attempt} (${event.reason})`;
    }
    case "runtime.retry.scheduled": {
      return `node ${event.nodeId} retry scheduled for attempt ${event.attempt} (${event.reason})`;
    }
    default: {
      return assertNeverRuntimeObservabilityEvent(event);
    }
  }
};

const runtimeSecondaryObservabilitySummary = (
  event: RuntimeSecondaryObservabilityEvent
): string => {
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
};

const runtimeStateObservabilitySummary = (
  event: RuntimeStateObservabilityEvent
): string => {
  switch (event.type) {
    case "runtime.state.enter": {
      return `${event.actor.kind} actor ${event.actor.id} entered ${event.state}`;
    }
    case "runtime.state.exit": {
      return `${event.actor.kind} actor ${event.actor.id} exited ${event.state}`;
    }
    default: {
      return assertNeverRuntimeObservabilityEvent(event);
    }
  }
};

const runtimePrimaryObservabilitySummary = (
  event: RuntimePrimaryObservabilityEvent
): string => {
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
};

const runtimeObservabilitySummary = (
  event: RuntimeObservabilityEvent
): string =>
  isRuntimePrimaryObservabilityEvent(event)
    ? runtimePrimaryObservabilitySummary(event)
    : runtimeSecondaryObservabilitySummary(event);

const runtimeObservabilityEventToPipelineEvent = (
  event: RuntimeObservabilityEvent,
  workflowId: string
): PipelineRuntimeEvent => {
  const nodeId = runtimeObservabilityNodeId(event);
  return {
    actor: event.actor,
    level: runtimeObservabilityLevel(event),
    name: event.type,
    ...Option.match(nodeId, {
      onNone: () => ({}),
      onSome: (value) => ({ nodeId: value }),
    }),
    summary: runtimeObservabilitySummary(event),
    type: "runtime.observability",
    workflowId,
  };
};

export const createPublicRuntimeObservabilityEmitter =
  (
    reporter: (event: PipelineRuntimeEvent) => void,
    workflowId: string
  ): RuntimeObservabilityEmitter =>
  (event) => {
    reporter(runtimeObservabilityEventToPipelineEvent(event, workflowId));
  };

export const runtimeSystemId = (context: RuntimeContext): string =>
  runtimeActorId("pipeline", {
    runId: context.runId,
    workflowId: context.workflowId,
  });

export const runtimeNodeActorDescriptor = (
  context: RuntimeContext,
  nodeId: string
): RuntimeActorDescriptor => ({
  id: runtimeActorId("node", {
    nodeId,
    runId: context.runId,
    workflowId: context.workflowId,
  }),
  kind: "node",
  systemId: runtimeSystemId(context),
});

export const emit = (
  context: RuntimeContext,
  event: PipelineRuntimeEvent
): void => {
  context.reporter?.(event);
};

export const emitWorkflowFinish = (
  context: RuntimeContext,
  outcome: "CANCELLED" | "FAIL" | "PASS"
): void => {
  emit(context, {
    outcome,
    type: "workflow.finish",
    workflowId: context.workflowId,
  });
};

export const emitWorkflowPlanned = (context: RuntimeContext): void => {
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
          ? Event extends { type: "workflow.planned"; nodes: (infer Node)[] }
            ? Node extends { kind: infer Kind }
              ? Kind
              : never
            : never
          : never;
        needs: string[];
        profile?: string;
        runnerId?: string;
      };
      if (node.profile !== undefined && node.profile.length > 0) {
        planned.profile = node.profile;
        const profile = context.config.profiles[node.profile];
        if (profile.runner.length > 0) {
          planned.runnerId = profile.runner;
        }
      }
      return planned;
    }),
    type: "workflow.planned",
    workflowId: context.workflowId,
  });
};

export const emitWorkflowStarted = (context: RuntimeContext): void => {
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
};

export const emitGateStart = (
  context: RuntimeContext,
  nodeId: string,
  gate: GateSpec,
  gateId: string
): void => {
  emit(context, {
    gateId,
    kind: gate.kind,
    nodeId,
    type: "gate.start",
  });
  if (gate.kind === "artifact") {
    emit(context, {
      nodeId,
      path: gate.path,
      required: gate.required !== false,
      type: "artifact.check.start",
    });
  }
};

const gateResultReasonFields = (
  result: RuntimeGateResult
): Pick<Extract<PipelineRuntimeEvent, { type: "gate.finish" }>, "reason"> =>
  result.reason === undefined || result.reason.length === 0
    ? {}
    : { reason: result.reason };

const emitArtifactGateFinish = (
  context: RuntimeContext,
  gate: GateSpec,
  result: RuntimeGateResult
): void => {
  if (gate.kind !== "artifact") {
    return;
  }
  emit(context, {
    nodeId: result.nodeId,
    passed: result.passed,
    path: gate.path,
    required: gate.required !== false,
    type: "artifact.check.finish",
    ...gateResultReasonFields(result),
  });
};

export const emitGateFinish = (
  context: RuntimeContext,
  gate: GateSpec,
  result: RuntimeGateResult
): void => {
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
};

const runtimeNodeById = (
  context: RuntimeContext,
  nodeId: string
): Option.Option<PlannedRuntimeNode> =>
  Option.fromNullishOr(
    context.plan.topologicalOrder.find((item) => item.id === nodeId)
  );

const runtimeNodeProfile = (
  context: RuntimeContext,
  node: Option.Option<PlannedRuntimeNode>
): Option.Option<RuntimeNodeProfile> =>
  node.pipe(
    Option.flatMap((value) =>
      value.profile === undefined || value.profile.length === 0
        ? Option.none()
        : Option.some(context.config.profiles[value.profile])
    )
  );

const runtimeNodeProfileField = (
  node: Option.Option<PlannedRuntimeNode>
): Pick<RuntimeNodeRunnerFields, "profile"> =>
  Option.match(node, {
    onNone: () => ({}),
    onSome: (value) =>
      value.profile === undefined || value.profile.length === 0
        ? {}
        : { profile: value.profile },
  });

const runtimeNodeRunnerIdField = (
  profile: Option.Option<RuntimeNodeProfile>
): Pick<RuntimeNodeRunnerFields, "runnerId"> =>
  Option.match(profile, {
    onNone: () => ({}),
    onSome: (value) =>
      value.runner.length === 0 ? {} : { runnerId: value.runner },
  });

const runtimeNodeRunnerFields = (
  node: Option.Option<PlannedRuntimeNode>,
  profile: Option.Option<RuntimeNodeProfile>
): RuntimeNodeRunnerFields => ({
  ...runtimeNodeProfileField(node),
  ...runtimeNodeRunnerIdField(profile),
});

const runtimeNodeOutputFormat = (
  profile: Option.Option<RuntimeNodeProfile>
): string =>
  Option.match(profile, {
    onNone: () => "text",
    onSome: (value) => value.output?.format ?? "text",
  });

const nodeOutputProfileField = (
  node: PlannedRuntimeNode
): Pick<
  Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>,
  "profile"
> =>
  node.profile === undefined || node.profile.length === 0
    ? {}
    : { profile: node.profile };

const nodeOutputSchemaField = (
  profile: Option.Option<RuntimeNodeProfile>
): Pick<
  Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>,
  "schemaPath"
> =>
  Option.match(profile, {
    onNone: () => ({}),
    onSome: (value) =>
      value.output?.schema_path === undefined ||
      value.output.schema_path.length === 0
        ? {}
        : { schemaPath: value.output.schema_path },
  });

const nodeOutputParseErrorField = (
  parsed: ReturnType<typeof parseRuntimeOutput>
): Pick<
  Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>,
  "parseError"
> =>
  parsed.error === undefined || parsed.error.length === 0
    ? {}
    : { parseError: parsed.error };

const nodeOutputRecordedEvent = (input: {
  attempt: number;
  format: string;
  node: PlannedRuntimeNode;
  parsed: ReturnType<typeof parseRuntimeOutput>;
  profile: Option.Option<RuntimeNodeProfile>;
}): Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }> => ({
  attempt: input.attempt,
  format: input.format,
  nodeId: input.node.id,
  output: input.parsed.output,
  type: "node.output.recorded",
  ...nodeOutputProfileField(input.node),
  ...nodeOutputSchemaField(input.profile),
  ...nodeOutputParseErrorField(input.parsed),
});

const isStructuredOutputFormat = (
  format: string
): format is StructuredOutputFormat => structuredOutputFormats.has(format);

const structuredOutputNodeId = (
  context: RuntimeContext,
  nodeId: string
): string =>
  context.parentParallelNodeId !== undefined &&
  context.parentParallelNodeId.length > 0
    ? `${context.parentParallelNodeId}.${nodeId}`
    : nodeId;

const structuredOutputParentFields = (
  context: RuntimeContext
): Pick<RuntimeStructuredOutput, "parentParallelNodeId"> =>
  context.parentParallelNodeId !== undefined &&
  context.parentParallelNodeId.length > 0
    ? { parentParallelNodeId: context.parentParallelNodeId }
    : {};

const structuredOutputProfileFields = (output: {
  profileId?: string;
  schemaPath?: string;
}): Pick<RuntimeStructuredOutput, "profileId" | "schemaPath"> => ({
  ...(output.profileId === undefined || output.profileId.length === 0
    ? {}
    : { profileId: output.profileId }),
  ...(output.schemaPath === undefined || output.schemaPath.length === 0
    ? {}
    : { schemaPath: output.schemaPath }),
});

const structuredOutputSchemaValidation = (
  context: RuntimeContext,
  output: unknown,
  schemaPath: string
): RuntimeStructuredOutput["validation"] => {
  const validation = validateJsonSchemaSource(
    JSON.stringify(output),
    schemaPath,
    context.worktreePath
  );
  return {
    evidence: validation.evidence,
    passed: validation.passed,
    ...(validation.reason === undefined || validation.reason.length === 0
      ? {}
      : { reason: validation.reason }),
    status: validation.passed ? "valid" : "invalid",
  };
};

const structuredOutputValidation = (
  context: RuntimeContext,
  output: {
    output: unknown;
    parseError?: string;
    schemaPath?: string;
  }
): RuntimeStructuredOutput["validation"] => {
  if (output.parseError !== undefined && output.parseError.length > 0) {
    return {
      evidence: [output.parseError],
      passed: false,
      reason: "structured output parse failed",
      status: "invalid",
    };
  }
  return output.schemaPath !== undefined && output.schemaPath.length > 0
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
};

const recordStructuredOutput = (
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
): void => {
  if (!isStructuredOutputFormat(output.format)) {
    return;
  }
  const validation = structuredOutputValidation(context, output);
  context.nodeStateStore.structuredOutputs.push({
    attempt: output.attempt,
    format: output.format,
    nodeId: structuredOutputNodeId(context, output.nodeId),
    output: output.output,
    ...structuredOutputParentFields(context),
    ...structuredOutputProfileFields(output),
    validation,
  });
};

export const emitNodeOutputRecorded = (
  context: RuntimeContext,
  node: PlannedRuntimeNode,
  attempt: number,
  output: string
): void => {
  const profile = runtimeNodeProfile(context, Option.some(node));
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
};

export const emitAgentStart = (
  context: RuntimeContext,
  plan: RunnerLaunchPlan,
  attempt: number
): void => {
  emit(context, {
    attempt,
    nodeId: plan.nodeId,
    type: "agent.start",
    ...(plan.profileId === undefined || plan.profileId.length === 0
      ? {}
      : { profile: plan.profileId }),
    runnerId: plan.runnerId,
  });
};

export const emitAgentFinish = (
  context: RuntimeContext,
  plan: RunnerLaunchPlan,
  attempt: number,
  result: AgentResult
): void => {
  emit(context, {
    attempt,
    exitCode: result.exitCode,
    nodeId: plan.nodeId,
    type: "agent.finish",
    ...(plan.profileId === undefined || plan.profileId.length === 0
      ? {}
      : { profile: plan.profileId }),
    runnerId: plan.runnerId,
  });
};

const prefixedChildNodeId = (parentNodeId: string, nodeId: string): string =>
  `${parentNodeId}.${nodeId}`;

const prefixNodeIdEvent = (
  parentNodeId: string,
  event: PipelineRuntimeEvent
): PipelineRuntimeEvent =>
  "nodeId" in event && typeof event.nodeId === "string"
    ? {
        ...event,
        nodeId: prefixedChildNodeId(parentNodeId, event.nodeId),
        parentNodeId,
      }
    : { ...event, parentNodeId };

const prefixNodeIdsEvent = (
  parentNodeId: string,
  event: PipelineRuntimeEvent
): PipelineRuntimeEvent =>
  event.type === "workflow.start"
    ? {
        ...event,
        nodeIds: event.nodeIds.map((nodeId) =>
          prefixedChildNodeId(parentNodeId, nodeId)
        ),
      }
    : event;

const prefixWorkflowGraphEvent = (
  parentNodeId: string,
  event: PipelineRuntimeEvent
): PipelineRuntimeEvent =>
  event.type === "workflow.planned"
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

const prefixChildRuntimeEvent = (
  parentNodeId: string,
  event: PipelineRuntimeEvent
): PipelineRuntimeEvent =>
  prefixWorkflowGraphEvent(
    parentNodeId,
    prefixNodeIdsEvent(parentNodeId, prefixNodeIdEvent(parentNodeId, event))
  );

export const childReporter = (
  context: RuntimeContext,
  parentNodeId: string
): PipelineRuntimeOptions["reporter"] => {
  if (context.reporter === undefined) {
    return undefined;
  }
  return (event) => {
    context.reporter?.(prefixChildRuntimeEvent(parentNodeId, event));
  };
};

const now = (): string => new Date().toISOString();

export const emitNodeStart = (
  context: RuntimeContext,
  node: PlannedRuntimeNode,
  attempt: number
): void => {
  const profile = runtimeNodeProfile(context, Option.some(node));
  emit(context, {
    attempt,
    nodeId: node.id,
    type: "node.start",
    ...runtimeNodeRunnerFields(Option.some(node), profile),
  });
  context.observability?.({
    actor: runtimeNodeActorDescriptor(context, node.id),
    nodeId: node.id,
    timestamp: now(),
    type: "runtime.node.started",
  });
};

export const emitNodeFinish = (
  context: RuntimeContext,
  result: RuntimeNodeResult
): void => {
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
};
