import { Effect, Option } from "effect";

import { findPlannedNode } from "../planned-node";
import type { PlannedWorkflowNode } from "../planning/compile";
import type { RetryReason } from "./actor-ids";
import { executeAgentNode } from "./agent-node";
import { executeBuiltin } from "./builtins";
import { diffChangedFiles, snapshotChangedFiles } from "./changed-files";
import { executeCommand } from "./command-executor";
import type {
  NodeAttemptCycleResult,
  NodeAttemptResult,
  NodeAttemptRetry,
  RuntimeContext,
  RuntimeFailure,
  RuntimeGateResult,
  RuntimeNodeResult,
} from "./contracts";
import { emitNodeFinish, emitNodeOutputRecorded, emitNodeStart, runtimeNodeActorDescriptor } from "./events";
import { EXIT_INFRA } from "./exit-codes";
import { evaluateNodeGates } from "./gates";
import { dispatchHooks } from "./hooks";
import { NodeStateTracker } from "./node-state-tracker";
import type { NodeExecutionEvent } from "./node-state-tracker";
import { executeParallelNode } from "./parallel-node";
import { remediateFailedNode } from "./remediation/remediation";
import type { NodeRemediationResult, RuntimeRemediationDependencies } from "./remediation/remediation";
import { decideNodeRetry, nodeRetryPolicy } from "./retry";
import type { NodeRetryDecision } from "./retry";
import { cancelledFailure, nodeRuntimeFailure } from "./runtime-results";

const recordNodeEvent = (context: RuntimeContext, nodeId: string, event: NodeExecutionEvent): void => {
  const tracker = new NodeStateTracker(nodeId, Option.getOrUndefined(context.nodeStateStore.getNodeState(nodeId)));
  const state = tracker.record(event);
  context.nodeStateStore.nodeStates.set(nodeId, state);
};

export const isCancelled = (context: RuntimeContext): boolean => context.signal?.aborted === true;

const dispatchHooksEffect = (
  ...args: Parameters<typeof dispatchHooks>
): Effect.Effect<Awaited<ReturnType<typeof dispatchHooks>>, unknown> =>
  Effect.tryPromise(async () => await dispatchHooks(...args));

const plannedNodeById = (context: RuntimeContext, nodeId: string): Option.Option<PlannedWorkflowNode> =>
  Option.orElse(context.plan.graph.hasNode(nodeId) ? Option.some(context.plan.graph.node(nodeId)) : Option.none(), () =>
    Option.fromUndefinedOr(findPlannedNode(context.plan.topologicalOrder, nodeId)),
  );

interface NodeAttemptLoopState {
  last: NodeAttemptResult;
  retry?: NodeAttemptRetry;
}

type NodeAttemptLoopStep = "failed" | "retry" | RuntimeNodeResult;

const initialAttemptLoopState = (): NodeAttemptLoopState => ({
  last: { evidence: [], exitCode: 1, output: "" },
});

const remediationPassedResult = (remediation: Option.Option<NodeRemediationResult>): Option.Option<RuntimeNodeResult> =>
  Option.flatMap(remediation, (value) => Option.fromNullishOr(value.result));

const remediationRequestsRetry = (remediation: Option.Option<NodeRemediationResult>): boolean =>
  Option.match(remediation, {
    onNone: () => false,
    onSome: (value) => value.retryNode === true,
  });

const cancelledRetry = (nodeId: string, attempt: number, last: NodeAttemptResult): NodeAttemptRetry => ({
  attempt,
  evidence: [...last.evidence, ...cancelledFailure().evidence],
  gate: nodeId,
  reason: "pipeline cancelled",
  retryReason: "timeout",
});

const wrappedErrorValue = (error: unknown): unknown => {
  if (typeof error !== "object" || error === null || !("error" in error)) {
    return;
  }
  return error.error;
};

const unwrapAttemptError = (error: unknown): unknown => {
  const inner = wrappedErrorValue(error);
  return inner !== undefined && inner !== error ? inner : error;
};

