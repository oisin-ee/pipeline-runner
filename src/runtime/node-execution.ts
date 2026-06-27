import { Effect } from "effect";
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
import {
  emitNodeFinish,
  emitNodeOutputRecorded,
  emitNodeStart,
  runtimeNodeActorDescriptor,
} from "./events";
import { EXIT_INFRA } from "./exit-codes";
import { evaluateNodeGates } from "./gates";
import { dispatchHooks } from "./hooks";
import {
  type NodeExecutionEvent,
  NodeStateTracker,
} from "./node-state-tracker";
import { executeParallelNode } from "./parallel-node";
import {
  type NodeRemediationResult,
  type RuntimeRemediationDependencies,
  remediateFailedNode,
} from "./remediation/remediation";
import {
  decideNodeRetry,
  type NodeRetryDecision,
  nodeRetryPolicy,
} from "./retry";
import { cancelledFailure, nodeRuntimeFailure } from "./runtime-results";

export function executePlannedNode(
  nodeId: string,
  context: RuntimeContext
): Effect.Effect<RuntimeNodeResult, unknown> {
  return Effect.gen(function* () {
    const node = plannedNodeById(context, nodeId);
    if (!node) {
      return yield* Effect.fail(
        new Error(`workflow scheduler referenced unknown node '${nodeId}'`)
      );
    }
    const result = yield* executeNode(node, context);
    yield* dispatchHooksEffect(
      context,
      "node.finish",
      result.status === "failed" ? nodeRuntimeFailure(result) : undefined,
      node
    );
    return result;
  });
}

export function markNodeReady(context: RuntimeContext, nodeId: string): void {
  recordNodeEvent(context, nodeId, { at: now(), type: "READY" });
}

export function recordSkippedNodeState(
  context: RuntimeContext,
  nodeId: string,
  reason: string
): void {
  recordNodeEvent(context, nodeId, { at: now(), reason, type: "SKIPPED" });
}

function recordNodeEvent(
  context: RuntimeContext,
  nodeId: string,
  event: NodeExecutionEvent
): void {
  const tracker = new NodeStateTracker(
    nodeId,
    context.nodeStateStore.getNodeState(nodeId)
  );
  const state = tracker.record(event);
  context.nodeStateStore.setNodeState(nodeId, state);
}

export function isCancelled(context: RuntimeContext): boolean {
  return context.signal?.aborted === true;
}

function dispatchHooksEffect(
  ...args: Parameters<typeof dispatchHooks>
): Effect.Effect<Awaited<ReturnType<typeof dispatchHooks>>, unknown> {
  return Effect.tryPromise(() => dispatchHooks(...args));
}

const runtimeRemediationDependencies: RuntimeRemediationDependencies = {
  executeNode: executeReadyNode,
  isCancelled,
  snapshotChangedFiles: snapshotChangedFilesEffect,
};

function executeReadyNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Effect.Effect<RuntimeNodeResult, unknown> {
  markNodeReady(context, node.id);
  return executeNode(node, context);
}

function plannedNodeById(
  context: RuntimeContext,
  nodeId: string
): PlannedWorkflowNode | undefined {
  return (
    context.plan.graph.node(nodeId) ??
    findPlannedNode(context.plan.topologicalOrder, nodeId)
  );
}

function executeNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Effect.Effect<RuntimeNodeResult, unknown> {
  return Effect.gen(function* () {
    const retryPolicy = nodeRetryPolicy(node);
    const state = initialAttemptLoopState();
    const result = yield* runNodeAttempts(node, context, retryPolicy, state);
    if (result) {
      return result;
    }
    const finalRetry =
      state.retry ?? exhaustedRetry(node, retryPolicy.maxAttempts, state.last);
    return yield* finishFailedNode(node, context, state.last, finalRetry);
  });
}

interface NodeAttemptLoopState {
  last: NodeAttemptResult;
  retry?: NodeAttemptRetry;
}

