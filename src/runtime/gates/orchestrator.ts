import { Effect } from "effect";

import type { PlannedWorkflowNode } from "../../planning/compile";
import { runtimeActorId } from "../actor-ids";
import type {
  GateSpec,
  NodeAttemptResult,
  RuntimeContext,
  RuntimeGateResult,
} from "../contracts";
import { emitGateFinish, emitGateStart, runtimeSystemId } from "../events";
import {
  CommandExecutor,
  CommandExecutorLive,
} from "../services/command-executor-service";
import type { CommandExecutorService, GateFailureHook } from "./contract";
import { evaluateGate } from "./registry";

type GateLoopAction = "continue" | "stop";

const recordGateResult = (
  context: RuntimeContext,
  gate: GateSpec,
  result: RuntimeGateResult,
  results: RuntimeGateResult[]
): void => {
  context.gates.push(result);
  results.push(result);
  emitGateFinish(context, gate, result);
};

const handleGateFailure = async (
  gate: GateSpec,
  node: PlannedWorkflowNode,
  result: RuntimeGateResult,
  onGateFailure?: GateFailureHook
): Promise<GateLoopAction> => {
  if (result.passed) {
    return "continue";
  }
  if (onGateFailure) {
    await onGateFailure(node, result);
  }
  return gate.required === false ? "continue" : "stop";
};

const resolveGateResult = async (
  gate: GateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  executor: CommandExecutorService
): Promise<RuntimeGateResult> => {
  try {
    const node = context.plan.graph.node(nodeId);
    return await evaluateGate({
      attempt,
      context,
      executor,
      gate,
      gateId,
      node,
      nodeId,
    });
  } catch (error) {
    return {
      evidence: [error instanceof Error ? error.message : String(error)],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: false,
      reason: error instanceof Error ? error.message : "gate evaluation failed",
    };
  }
};

const runtimeGateActor = (
  context: RuntimeContext,
  gateId: string,
  nodeId: string
) => ({
  id: runtimeActorId("gate", {
    gateId,
    nodeId,
    runId: context.runId,
    workflowId: context.workflowId,
  }),
  kind: "gate" as const,
  systemId: runtimeSystemId(context),
});

const runtimeTimestamp = (): string => new Date().toISOString();

const emitRuntimeGateStarted = (
  context: RuntimeContext,
  gate: GateSpec,
  gateId: string,
  nodeId: string
): void => {
  context.observability?.({
    actor: runtimeGateActor(context, gateId, nodeId),
    gateId,
    kind: gate.kind,
    nodeId,
    timestamp: runtimeTimestamp(),
    type: "runtime.gate.started",
  });
};

const emitRuntimeGateResult = (
  context: RuntimeContext,
  result: RuntimeGateResult
): void => {
  const actor = runtimeGateActor(context, result.gateId, result.nodeId);
  context.observability?.({
    actor,
    gateId: result.gateId,
    kind: result.kind,
    nodeId: result.nodeId,
    passed: result.passed,
    reason: result.reason,
    timestamp: runtimeTimestamp(),
    type: "runtime.gate.finished",
  });
  if (!result.passed) {
    context.observability?.({
      actor,
      gateId: result.gateId,
      kind: result.kind,
      nodeId: result.nodeId,
      reason: result.reason ?? "gate failed",
      timestamp: runtimeTimestamp(),
      type: "runtime.gate.failed",
    });
  }
};

const runGateEvaluation = async (
  gate: GateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  executor: CommandExecutorService
): Promise<RuntimeGateResult> => {
  emitRuntimeGateStarted(context, gate, gateId, nodeId);
  const result = await resolveGateResult(
    gate,
    gateId,
    nodeId,
    context,
    attempt,
    executor
  );
  emitRuntimeGateResult(context, result);
  return result;
};

const runObservedGate = async (
  gate: GateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  executor: CommandExecutorService
): Promise<RuntimeGateResult> => {
  emitGateStart(context, nodeId, gate, gateId);
  return await runGateEvaluation(
    gate,
    gateId,
    nodeId,
    context,
    attempt,
    executor
  );
};

const emitRuntimeGateCancelled = (
  context: RuntimeContext,
  gate: GateSpec,
  gateId: string,
  nodeId: string,
  reason: string
): void => {
  context.observability?.({
    actor: runtimeGateActor(context, gateId, nodeId),
    gateId,
    kind: gate.kind,
    nodeId,
    reason,
    timestamp: runtimeTimestamp(),
    type: "runtime.gate.cancelled",
  });
};

const artifactGateSpecs = (node: PlannedWorkflowNode): GateSpec[] =>
  (node.artifacts ?? []).map(
    (artifact): GateSpec => ({
      id: `artifact:${artifact.path}`,
      kind: "artifact",
      path: artifact.path,
      required: artifact.required,
    })
  );

const schemaGateSpecs = (
  node: PlannedWorkflowNode,
  context: RuntimeContext
): GateSpec[] => {
  const profile =
    node.profile !== undefined && node.profile.length > 0
      ? context.config.profiles[node.profile]
      : undefined;
  if (
    profile?.output?.format !== "json_schema" ||
    profile.output.schema_path === undefined ||
    profile.output.schema_path.length === 0
  ) {
    return [];
  }
  return [
    {
      id: `output:${node.id}`,
      kind: "json_schema",
      schema_path: profile.output.schema_path,
      target: "stdout",
    },
  ];
};

const nodeGateSpecs = (
  node: PlannedWorkflowNode,
  context: RuntimeContext
): GateSpec[] => [
  ...(node.gates ?? []),
  ...artifactGateSpecs(node),
  ...schemaGateSpecs(node, context),
];

const isCancelled = (context: RuntimeContext): boolean =>
  context.signal?.aborted === true;

const evaluateNodeGateIteration = async (
  gate: GateSpec,
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  executor: CommandExecutorService,
  results: RuntimeGateResult[],
  onGateFailure?: GateFailureHook
): Promise<GateLoopAction> => {
  const gateId = gate.id ?? `${gate.kind}:${node.id}`;
  if (isCancelled(context)) {
    emitRuntimeGateCancelled(context, gate, gateId, node.id, "gate cancelled");
    return "stop";
  }
  const result = await runObservedGate(
    gate,
    gateId,
    node.id,
    context,
    attempt,
    executor
  );
  recordGateResult(context, gate, result, results);
  return await handleGateFailure(gate, node, result, onGateFailure);
};

const evaluateNodeGatesWithExecutor = async (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  executor: CommandExecutorService,
  onGateFailure?: GateFailureHook
): Promise<RuntimeGateResult[]> => {
  const results: RuntimeGateResult[] = [];
  for (const gate of nodeGateSpecs(node, context)) {
    const action = await evaluateNodeGateIteration(
      gate,
      node,
      context,
      attempt,
      executor,
      results,
      onGateFailure
    );
    if (action === "stop") {
      break;
    }
  }
  return results;
};

const evaluateNodeGatesEffect = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  onGateFailure?: GateFailureHook
): Effect.Effect<RuntimeGateResult[], unknown, CommandExecutor> =>
  Effect.gen(function* effectBody() {
    const executor = yield* CommandExecutor;
    return yield* Effect.tryPromise(
      async () =>
        await evaluateNodeGatesWithExecutor(
          node,
          context,
          attempt,
          executor,
          onGateFailure
        )
    );
  });

export const evaluateNodeGates = async (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  onGateFailure?: GateFailureHook
): Promise<RuntimeGateResult[]> =>
  await Effect.runPromise(
    Effect.provide(
      evaluateNodeGatesEffect(node, context, attempt, onGateFailure),
      CommandExecutorLive
    )
  );