const attemptErrorMessage = (error: unknown): string => {
  const inner = unwrapAttemptError(error);
  if (inner !== error) {
    return attemptErrorMessage(inner);
  }
  return error instanceof Error && error.message ? error.message : String(error);
};

const nodeRetryFailure = (node: PlannedWorkflowNode, retry: NodeAttemptRetry): RuntimeFailure => ({
  evidence: retry.evidence,
  gate: retry.gate,
  nodeId: node.id,
  reason: retry.reason,
});

const waitForAbort = (signal?: AbortSignal): Effect.Effect<void> => {
  if (signal === undefined) {
    return Effect.never;
  }
  return Effect.callback<void>((resume) => {
    const onAbort = (): void => {
      resume(Effect.void);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
};

const waitForRetryDelay = (delayMs: number, signal?: AbortSignal): Effect.Effect<void> => {
  if (delayMs <= 0 || signal?.aborted === true) {
    return Effect.void;
  }
  return Effect.race(Effect.sleep(delayMs), waitForAbort(signal));
};

const passedNodeResult = (nodeId: string, attempt: number, last: NodeAttemptResult): RuntimeNodeResult => ({
  attempts: attempt,
  evidence: last.evidence,
  exitCode: 0,
  nodeId,
  output: last.output,
  status: "passed",
});

const retryGateId = (nodeId: string, failedGate?: RuntimeGateResult): string =>
  failedGate === undefined ? nodeId : failedGate.gateId;

const retryReasonText = (exitCode: number, failedGate?: RuntimeGateResult): string => {
  if (failedGate === undefined) {
    return `node exited with code ${exitCode}`;
  }
  return failedGate.reason ?? `node exited with code ${exitCode}`;
};

const retryEvidence = (last: NodeAttemptResult, failedGate?: RuntimeGateResult): string[] =>
  failedGate === undefined
    ? last.evidence.concat(`node exited with code ${last.exitCode}`)
    : [...last.evidence, ...failedGate.evidence];

const snapshotChangedFilesEffect = (worktreePath: string): Effect.Effect<ReturnType<typeof snapshotChangedFiles>> =>
  Effect.sync(() => snapshotChangedFiles(worktreePath));

const nodeRetryReason = (attempt: NodeAttemptResult, failedGate?: RuntimeGateResult): RetryReason => {
  if (attempt.timedOut === true) {
    return "timeout";
  }
  if (failedGate !== undefined) {
    return "gate_failure";
  }
  return "exit_nonzero";
};

const failedAttemptRetry = (
  nodeId: string,
  attempt: number,
  last: NodeAttemptResult,
  err: unknown,
): NodeAttemptRetry => {
  const message = attemptErrorMessage(err);
  return {
    attempt,
    evidence: [...last.evidence, message],
    gate: nodeId,
    reason: message,
    retryReason: nodeRetryReason(last),
  };
};

const retryFromAttemptError = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult,
  err: unknown,
): NodeAttemptRetry =>
  isCancelled(context) ? cancelledRetry(node.id, attempt, last) : failedAttemptRetry(node.id, attempt, last, err);

const exhaustedRetry = (node: PlannedWorkflowNode, maxAttempts: number, last: NodeAttemptResult): NodeAttemptRetry => ({
  attempt: Math.max(1, maxAttempts),
  evidence: last.evidence,
  gate: node.id,
  reason: `node exited with code ${last.exitCode}`,
  retryReason: nodeRetryReason(last),
});

const retryCycle = (
  node: PlannedWorkflowNode,
  attempt: number,
  last: NodeAttemptResult,
  failedGate?: RuntimeGateResult,
): NodeAttemptCycleResult => ({
  last,
  retry: {
    attempt,
    evidence: retryEvidence(last, failedGate),
    gate: retryGateId(node.id, failedGate),
    reason: retryReasonText(last.exitCode, failedGate),
    retryReason: nodeRetryReason(last, failedGate),
  },
});

const retryCandidateForCycle = (
  node: PlannedWorkflowNode,
  cycle: NodeAttemptCycleResult,
  last: NodeAttemptResult,
  attempt: number,
): NodeAttemptRetry =>
  cycle.retry ?? {
    attempt,
    evidence: last.evidence,
    gate: node.id,
    reason: `node exited with code ${last.exitCode}`,
    retryReason: nodeRetryReason(last),
  };

const nodeFailure = (
  nodeId: string,
  attempts: number,
  evidence: string[],
  output: string,
  exitCode = 1,
): RuntimeNodeResult => ({
  attempts,
  evidence,
  exitCode,
  nodeId,
  output,
  status: "failed",
});

const cancelledCycle = (nodeId: string, attempt: number, previous: NodeAttemptResult): NodeAttemptCycleResult => ({
  last: previous,
  result: nodeFailure(nodeId, attempt, cancelledFailure().evidence, previous.output),
});

type NodeAttemptExecutor = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
) => Effect.Effect<NodeAttemptResult, unknown>;

const executeAgentAttempt = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
): Effect.Effect<NodeAttemptResult, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await executeAgentNode(node, context, attempt),
  });

