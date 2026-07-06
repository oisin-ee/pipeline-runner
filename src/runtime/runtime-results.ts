import * as R from "effect/Record";

import type {
  NodeExecutionState,
  PipelineRuntimeResult,
  RuntimeContext,
  RuntimeFailure,
  RuntimeNodeResult,
  RuntimeStructuredOutput,
} from "./contracts";

const workflowRuntimeFailure = (): RuntimeFailure => ({
  evidence: ["workflow failed without a specific failure"],
  gate: "workflow",
  reason: "workflow failed",
});

export const nodeRuntimeFailure = (node: RuntimeNodeResult): RuntimeFailure => ({
  evidence: node.evidence,
  gate: node.nodeId,
  nodeId: node.nodeId,
  reason: `node '${node.nodeId}' failed`,
});

export const cancelledFailure = (): RuntimeFailure => ({
  evidence: ["pipeline cancelled by AbortSignal"],
  gate: "cancelled",
  reason: "pipeline cancelled",
});

const runtimeNodeStates = (context: RuntimeContext): Record<string, NodeExecutionState> =>
  R.fromEntries(context.nodeStateStore.nodeStates);

const runtimeStructuredOutputs = (context: RuntimeContext): RuntimeStructuredOutput[] => [
  ...context.nodeStateStore.structuredOutputs,
];

const passedRuntimeResult = (context: RuntimeContext, nodes: RuntimeNodeResult[]): PipelineRuntimeResult => ({
  agentInvocations: context.agentInvocations,
  failureDetails: [],
  gates: context.gates,
  hookFailures: context.hookFailures,
  nodeStates: runtimeNodeStates(context),
  nodes,
  outcome: "PASS",
  plan: context.plan,
  structuredOutputs: runtimeStructuredOutputs(context),
});

const failedRuntimeResult = (
  context: RuntimeContext,
  nodes: RuntimeNodeResult[],
  failure: RuntimeFailure,
): PipelineRuntimeResult => ({
  agentInvocations: context.agentInvocations,
  failureDetails: [failure],
  gates: context.gates,
  hookFailures: context.hookFailures,
  nodeStates: runtimeNodeStates(context),
  nodes,
  outcome: "FAIL",
  plan: context.plan,
  structuredOutputs: runtimeStructuredOutputs(context),
});

const cancelledRuntimeResult = (context: RuntimeContext, nodes: RuntimeNodeResult[]): PipelineRuntimeResult => ({
  agentInvocations: context.agentInvocations,
  failureDetails: [cancelledFailure()],
  gates: context.gates,
  hookFailures: context.hookFailures,
  nodeStates: runtimeNodeStates(context),
  nodes,
  outcome: "CANCELLED",
  plan: context.plan,
  structuredOutputs: runtimeStructuredOutputs(context),
});

export const workflowRuntimeResult = (
  context: RuntimeContext,
  outcome: PipelineRuntimeResult["outcome"],
  nodes: RuntimeNodeResult[],
  failure?: RuntimeFailure,
): PipelineRuntimeResult => {
  if (outcome === "CANCELLED") {
    return cancelledRuntimeResult(context, nodes);
  }
  if (outcome === "FAIL") {
    return failedRuntimeResult(context, nodes, failure ?? workflowRuntimeFailure());
  }
  return passedRuntimeResult(context, nodes);
};
