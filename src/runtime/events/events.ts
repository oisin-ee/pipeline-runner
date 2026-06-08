import type { AgentResult, RunnerLaunchPlan } from "../../runner";
import {
  type RuntimeActorDescriptor,
  type RuntimeObservabilityEmitter,
  type RuntimeObservabilityEvent,
  runtimeActorId,
} from "../../runtime-machines/contracts";
import {
  createRuntimeInspectionBridge,
  type XStateInspectionEvent,
} from "../../runtime-observability-inspection";
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
  isRecord,
  parseRuntimeOutput,
  validateJsonSchemaSource,
} from "../json-validation";

export function createPublicRuntimeObservabilityEmitter(
  reporter: (event: PipelineRuntimeEvent) => void,
  workflowId: string
): RuntimeObservabilityEmitter {
  return (event) => {
    reporter(runtimeObservabilityEventToPipelineEvent(event, workflowId));
  };
}

export function runtimeObservabilityEventToPipelineEvent(
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
  switch (event.type) {
    case "runtime.gate.cancelled":
    case "runtime.gate.failed":
    case "runtime.hook.failed":
    case "runtime.hook.timedOut":
    case "runtime.retry.exhausted":
      return "warn";
    default:
      return "info";
  }
}

function runtimeObservabilityNodeId(
  event: RuntimeObservabilityEvent
): string | undefined {
  switch (event.type) {
    case "runtime.gate.cancelled":
    case "runtime.gate.failed":
    case "runtime.gate.finished":
    case "runtime.gate.started":
    case "runtime.hook.failed":
    case "runtime.hook.finished":
    case "runtime.hook.skipped":
    case "runtime.hook.started":
    case "runtime.hook.timedOut":
    case "runtime.node.finished":
    case "runtime.node.started":
    case "runtime.retry.exhausted":
    case "runtime.retry.scheduled":
      return event.nodeId;
    default:
      return;
  }
}