type NodeAttemptLoopStep = "failed" | "retry" | RuntimeNodeResult;

function initialAttemptLoopState(): NodeAttemptLoopState {
  return { last: { evidence: [], exitCode: 1, output: "" } };
}

function runNodeAttempts(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  retryPolicy: ReturnType<typeof nodeRetryPolicy>,
  state: NodeAttemptLoopState
): Effect.Effect<RuntimeNodeResult | null, unknown> {
  return Effect.gen(function* () {
    for (let attempt = 1; ; attempt += 1) {
      const step = yield* runSingleNodeAttempt(
        node,
        context,
        retryPolicy,
        state,
        attempt
      );
      if (step === "retry") {
        continue;
      }
      return step === "failed" ? null : step;
    }
  });
}

function runSingleNodeAttempt(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  retryPolicy: ReturnType<typeof nodeRetryPolicy>,
  state: NodeAttemptLoopState,
  attempt: number
): Effect.Effect<NodeAttemptLoopStep, unknown> {
  return Effect.gen(function* () {
    const outcome = yield* nodeAttemptCycleOrError(
      node,
      context,
      attempt,
      state.last
    );
    if ("error" in outcome) {
      state.retry = retryFromAttemptError(
        node,
        context,
        attempt,
        state.last,
        outcome.error
      );
      return "failed";
    }
    state.last = outcome.last;
    return yield* continueAfterAttemptCycle(
      node,
      context,
      retryPolicy,
      state,
      attempt,
      outcome
    );
  });
}

function nodeAttemptCycleOrError(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult
): Effect.Effect<NodeAttemptCycleResult | { error: unknown }> {
  return Effect.catch(
    executeNodeAttemptCycle(node, context, attempt, last),
    (error) => Effect.succeed({ error })
  );
}

function continueAfterAttemptCycle(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  retryPolicy: ReturnType<typeof nodeRetryPolicy>,
  state: NodeAttemptLoopState,
  attempt: number,
  cycle: NodeAttemptCycleResult
): Effect.Effect<NodeAttemptLoopStep, unknown> {
  if (cycle.result) {
    emitNodeFinish(context, cycle.result);
    return Effect.succeed(cycle.result);
  }
  state.retry = retryCandidateForCycle(node, cycle, state.last, attempt);
  return continueAfterRetryCandidate(
    node,
    context,
    retryPolicy,
    state.retry,
    attempt
  );
}

function continueAfterRetryCandidate(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  retryPolicy: ReturnType<typeof nodeRetryPolicy>,
  retry: NodeAttemptRetry,
  attempt: number
): Effect.Effect<NodeAttemptLoopStep, unknown> {
  return Effect.gen(function* () {
    const remediation = yield* remediateFailedNode({
      attempt,
      context,
      dependencies: runtimeRemediationDependencies,
      node,
      retry,
    });
    const passed = remediationPassedResult(remediation);
    if (passed) {
      emitRemediationPass(context, node.id, passed);
      return passed;
    }
    if (remediationRequestsRetry(remediation)) {
      recordRemediationRetryingNodeEvent(context, node.id, attempt, retry);
      return "retry";
    }
    return yield* scheduleNodeRetry(node, context, retryPolicy, retry, attempt);
  });
}

function recordRemediationRetryingNodeEvent(
  context: RuntimeContext,
  nodeId: string,
  attempt: number,
  retry: NodeAttemptRetry
): void {
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
}

function remediationPassedResult(
  remediation: NodeRemediationResult | null
): RuntimeNodeResult | null {
  if (!remediation) {
    return null;
  }
  return remediation.result ?? null;
}

function remediationRequestsRetry(
  remediation: NodeRemediationResult | null
): boolean {
  if (!remediation) {
    return false;
  }
  return remediation.retryNode === true;
}

function emitRemediationPass(
  context: RuntimeContext,
  nodeId: string,
  result: RuntimeNodeResult
): void {
  recordNodeEvent(context, nodeId, { at: now(), result, type: "PASSED" });
  emitNodeFinish(context, result);
}