const executeCommandAttempt = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
): Effect.Effect<NodeAttemptResult, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () =>
      await executeCommand(node.command ?? [], context, {
        timeout: node.timeoutMs,
      }),
  });

const executeBuiltinAttempt = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
): Effect.Effect<NodeAttemptResult, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await executeBuiltin(node.builtin ?? "", context, node),
  });

const executeGroupAttempt = (node: PlannedWorkflowNode): Effect.Effect<NodeAttemptResult> =>
  Effect.succeed({
    evidence: [`group '${node.id}' completed`],
    exitCode: 0,
    output: "",
  });

const dispatchGateFailureHook = (
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  result: RuntimeGateResult,
): Effect.Effect<void, unknown> =>
  Effect.asVoid(
    dispatchHooksEffect(
      context,
      "gate.failure",
      {
        evidence: result.evidence,
        gate: result.gateId,
        nodeId: node.id,
        reason: result.reason ?? "gate failed",
      },
      node,
      result.gateId,
    ),
  );

const now = (): string => new Date().toISOString();

export const markNodeReady = (context: RuntimeContext, nodeId: string): void => {
  recordNodeEvent(context, nodeId, { at: now(), type: "READY" });
};

export const recordSkippedNodeState = (context: RuntimeContext, nodeId: string, reason: string): void => {
  recordNodeEvent(context, nodeId, { at: now(), reason, type: "SKIPPED" });
};

const emitRemediationPass = (context: RuntimeContext, nodeId: string, result: RuntimeNodeResult): void => {
  recordNodeEvent(context, nodeId, { at: now(), result, type: "PASSED" });
  emitNodeFinish(context, result);
};

const recordRetryingNodeEvent = (
  context: RuntimeContext,
  nodeId: string,
  attempt: number,
  retry: NodeAttemptRetry,
  retryDecision: NodeRetryDecision,
): void => {
  recordNodeEvent(context, nodeId, {
    at: now(),
    attempt,
    evidence: retry.evidence,
    gate: retry.gate,
    reason: retry.reason,
    retry: retryDecision,
    retryReason: retry.retryReason,
    type: "RETRYING",
  });
};

const recordRemediationRetryingNodeEvent = (
  context: RuntimeContext,
  nodeId: string,
  attempt: number,
  retry: NodeAttemptRetry,
): void => {
  const retryDecision: NodeRetryDecision = {
    attempt,
    delayMs: 0,
    evidence: retry.evidence,
    exhausted: false,
    gate: retry.gate,
    reason: retry.reason,
    retryReason: retry.retryReason,
    scheduled: true,
  };
  recordRetryingNodeEvent(context, nodeId, attempt, retry, retryDecision);
};

