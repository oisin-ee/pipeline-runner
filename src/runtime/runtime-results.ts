import type {
  NodeExecutionState,
  PipelineRuntimeResult,
  RuntimeContext,
  RuntimeFailure,
  RuntimeNodeResult,
  RuntimeStructuredOutput,
} from "./contracts";

export function workflowRuntimeResult(
  context: RuntimeContext,
  outcome: PipelineRuntimeResult["outcome"],
  nodes: RuntimeNodeResult[],
  failure?: RuntimeFailure
): PipelineRuntimeResult {
  if (outcome === "CANCELLED") {
    return cancelledRuntimeResult(context, nodes);
  }
  if (outcome === "FAIL") {
    return failedRuntimeResult(
      context,
      nodes,
      failure ?? workflowRuntimeFailure()
    );
  }
  return passedRuntimeResult(context, nodes);
}

function passedRuntimeResult(
  context: RuntimeContext,
  nodes: RuntimeNodeResult[]
): PipelineRuntimeResult {
  return {
    agentInvocations: context.agentInvocations,
    failureDetails: [],
    gates: context.gates,
    hookFailures: context.hookFailures,
    nodeStates: runtimeNodeStates(context),
    nodes,
    outcome: "PASS",
    plan: context.plan,
    structuredOutputs: runtimeStructuredOutputs(context),
  };
}

function failedRuntimeResult(
  context: RuntimeContext,
  nodes: RuntimeNodeResult[],
  failure: RuntimeFailure
): PipelineRuntimeResult {
  return {
    agentInvocations: context.agentInvocations,
    failureDetails: [failure],
    gates: context.gates,
    hookFailures: context.hookFailures,
    nodeStates: runtimeNodeStates(context),
    nodes,
    outcome: "FAIL",
    plan: context.plan,
    structuredOutputs: runtimeStructuredOutputs(context),
  };
}

function cancelledRuntimeResult(
  context: RuntimeContext,
  nodes: RuntimeNodeResult[]
): PipelineRuntimeResult {
  return {
    agentInvocations: context.agentInvocations,
    failureDetails: [cancelledFailure()],
    gates: context.gates,
    hookFailures: context.hookFailures,
    nodeStates: runtimeNodeStates(context),
    nodes,
    outcome: "CANCELLED",
    plan: context.plan,
    structuredOutputs: runtimeStructuredOutputs(context),
  };
}

function workflowRuntimeFailure(): RuntimeFailure {
  return {
    evidence: ["workflow failed without a specific failure"],
    gate: "workflow",
    reason: "workflow failed",
  };
}

export function nodeRuntimeFailure(node: RuntimeNodeResult): RuntimeFailure {
  return {
    evidence: node.evidence,
    gate: node.nodeId,
    nodeId: node.nodeId,
    reason: `node '${node.nodeId}' failed`,
  };
}

export function cancelledFailure(): RuntimeFailure {
  return {
    evidence: ["pipeline cancelled by AbortSignal"],
    gate: "cancelled",
    reason: "pipeline cancelled",
  };
}

function runtimeNodeStates(
  context: RuntimeContext
): Record<string, NodeExecutionState> {
  return context.nodeStateStore.toNodeStateRecord();
}

function runtimeStructuredOutputs(
  context: RuntimeContext
): RuntimeStructuredOutput[] {
  return context.nodeStateStore.structuredOutputList();
}