function runtimeObservabilitySummary(event: RuntimeObservabilityEvent): string {
  switch (event.type) {
    case "runtime.actor.event":
      return `${event.actor.kind} actor ${event.actor.id} received ${event.eventType}`;
    case "runtime.actor.snapshot":
      return `${event.actor.kind} actor ${event.actor.id} snapshot recorded`;
    case "runtime.gate.cancelled":
      return `gate ${event.gateId} cancelled for node ${event.nodeId}: ${event.reason}`;
    case "runtime.gate.failed":
      return `gate ${event.gateId} failed for node ${event.nodeId}: ${event.reason}`;
    case "runtime.gate.finished":
      return `gate ${event.gateId} ${event.passed ? "passed" : "failed"} for node ${event.nodeId}${event.reason ? `: ${event.reason}` : ""}`;
    case "runtime.gate.started":
      return `gate ${event.gateId} started for node ${event.nodeId}`;
    case "runtime.hook.failed":
      return `hook ${event.hookId} failed${event.nodeId ? ` for node ${event.nodeId}` : ""}: ${event.reason}`;
    case "runtime.hook.finished":
      return `hook ${event.hookId} ${event.passed ? "passed" : "failed"}${event.nodeId ? ` for node ${event.nodeId}` : ""}${event.reason ? `: ${event.reason}` : ""}`;
    case "runtime.hook.skipped":
      return `hook ${event.hookId} skipped${event.nodeId ? ` for node ${event.nodeId}` : ""}: ${event.reason}`;
    case "runtime.hook.started":
      return `hook ${event.hookId} started${event.nodeId ? ` for node ${event.nodeId}` : ""}`;
    case "runtime.hook.timedOut":
      return `hook ${event.hookId} timed out${event.nodeId ? ` for node ${event.nodeId}` : ""}: ${event.reason}`;
    case "runtime.node.finished":
      return `node ${event.nodeId} finished with status ${event.status}`;
    case "runtime.node.started":
      return `node ${event.nodeId} started`;
    case "runtime.retry.exhausted":
      return `node ${event.nodeId} retry exhausted after attempt ${event.attempt} (${event.reason})`;
    case "runtime.retry.scheduled":
      return `node ${event.nodeId} retry scheduled for attempt ${event.attempt} (${event.reason})`;
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

export function runtimeInspection(
  context: RuntimeContext
): ((event: XStateInspectionEvent) => void) | undefined {
  return context.observability
    ? createRuntimeInspectionBridge({
        emit: context.observability,
      })
    : undefined;
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
  if (gate.kind === "artifact") {
    emit(context, {
      nodeId: result.nodeId,
      passed: result.passed,
      path: gate.path ?? "",
      required: gate.required !== false,
      type: "artifact.check.finish",
      ...(result.reason ? { reason: result.reason } : {}),
    });
  }
  emit(context, {
    evidence: result.evidence,
    gateId: result.gateId,
    kind: result.kind,
    nodeId: result.nodeId,
    passed: result.passed,
    type: "gate.finish",
    ...(result.reason ? { reason: result.reason } : {}),
  });
}

export function emitNodeStart(
  context: RuntimeContext,
  node: RuntimeContext["plan"]["topologicalOrder"][number],
  attempt: number
): void {
  const profile = node.profile
    ? context.config.profiles[node.profile]
    : undefined;
  emit(context, {
    attempt,
    nodeId: node.id,
    type: "node.start",
    ...(node.profile ? { profile: node.profile } : {}),
    ...(profile?.runner ? { runnerId: profile.runner } : {}),
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
  const node = context.plan.topologicalOrder.find(
    (item) => item.id === result.nodeId
  );
  const profile = node?.profile
    ? context.config.profiles[node.profile]
    : undefined;
  emit(context, {
    attempt: result.attempts,
    exitCode: result.exitCode,
    nodeId: result.nodeId,
    ...(node?.profile ? { profile: node.profile } : {}),
    ...(profile?.runner ? { runnerId: profile.runner } : {}),
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
  node: RuntimeContext["plan"]["topologicalOrder"][number],
  attempt: number,
  output: string
): void {
  const profile = node.profile
    ? context.config.profiles[node.profile]
    : undefined;
  const format = profile?.output?.format ? profile.output.format : "text";
  const parsed = parseRuntimeOutput(format, output);
  const event: Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }> =
    {
      attempt,
      format,
      nodeId: node.id,
      output: parsed.output,
      type: "node.output.recorded",
    };
  if (node.profile) {
    event.profile = node.profile;
  }
  if (profile?.output?.schema_path) {
    event.schemaPath = profile.output.schema_path;
  }
  if (parsed.error) {
    event.parseError = parsed.error;
  }
  recordStructuredOutput(context, {
    attempt,
    format,
    nodeId: node.id,
    output: parsed.output,
    parseError: parsed.error,
    profileId: node.profile,
    schemaPath: profile?.output?.schema_path,
  });
  emit(context, event);
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
  if (
    output.format !== "json" &&
    output.format !== "json_schema" &&
    output.format !== "jsonl"
  ) {
    return;
  }
  const validation = structuredOutputValidation(context, output);
  const nodeId = context.parentParallelNodeId
    ? `${context.parentParallelNodeId}.${output.nodeId}`
    : output.nodeId;
  context.structuredOutputs.push({
    attempt: output.attempt,
    format: output.format,
    nodeId,
    output: output.output,
    ...(context.parentParallelNodeId
      ? { parentParallelNodeId: context.parentParallelNodeId }
      : {}),
    ...(output.profileId ? { profileId: output.profileId } : {}),
    ...(output.schemaPath ? { schemaPath: output.schemaPath } : {}),
    validation,
  });
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
  if (!output.schemaPath) {
    return {
      evidence: ["structured output has no schema"],
      passed: true,
      status: "not_applicable",
    };
  }
  const validation = validateJsonSchemaSource(
    JSON.stringify(output.output),
    output.schemaPath,
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

export function prefixChildRuntimeEvent(
  parentNodeId: string,
  event: PipelineRuntimeEvent
): PipelineRuntimeEvent {
  const prefixed = { ...event } as Record<string, unknown>;
  prefixed.parentNodeId = parentNodeId;
  if (typeof prefixed.nodeId === "string") {
    prefixed.nodeId = `${parentNodeId}.${prefixed.nodeId}`;
  }
  if (Array.isArray(prefixed.nodeIds)) {
    prefixed.nodeIds = prefixed.nodeIds.map((id) =>
      typeof id === "string" ? `${parentNodeId}.${id}` : id
    );
  }
  if (Array.isArray(prefixed.nodes)) {
    prefixed.nodes = prefixed.nodes.map((child) =>
      isRecord(child) && typeof child.id === "string"
        ? { ...child, id: `${parentNodeId}.${child.id}` }
        : child
    );
  }
  if (Array.isArray(prefixed.edges)) {
    prefixed.edges = prefixed.edges.map((edge) =>
      isRecord(edge)
        ? {
            ...edge,
            source:
              typeof edge.source === "string"
                ? `${parentNodeId}.${edge.source}`
                : edge.source,
            target:
              typeof edge.target === "string"
                ? `${parentNodeId}.${edge.target}`
                : edge.target,
          }
        : edge
    );
  }
  return prefixed as PipelineRuntimeEvent;
}

function now(): string {
  return new Date().toISOString();
}