const finishFailedNode = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  last: NodeAttemptResult,
  retry: NodeAttemptRetry,
): Effect.Effect<RuntimeNodeResult, unknown> =>
  Effect.gen(function* effectBody() {
    yield* dispatchHooksEffect(context, "node.error", nodeRetryFailure(node, retry), node);
    const result = nodeFailure(
      node.id,
      retry.attempt,
      retry.evidence,
      last.output,
      last.exitCode === EXIT_INFRA ? EXIT_INFRA : 1,
    );
    recordNodeEvent(context, node.id, {
      at: now(),
      failure: nodeRuntimeFailure(result),
      result,
      type: "FAILED",
    });
    emitNodeFinish(context, result);
    return result;
  });

const emitRuntimeRetry = (
  context: RuntimeContext,
  nodeId: string,
  retry: NodeRetryDecision,
  reason: RetryReason,
): void => {
  context.observability?.({
    actor: runtimeNodeActorDescriptor(context, nodeId),
    attempt: retry.scheduled ? retry.attempt + 1 : retry.attempt,
    nodeId,
    reason,
    timestamp: now(),
    type: retry.scheduled ? "runtime.retry.scheduled" : "runtime.retry.exhausted",
  });
};

const scheduleNodeRetry = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  retryPolicy: ReturnType<typeof nodeRetryPolicy>,
  retry: NodeAttemptRetry,
  attempt: number,
): Effect.Effect<NodeAttemptLoopStep> =>
  Effect.gen(function* effectBody() {
    const retryDecision = decideNodeRetry({
      attempt,
      evidence: retry.evidence,
      gate: retry.gate,
      policy: retryPolicy,
      reason: retry.reason,
      retryReason: retry.retryReason,
    });
    recordRetryingNodeEvent(context, node.id, attempt, retry, retryDecision);
    emitRuntimeRetry(context, node.id, retryDecision, retry.retryReason);
    if (!retryDecision.scheduled) {
      return "failed";
    }
    yield* waitForRetryDelay(retryDecision.delayMs, context.signal);
    return "retry";
  });

const failedHookCycle = (
  nodeId: string,
  attempt: number,
  previous: NodeAttemptResult,
  evidence: string[],
  context: RuntimeContext,
): NodeAttemptCycleResult => {
  const result = nodeFailure(nodeId, attempt, evidence, previous.output);
  recordNodeEvent(context, nodeId, {
    at: now(),
    failure: nodeRuntimeFailure(result),
    result,
    type: "FAILED",
  });
  return { last: previous, result };
};

const beginNodeAttempt = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  previous: NodeAttemptResult,
): Effect.Effect<Option.Option<NodeAttemptCycleResult>, unknown> =>
  Effect.gen(function* effectBody() {
    if (isCancelled(context)) {
      return Option.some(cancelledCycle(node.id, attempt, previous));
    }
    emitNodeStart(context, node, attempt);
    recordNodeEvent(context, node.id, { at: now(), attempt, type: "STARTED" });
    const startHook = yield* dispatchHooksEffect(context, "node.start", undefined, node);
    const startHookFailure = Option.fromNullishOr(startHook);
    if (Option.isSome(startHookFailure)) {
      return Option.some(failedHookCycle(node.id, attempt, previous, startHookFailure.value.evidence, context));
    }
    return isCancelled(context) ? Option.some(cancelledCycle(node.id, attempt, previous)) : Option.none();
  });

const runnerFinishedEvent = (last: NodeAttemptResult): NodeExecutionEvent => ({
  at: now(),
  evidence: last.evidence,
  exitCode: last.exitCode,
  output: last.output,
  timedOut: last.timedOut,
  type: "RUNNER_FINISHED",
});