function scheduleNodeRetry(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  retryPolicy: ReturnType<typeof nodeRetryPolicy>,
  retry: NodeAttemptRetry,
  attempt: number
): Effect.Effect<NodeAttemptLoopStep> {
  return Effect.gen(function* () {
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
}

function recordRetryingNodeEvent(
  context: RuntimeContext,
  nodeId: string,
  attempt: number,
  retry: NodeAttemptRetry,
  retryDecision: NodeRetryDecision
): void {
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
}

function retryFromAttemptError(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult,
  err: unknown
): NodeAttemptRetry {
  return isCancelled(context)
    ? cancelledRetry(node.id, attempt, last)
    : failedAttemptRetry(node.id, attempt, last, err);
}

function cancelledRetry(
  nodeId: string,
  attempt: number,
  last: NodeAttemptResult
): NodeAttemptRetry {
  return {
    attempt,
    evidence: [...last.evidence, ...cancelledFailure().evidence],
    gate: nodeId,
    reason: "pipeline cancelled",
    retryReason: "timeout",
  };
}

function unwrapAttemptError(error: unknown): unknown {
  const inner = wrappedErrorValue(error);
  return inner !== undefined && inner !== error ? inner : error;
}

function wrappedErrorValue(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("error" in error)) {
    return;
  }
  return error.error;
}

function attemptErrorMessage(error: unknown): string {
  const inner = unwrapAttemptError(error);
  if (inner !== error) {
    return attemptErrorMessage(inner);
  }
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

function failedAttemptRetry(
  nodeId: string,
  attempt: number,
  last: NodeAttemptResult,
  err: unknown
): NodeAttemptRetry {
  const message = attemptErrorMessage(err);
  return {
    attempt,
    evidence: [...last.evidence, message],
    gate: nodeId,
    reason: message,
    retryReason: nodeRetryReason(last),
  };
}

function exhaustedRetry(
  node: PlannedWorkflowNode,
  maxAttempts: number,
  last: NodeAttemptResult
): NodeAttemptRetry {
  return {
    attempt: Math.max(1, maxAttempts),
    evidence: last.evidence,
    gate: node.id,
    reason: `node exited with code ${last.exitCode}`,
    retryReason: nodeRetryReason(last),
  };
}

function finishFailedNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  last: NodeAttemptResult,
  retry: NodeAttemptRetry
): Effect.Effect<RuntimeNodeResult, unknown> {
  return Effect.gen(function* () {
    yield* dispatchHooksEffect(
      context,
      "node.error",
      nodeRetryFailure(node, retry),
      node
    );
    const result = nodeFailure(
      node.id,
      retry.attempt,
      retry.evidence,
      last.output,
      last.exitCode === EXIT_INFRA ? EXIT_INFRA : 1
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
}

function nodeRetryFailure(
  node: PlannedWorkflowNode,
  retry: NodeAttemptRetry
): RuntimeFailure {
  return {
    evidence: retry.evidence,
    gate: retry.gate,
    nodeId: node.id,
    reason: retry.reason,
  };
}

function emitRuntimeRetry(
  context: RuntimeContext,
  nodeId: string,
  retry: NodeRetryDecision,
  reason: RetryReason
): void {
  context.observability?.({
    actor: runtimeNodeActorDescriptor(context, nodeId),
    attempt: retry.scheduled ? retry.attempt + 1 : retry.attempt,
    nodeId,
    reason,
    timestamp: now(),
    type: retry.scheduled
      ? "runtime.retry.scheduled"
      : "runtime.retry.exhausted",
  });
}

function waitForRetryDelay(
  delayMs: number,
  signal?: AbortSignal
): Effect.Effect<void> {
  if (delayMs <= 0 || signal?.aborted) {
    return Effect.void;
  }
  return Effect.race(Effect.sleep(delayMs), waitForAbort(signal));
}

function waitForAbort(signal?: AbortSignal): Effect.Effect<void> {
  if (!signal) {
    return Effect.never;
  }
  return Effect.callback<void>((resume) => {
    const onAbort = (): void => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

function executeNodeAttemptCycle(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  previous: NodeAttemptResult
): Effect.Effect<NodeAttemptCycleResult, unknown> {
  return Effect.gen(function* () {
    const startResult = yield* beginNodeAttempt(
      node,
      context,
      attempt,
      previous
    );
    if (startResult) {
      return startResult;
    }
    const last = yield* runNodeAttemptBody(node, context, attempt);
    const cancelledAfterAttempt = cancelledNodeResult(
      context,
      node.id,
      attempt,
      last
    );
    if (cancelledAfterAttempt) {
      return { last, result: cancelledAfterAttempt };
    }
    return yield* finishNodeAttemptAfterGates(node, context, attempt, last);
  });
}

function beginNodeAttempt(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  previous: NodeAttemptResult
): Effect.Effect<NodeAttemptCycleResult | null, unknown> {
  return Effect.gen(function* () {
    if (isCancelled(context)) {
      return cancelledCycle(node.id, attempt, previous);
    }
    emitNodeStart(context, node, attempt);
    recordNodeEvent(context, node.id, { at: now(), attempt, type: "STARTED" });
    const startHook = yield* dispatchHooksEffect(
      context,
      "node.start",
      undefined,
      node
    );
    if (startHook) {
      return failedHookCycle(
        node.id,
        attempt,
        previous,
        startHook.evidence,
        context
      );
    }
    return isCancelled(context)
      ? cancelledCycle(node.id, attempt, previous)
      : null;
  });
}

function cancelledCycle(
  nodeId: string,
  attempt: number,
  previous: NodeAttemptResult
): NodeAttemptCycleResult {
  return {
    last: previous,
    result: nodeFailure(
      nodeId,
      attempt,
      cancelledFailure().evidence,
      previous.output
    ),
  };
}

function failedHookCycle(
  nodeId: string,
  attempt: number,
  previous: NodeAttemptResult,
  evidence: string[],
  context: RuntimeContext
): NodeAttemptCycleResult {
  const result = nodeFailure(nodeId, attempt, evidence, previous.output);
  recordNodeEvent(context, nodeId, {
    at: now(),
    failure: nodeRuntimeFailure(result),
    result,
    type: "FAILED",
  });
  return { last: previous, result };
}

function runNodeAttemptBody(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number
): Effect.Effect<NodeAttemptResult, unknown> {
  return Effect.gen(function* () {
    recordNodeEvent(context, node.id, {
      at: now(),
      type: "START_HOOKS_FINISHED",
    });
    context.nodeStateStore.setSnapshot(
      node.id,
      yield* snapshotChangedFilesEffect(context.worktreePath)
    );
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
}

function runnerFinishedEvent(last: NodeAttemptResult): NodeExecutionEvent {
  return {
    at: now(),
    evidence: last.evidence,
    exitCode: last.exitCode,
    output: last.output,
    timedOut: last.timedOut,
    type: "RUNNER_FINISHED",
  };
}

function recordAttemptOutput(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const afterSnapshot = yield* snapshotChangedFilesEffect(
      context.worktreePath
    );
    const beforeSnapshot = context.nodeStateStore.getSnapshot(node.id);
    if (beforeSnapshot) {
      context.nodeStateStore.setSnapshot(
        node.id,
        diffChangedFiles(beforeSnapshot, afterSnapshot, context.worktreePath)
      );
    }
    context.nodeStateStore.recordOutput(node.id, last.output);
    context.nodeStateStore.recordHandoff(node.id, last.handoff);
    emitNodeOutputRecorded(context, node, attempt, last.output);
    recordNodeEvent(context, node.id, { at: now(), type: "OUTPUT_RECORDED" });
    recordNodeEvent(context, node.id, {
      at: now(),
      type: "SNAPSHOT_AFTER_FINISHED",
    });
  });
}

function finishNodeAttemptAfterGates(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult
): Effect.Effect<NodeAttemptCycleResult, unknown> {
  return Effect.gen(function* () {
    if (last.exitCode === EXIT_INFRA) {
      return yield* finishNodeAttemptWithGate(
        node,
        context,
        attempt,
        last,
        undefined
      );
    }
    const gateResults = yield* evaluateGatesForAttempt(node, context, last);
    const cancelledAfterGates = cancelledNodeResult(
      context,
      node.id,
      attempt,
      last
    );
    if (cancelledAfterGates) {
      return { last, result: cancelledAfterGates };
    }
    const failedGate = gateResults.find((gate) => !gate.passed);
    return yield* finishNodeAttemptWithGate(
      node,
      context,
      attempt,
      last,
      failedGate
    );
  });
}

function evaluateGatesForAttempt(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  last: NodeAttemptResult
): Effect.Effect<RuntimeGateResult[], unknown> {
  return Effect.gen(function* () {
    recordNodeEvent(context, node.id, { at: now(), type: "GATES_STARTED" });
    const gateResults = yield* Effect.tryPromise(() =>
      evaluateNodeGates(node, context, last, (failedNode, result) =>
        Effect.runPromise(dispatchGateFailureHook(context, failedNode, result))
      )
    );
    recordNodeEvent(context, node.id, {
      at: now(),
      gates: gateResults,
      type: "GATES_FINISHED",
    });
    return gateResults;
  });
}

function finishNodeAttemptWithGate(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult,
  failedGate: RuntimeGateResult | undefined
): Effect.Effect<NodeAttemptCycleResult, unknown> {
  if (failedGate || last.exitCode !== 0) {
    return Effect.succeed(retryCycle(node, attempt, last, failedGate));
  }
  return successfulAttemptCycle(node, context, attempt, last);
}

function successfulAttemptCycle(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
  last: NodeAttemptResult
): Effect.Effect<NodeAttemptCycleResult, unknown> {
  return Effect.gen(function* () {
    const successHook = yield* dispatchHooksEffect(
      context,
      "node.success",
      undefined,
      node
    );
    if (successHook) {
      return failedHookCycle(
        node.id,
        attempt,
        last,
        successHook.evidence,
        context
      );
    }
    const cancelledAfterHook = cancelledNodeResult(
      context,
      node.id,
      attempt,
      last
    );
    return cancelledAfterHook
      ? { last, result: cancelledAfterHook }
      : passedCycle(node.id, attempt, last, context);
  });
}

function passedCycle(
  nodeId: string,
  attempt: number,
  last: NodeAttemptResult,
  context: RuntimeContext
): NodeAttemptCycleResult {
  const result = passedNodeResult(nodeId, attempt, last);
  recordNodeEvent(context, nodeId, { at: now(), result, type: "PASSED" });
  return { last, result };
}

function passedNodeResult(
  nodeId: string,
  attempt: number,
  last: NodeAttemptResult
): RuntimeNodeResult {
  return {
    attempts: attempt,
    evidence: last.evidence,
    exitCode: 0,
    nodeId,
    output: last.output,
    status: "passed",
  };
}

function retryCycle(
  node: PlannedWorkflowNode,
  attempt: number,
  last: NodeAttemptResult,
  failedGate: RuntimeGateResult | undefined
): NodeAttemptCycleResult {
  return {
    last,
    retry: {
      attempt,
      evidence: retryEvidence(last, failedGate),
      gate: retryGateId(node.id, failedGate),
      reason: retryReasonText(last.exitCode, failedGate),
      retryReason: nodeRetryReason(last, failedGate),
    },
  };
}

function retryGateId(
  nodeId: string,
  failedGate: RuntimeGateResult | undefined
): string {
  return failedGate ? failedGate.gateId : nodeId;
}

function retryReasonText(
  exitCode: number,
  failedGate: RuntimeGateResult | undefined
): string {
  if (!failedGate) {
    return `node exited with code ${exitCode}`;
  }
  return failedGate.reason ?? `node exited with code ${exitCode}`;
}

function retryEvidence(
  last: NodeAttemptResult,
  failedGate: RuntimeGateResult | undefined
): string[] {
  return failedGate
    ? [...last.evidence, ...failedGate.evidence]
    : last.evidence.concat(`node exited with code ${last.exitCode}`);
}

function snapshotChangedFilesEffect(
  worktreePath: string
): Effect.Effect<ReturnType<typeof snapshotChangedFiles>> {
  return Effect.sync(() => snapshotChangedFiles(worktreePath));
}

function nodeRetryReason(
  attempt: NodeAttemptResult,
  failedGate?: RuntimeGateResult
): RetryReason {
  if (attempt.timedOut) {
    return "timeout";
  }
  if (failedGate) {
    return "gate_failure";
  }
  return "exit_nonzero";
}

function retryCandidateForCycle(
  node: PlannedWorkflowNode,
  cycle: NodeAttemptCycleResult,
  last: NodeAttemptResult,
  attempt: number
): NodeAttemptRetry {
  return (
    cycle.retry ?? {
      attempt,
      evidence: last.evidence,
      gate: node.id,
      reason: `node exited with code ${last.exitCode}`,
      retryReason: nodeRetryReason(last),
    }
  );
}

function cancelledNodeResult(
  context: RuntimeContext,
  nodeId: string,
  attempt: number,
  last: NodeAttemptResult
): RuntimeNodeResult | null {
  if (!isCancelled(context)) {
    return null;
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
  return result;
}

function nodeFailure(
  nodeId: string,
  attempts: number,
  evidence: string[],
  output: string,
  exitCode = 1
): RuntimeNodeResult {
  return {
    attempts,
    evidence,
    exitCode,
    nodeId,
    output,
    status: "failed",
  };
}

function executeNodeAttempt(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number
): Effect.Effect<NodeAttemptResult, unknown> {
  return nodeAttemptExecutors[node.kind](node, context, attempt);
}

type NodeAttemptExecutor = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number
) => Effect.Effect<NodeAttemptResult, unknown>;

const nodeAttemptExecutors: Record<
  PlannedWorkflowNode["kind"],
  NodeAttemptExecutor
> = {
  agent: executeAgentAttempt,
  builtin: executeBuiltinAttempt,
  command: executeCommandAttempt,
  group: executeGroupAttempt,
  parallel: executeParallelAttempt,
};

function executeAgentAttempt(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number
): Effect.Effect<NodeAttemptResult, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => executeAgentNode(node, context, attempt),
  });
}

function executeCommandAttempt(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Effect.Effect<NodeAttemptResult, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () =>
      executeCommand(node.command ?? [], context, { timeout: node.timeoutMs }),
  });
}

function executeBuiltinAttempt(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Effect.Effect<NodeAttemptResult, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => executeBuiltin(node.builtin ?? "", context, node),
  });
}

function executeGroupAttempt(
  node: PlannedWorkflowNode
): Effect.Effect<NodeAttemptResult> {
  return Effect.succeed({
    evidence: [`group '${node.id}' completed`],
    exitCode: 0,
    output: "",
  });
}

function executeParallelAttempt(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Effect.Effect<NodeAttemptResult, unknown> {
  return Effect.tryPromise(() =>
    executeParallelNode(node, context, {
      executeNode: (child, childContext) =>
        Effect.runPromise(executeNode(child, childContext)),
      markNodeReady: (childContext, childId) =>
        markNodeReady(childContext, childId),
    })
  );
}

function dispatchGateFailureHook(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  result: RuntimeGateResult
): Effect.Effect<void, unknown> {
  return Effect.asVoid(
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
      result.gateId
    )
  );
}

function now(): string {
  return new Date().toISOString();
}