const recordAttemptOutput = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult,
): Effect.Effect<void> =>
  Effect.gen(function* effectBody() {
    const afterSnapshot = yield* snapshotChangedFilesEffect(context.worktreePath);
    const beforeSnapshot = Option.fromUndefinedOr(context.nodeStateStore.nodeSnapshots.get(node.id));
    if (Option.isSome(beforeSnapshot)) {
      context.nodeStateStore.nodeSnapshots.set(
        node.id,
        diffChangedFiles(beforeSnapshot.value, afterSnapshot, context.worktreePath),
      );
    }
    context.nodeStateStore.lastOutputByNode.set(node.id, last.output);
    context.nodeStateStore.recordHandoff(node.id, last.handoff);
    emitNodeOutputRecorded(context, node, attempt, last.output);
    recordNodeEvent(context, node.id, { at: now(), type: "OUTPUT_RECORDED" });
    recordNodeEvent(context, node.id, {
      at: now(),
      type: "SNAPSHOT_AFTER_FINISHED",
    });
  });

const evaluateGatesForAttempt = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  last: NodeAttemptResult,
): Effect.Effect<RuntimeGateResult[], unknown> =>
  Effect.gen(function* effectBody() {
    recordNodeEvent(context, node.id, { at: now(), type: "GATES_STARTED" });
    const gateResults = yield* Effect.tryPromise(
      async () =>
        await evaluateNodeGates(node, context, last, async (failedNode, result) => {
          await Effect.runPromise(dispatchGateFailureHook(context, failedNode, result));
        }),
    );
    recordNodeEvent(context, node.id, {
      at: now(),
      gates: gateResults,
      type: "GATES_FINISHED",
    });
    return gateResults;
  });

const passedCycle = (
  nodeId: string,
  attempt: number,
  last: NodeAttemptResult,
  context: RuntimeContext,
): NodeAttemptCycleResult => {
  const result = passedNodeResult(nodeId, attempt, last);
  recordNodeEvent(context, nodeId, { at: now(), result, type: "PASSED" });
  return { last, result };
};

const cancelledNodeResult = (
  context: RuntimeContext,
  nodeId: string,
  attempt: number,
  last: NodeAttemptResult,
): Option.Option<RuntimeNodeResult> => {
  if (!isCancelled(context)) {
    return Option.none();
  }
  const result: RuntimeNodeResult = {
    attempts: attempt,
    evidence: [...last.evidence, ...cancelledFailure().evidence],
    exitCode: last.exitCode,
    nodeId,
    output: last.output,
    status: last.exitCode === 0 ? "passed" : "failed",
  };
  recordNodeEvent(context, nodeId, {
    at: now(),
    failure: cancelledFailure(),
    type: "CANCELLED",
  });
  return Option.some(result);
};

const successfulAttemptCycle = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult,
): Effect.Effect<NodeAttemptCycleResult, unknown> =>
  Effect.gen(function* effectBody() {
    const successHook = yield* dispatchHooksEffect(context, "node.success", undefined, node);
    const successHookFailure = Option.fromNullishOr(successHook);
    if (Option.isSome(successHookFailure)) {
      return failedHookCycle(node.id, attempt, last, successHookFailure.value.evidence, context);
    }
    const cancelledAfterHook = cancelledNodeResult(context, node.id, attempt, last);
    return Option.isSome(cancelledAfterHook)
      ? { last, result: cancelledAfterHook.value }
      : passedCycle(node.id, attempt, last, context);
  });

const finishNodeAttemptWithGate = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult,
  failedGate?: RuntimeGateResult,
): Effect.Effect<NodeAttemptCycleResult, unknown> => {
  if (failedGate !== undefined || last.exitCode !== 0) {
    return Effect.succeed(retryCycle(node, attempt, last, failedGate));
  }
  return successfulAttemptCycle(node, context, attempt, last);
};

const finishNodeAttemptAfterGates = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult,
): Effect.Effect<NodeAttemptCycleResult, unknown> =>
  Effect.gen(function* effectBody() {
    if (last.exitCode === EXIT_INFRA) {
      return yield* finishNodeAttemptWithGate(node, context, attempt, last);
    }
    const gateResults = yield* evaluateGatesForAttempt(node, context, last);
    const cancelledAfterGates = cancelledNodeResult(context, node.id, attempt, last);
    if (Option.isSome(cancelledAfterGates)) {
      return { last, result: cancelledAfterGates.value };
    }
    const failedGate = gateResults.find((gate) => !gate.passed);
    return yield* finishNodeAttemptWithGate(node, context, attempt, last, failedGate);
  });

let runNodeAttemptBody: (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
) => Effect.Effect<NodeAttemptResult, unknown>;

let runNodeAttempts: (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  retryPolicy: ReturnType<typeof nodeRetryPolicy>,
  state: NodeAttemptLoopState,
) => Effect.Effect<Option.Option<RuntimeNodeResult>, unknown>;

const executeNodeAttemptCycle = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  previous: NodeAttemptResult,
): Effect.Effect<NodeAttemptCycleResult, unknown> =>
  Effect.gen(function* effectBody() {
    const startResult = yield* beginNodeAttempt(node, context, attempt, previous);
    if (Option.isSome(startResult)) {
      return startResult.value;
    }
    const last = yield* runNodeAttemptBody(node, context, attempt);
    const cancelledAfterAttempt = cancelledNodeResult(context, node.id, attempt, last);
    if (Option.isSome(cancelledAfterAttempt)) {
      return { last, result: cancelledAfterAttempt.value };
    }
    return yield* finishNodeAttemptAfterGates(node, context, attempt, last);
  });

const nodeAttemptCycleOrError = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult,
): Effect.Effect<NodeAttemptCycleResult | { error: unknown }> =>
  Effect.catch(executeNodeAttemptCycle(node, context, attempt, last), (error) => Effect.succeed({ error }));

const executeNode = (node: PlannedWorkflowNode, context: RuntimeContext): Effect.Effect<RuntimeNodeResult, unknown> =>
  Effect.gen(function* effectBody() {
    const retryPolicy = nodeRetryPolicy(node);
    const state = initialAttemptLoopState();
    const result = yield* runNodeAttempts(node, context, retryPolicy, state);
    if (Option.isSome(result)) {
      return result.value;
    }
    const finalRetry = state.retry ?? exhaustedRetry(node, retryPolicy.maxAttempts, state.last);
    return yield* finishFailedNode(node, context, state.last, finalRetry);
  });

const executeParallelAttempt = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
): Effect.Effect<NodeAttemptResult, unknown> =>
  Effect.tryPromise(
    async () =>
      await executeParallelNode(node, context, {
        executeNode: async (child, childContext) => await Effect.runPromise(executeNode(child, childContext)),
        markNodeReady: (childContext, childId) => {
          markNodeReady(childContext, childId);
        },
      }),
  );

const nodeAttemptExecutors: Record<PlannedWorkflowNode["kind"], NodeAttemptExecutor> = {
  agent: executeAgentAttempt,
  builtin: executeBuiltinAttempt,
  command: executeCommandAttempt,
  group: executeGroupAttempt,
  parallel: (node, context) => executeParallelAttempt(node, context),
};

const executeNodeAttempt = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
): Effect.Effect<NodeAttemptResult, unknown> => nodeAttemptExecutors[node.kind](node, context, attempt);

runNodeAttemptBody = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
): Effect.Effect<NodeAttemptResult, unknown> =>
  Effect.gen(function* effectBody() {
    recordNodeEvent(context, node.id, {
      at: now(),
      type: "START_HOOKS_FINISHED",
    });
    context.nodeStateStore.nodeSnapshots.set(node.id, yield* snapshotChangedFilesEffect(context.worktreePath));
    recordNodeEvent(context, node.id, {
      at: now(),
      type: "SNAPSHOT_BEFORE_FINISHED",
    });
    recordNodeEvent(context, node.id, { at: now(), type: "RUNNER_STARTED" });
    const last = yield* executeNodeAttempt(node, context, attempt);
    recordNodeEvent(context, node.id, runnerFinishedEvent(last));
    yield* recordAttemptOutput(node, context, attempt, last);
    return last;
  });

export const executePlannedNode = (
  nodeId: string,
  context: RuntimeContext,
): Effect.Effect<RuntimeNodeResult, unknown> =>
  Effect.gen(function* effectBody() {
    const node = plannedNodeById(context, nodeId);
    if (Option.isNone(node)) {
      return yield* Effect.fail(new Error(`workflow scheduler referenced unknown node '${nodeId}'`));
    }
    const result = yield* executeNode(node.value, context);
    yield* dispatchHooksEffect(
      context,
      "node.finish",
      result.status === "failed" ? nodeRuntimeFailure(result) : undefined,
      node.value,
    );
    return result;
  });

const executeReadyNode = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
): Effect.Effect<RuntimeNodeResult, unknown> => {
  markNodeReady(context, node.id);
  return executeNode(node, context);
};

const runtimeRemediationDependencies: RuntimeRemediationDependencies = {
  executeNode: executeReadyNode,
  isCancelled,
  snapshotChangedFiles: snapshotChangedFilesEffect,
};

const continueAfterRetryCandidate = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  retryPolicy: ReturnType<typeof nodeRetryPolicy>,
  retry: NodeAttemptRetry,
  attempt: number,
): Effect.Effect<NodeAttemptLoopStep, unknown> =>
  Effect.gen(function* effectBody() {
    const remediation = yield* remediateFailedNode({
      attempt,
      context,
      dependencies: runtimeRemediationDependencies,
      node,
      retry,
    });
    const passed = remediationPassedResult(remediation);
    if (Option.isSome(passed)) {
      emitRemediationPass(context, node.id, passed.value);
      return passed.value;
    }
    if (remediationRequestsRetry(remediation)) {
      recordRemediationRetryingNodeEvent(context, node.id, attempt, retry);
      return "retry";
    }
    return yield* scheduleNodeRetry(node, context, retryPolicy, retry, attempt);
  });

const continueAfterAttemptCycle = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  retryPolicy: ReturnType<typeof nodeRetryPolicy>,
  state: NodeAttemptLoopState,
  attempt: number,
  cycle: NodeAttemptCycleResult,
): Effect.Effect<NodeAttemptLoopStep, unknown> => {
  if (cycle.result !== undefined) {
    emitNodeFinish(context, cycle.result);
    return Effect.succeed(cycle.result);
  }
  state.retry = retryCandidateForCycle(node, cycle, state.last, attempt);
  return continueAfterRetryCandidate(node, context, retryPolicy, state.retry, attempt);
};

const runSingleNodeAttempt = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  retryPolicy: ReturnType<typeof nodeRetryPolicy>,
  state: NodeAttemptLoopState,
  attempt: number,
): Effect.Effect<NodeAttemptLoopStep, unknown> =>
  Effect.gen(function* effectBody() {
    const outcome = yield* nodeAttemptCycleOrError(node, context, attempt, state.last);
    if ("error" in outcome) {
      state.retry = retryFromAttemptError(node, context, attempt, state.last, outcome.error);
      return "failed";
    }
    state.last = outcome.last;
    return yield* continueAfterAttemptCycle(node, context, retryPolicy, state, attempt, outcome);
  });

runNodeAttempts = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  retryPolicy: ReturnType<typeof nodeRetryPolicy>,
  state: NodeAttemptLoopState,
): Effect.Effect<Option.Option<RuntimeNodeResult>, unknown> =>
  Effect.gen(function* effectBody() {
    for (let attempt = 1; ; attempt += 1) {
      const step = yield* runSingleNodeAttempt(node, context, retryPolicy, state, attempt);
      if (step === "retry") {
        continue;
      }
      return step === "failed" ? Option.none() : Option.some(step);
    }
  });
