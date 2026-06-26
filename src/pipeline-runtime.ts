import { Effect, type Scope } from "effect";
import {
  loadPipelineConfig,
  type PipelineConfig,
  type PipelineConfigError,
} from "./config";
import { loadMokaDbUrl } from "./moka-global-config";
import { findPlannedNode } from "./planned-node";
import type { PlannedWorkflowNode } from "./planning/compile";
import type { RetryReason } from "./runtime/actor-ids";
import { executeAgentNode } from "./runtime/agent-node";
import { executeBuiltin } from "./runtime/builtins";
import {
  diffChangedFiles,
  snapshotChangedFiles,
} from "./runtime/changed-files";
import { executeCommand } from "./runtime/command-executor";
import { createRuntimeContext } from "./runtime/context";
import type {
  NodeAttemptCycleResult,
  NodeAttemptResult,
  NodeAttemptRetry,
  NodeExecutionState,
  PipelineRuntimeOptions,
  PipelineRuntimeResult,
  RuntimeContext,
  RuntimeFailure,
  RuntimeGateResult,
  RuntimeNodeResult,
  RuntimeStructuredOutput,
} from "./runtime/contracts";
import { postgresDurableRunStore } from "./runtime/durable-store/postgres/postgres-store";
import {
  emitNodeFinish,
  emitNodeOutputRecorded,
  emitNodeStart,
  emitWorkflowFinish,
  emitWorkflowPlanned,
  emitWorkflowStarted,
  runtimeNodeActorDescriptor,
} from "./runtime/events";
import { EXIT_INFRA } from "./runtime/exit-codes";
import { evaluateNodeGates } from "./runtime/gates";
import { dispatchHooks } from "./runtime/hooks";
import { parseJsonObject } from "./runtime/json-validation";
import {
  LocalScheduler,
  type PipelineScheduler,
} from "./runtime/local-scheduler";
import {
  type NodeExecutionEvent,
  NodeStateTracker,
} from "./runtime/node-state-tracker";
import {
  configUsesOpencode,
  leaseOpencodeRuntime,
  type RuntimeExecutor,
} from "./runtime/opencode-runtime";
import { executeParallelNode } from "./runtime/parallel-node";
import {
  type NodeRemediationResult,
  type RuntimeRemediationDependencies,
  remediateFailedNode,
} from "./runtime/remediation/remediation";
import { decideNodeRetry, nodeRetryPolicy } from "./runtime/retry";
import type { RunJournal } from "./runtime/run-journal";

/**
 * Top layer of the runtime-options stack (PIPE-74 B3). Extends
 * {@link PipelineRuntimeOptions} for the schedule-driven path that runs a
 * SINGLE workflow node (`nodeId`) in isolation, supplying that node's upstream
 * `dependencyOutputs`. Full stack:
 *   RunnerExecutionOptions (src/runner.ts)
 *     < PipelineRuntimeOptions (src/runtime/contracts/contracts.ts)
 *     < ScheduledWorkflowTaskRuntimeOptions (this type)
 */
export interface ScheduledWorkflowTaskRuntimeOptions
  extends PipelineRuntimeOptions {
  dependencyOutputs?: Map<string, string> | Record<string, string>;
  nodeId: string;
}

export type {
  AcceptanceCriterion,
  HookRuntimePolicy,
  NodeExecutionState,
  NodeStatus,
  PipelineRuntimeEvent,
  PipelineRuntimeObservabilityLevel,
  PipelineRuntimeOptions,
  PipelineRuntimeResult,
  PipelineTaskContext,
  RuntimeFailure,
  RuntimeGateResult,
  RuntimeNodeResult,
  RuntimeStructuredOutput,
} from "./runtime/contracts";
export function runPipelineFromConfig(
  options: PipelineRuntimeOptions
): Promise<PipelineRuntimeResult> {
  const dbUrl = loadMokaDbUrl();
  return Effect.runPromise(
    withOpencodeRuntime(options, (resolved) =>
      runPipelineWithContext(createRuntimeContext(resolved), dbUrl)
    )
  );
}

/**
 * PIPE-91.8: cross-invocation resume. Continue an EXISTING `runId` through the
 * identical scheduler path that {@link runPipelineFromConfig} drives, seeded from
 * the durable Postgres journal (PIPE-91.5): already-passed nodes are replayed
 * from the store and never re-run; only unfinished nodes execute under the
 * default spawn-and-run executor. The durable substrate `dbUrl` is supplied by
 * the caller (the run-control CLI resolves it via `loadMokaDbUrl`) so this
 * entrypoint stays a pure function of its inputs and is testable against the real
 * cluster Postgres. Resume requires both a durable store and persisted state for
 * the run; a run with neither is not resumable and {@link requireResumableRun}
 * rejects it.
 */
export interface ResumeRunOptions extends PipelineRuntimeOptions {
  dbUrl: string | undefined;
  runId: string;
}

export function resumeRun(
  options: ResumeRunOptions
): Promise<PipelineRuntimeResult> {
  const { dbUrl, ...runtimeOptions } = options;
  return Effect.runPromise(
    withOpencodeRuntime(runtimeOptions, (resolved) =>
      resumeRunWithContext(createRuntimeContext(resolved), dbUrl)
    )
  );
}

export function runScheduledWorkflowTask(
  options: ScheduledWorkflowTaskRuntimeOptions
): Promise<RuntimeNodeResult> {
  const { dependencyOutputs, nodeId, ...runtimeOptions } = options;
  return Effect.runPromise(
    withOpencodeRuntime(runtimeOptions, (resolved) =>
      Effect.gen(function* () {
        const context = createRuntimeContext(resolved);
        hydrateScheduledDependencyStates(context, nodeId);
        hydrateDependencyOutputs(context, dependencyOutputs);
        recordNodeEvent(context, nodeId, { at: now(), type: "READY" });
        return yield* executePlannedNode(nodeId, context);
      })
    )
  );
}

/**
 * When the config uses opencode and the caller did not inject an executor,
 * open one opencode server for the run, drive nodes through the SDK executor,
 * and tear the server down afterward. Command-only configs and callers that
 * supply their own executor (tests, embedders) are passed through untouched.
 */
function withOpencodeRuntime<T>(
  options: PipelineRuntimeOptions,
  run: (resolved: PipelineRuntimeOptions) => Effect.Effect<T, unknown>
): Effect.Effect<T, unknown> {
  return Effect.gen(function* () {
    if (options.executor) {
      return yield* run(options);
    }
    const { config, worktreePath } = resolveConfigForRun(options);
    if (configUsesOpencode(config)) {
      return yield* runWithLeasedOpencode(options, config, worktreePath, run);
    }
    return yield* run({ ...options, config });
  });
}

function resolveConfigForRun(options: PipelineRuntimeOptions): {
  config: PipelineConfig;
  worktreePath: string;
} {
  const worktreePath = options.worktreePath ?? process.cwd();
  return {
    config: options.config ?? loadPipelineConfig(worktreePath),
    worktreePath,
  };
}

function runWithLeasedOpencode<T>(
  options: PipelineRuntimeOptions,
  config: PipelineConfig,
  worktreePath: string,
  run: (resolved: PipelineRuntimeOptions) => Effect.Effect<T, unknown>
): Effect.Effect<T, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          leaseOpencodeRuntime({
            config,
            ...(options.reporter
              ? { onSession: opencodeSessionReporter(options.reporter) }
              : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            worktreePath,
          })
        ),
        (lease) => Effect.promise(() => lease.release())
      );
      const availableModels = yield* Effect.promise(() =>
        lease.availableModels()
      );
      return yield* run({
        ...options,
        config,
        executor: lease.executor as RuntimeExecutor,
        ...(availableModels ? { availableModels } : {}),
      });
    })
  );
}

function opencodeSessionReporter(
  reporter: NonNullable<PipelineRuntimeOptions["reporter"]>
): (nodeId: string, sessionId: string) => void {
  return (nodeId, sessionId) => {
    reporter({ nodeId, sessionId, type: "node.session" });
  };
}

// PIPE-91.5: db.url presence is the durable-substrate switch, and the one place
// the switch is made. Acquire the run's journal as a scoped resource:
//   db.url set + runId → Postgres store hydrated for THIS run's runId; its
//     terminal node results persist and the run resumes from them. The store
//     owns a connection pool, so it is released (close()) on scope exit — the
//     run never leaks connections. close() flushes pending write-through first,
//     surfacing any persistence failure rather than swallowing it.
//   db.url absent (or no runId) → no journal: the scheduler runs purely
//     in-memory, byte-identical to today's default.
// The journal feeds the existing LocalScheduler.resolveJournal seam (PIPE-91.1),
// so scheduler.ts is untouched and the scheduler stays synchronous.
export function acquireRunJournal(
  runId: string | undefined,
  dbUrl: string | undefined
): Effect.Effect<RunJournal | undefined, unknown, Scope.Scope> {
  if (runId === undefined || dbUrl === undefined) {
    return Effect.succeed(undefined);
  }
  return Effect.acquireRelease(
    Effect.tryPromise(() => postgresDurableRunStore(dbUrl, runId)),
    (store) => Effect.promise(() => store.close())
  ).pipe(Effect.map((store) => store.toRunJournal(runId)));
}

function runPipelineWithContext(
  context: RuntimeContext,
  dbUrl: string | undefined
): Effect.Effect<PipelineRuntimeResult, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const journal = yield* acquireRunJournal(context.runId, dbUrl);
      const scheduler = buildPipelineScheduler(context, journal);
      const result = yield* Effect.tryPromise(() =>
        scheduler.runWorkflow(context.plan, context)
      );
      return finishRuntime(context, result);
    })
  );
}

// PIPE-91.8: the resume twin of runPipelineWithContext. It acquires the same
// scoped runId journal and drives the same scheduler, but FIRST asserts the run
// is resumable: a missing journal (no db.url) or an empty resume seed (unknown
// runId, or a run with no persisted node results) is rejected with a clear error
// rather than silently starting a brand-new run under that id.
function resumeRunWithContext(
  context: RuntimeContext,
  dbUrl: string | undefined
): Effect.Effect<PipelineRuntimeResult, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const journal = yield* acquireRunJournal(context.runId, dbUrl);
      yield* requireResumableRun(context.runId, journal);
      const scheduler = buildPipelineScheduler(context, journal);
      const result = yield* Effect.tryPromise(() =>
        scheduler.runWorkflow(context.plan, context)
      );
      return finishRuntime(context, result);
    })
  );
}

function requireResumableRun(
  runId: string | undefined,
  journal: RunJournal | undefined
): Effect.Effect<void, Error> {
  if (journal === undefined) {
    return Effect.fail(
      new Error(
        `Cannot resume run '${runId ?? "<unknown>"}': no durable store is configured (set momokaya.db.url).`
      )
    );
  }
  if (journal.resumeCompleted().length === 0) {
    return Effect.fail(
      new Error(
        `Cannot resume run '${runId}': no persisted node results were found in the durable store.`
      )
    );
  }
  return Effect.void;
}

function buildPipelineScheduler(
  context: RuntimeContext,
  journal: RunJournal | undefined
): PipelineScheduler {
  return new LocalScheduler({
    buildResult: (outcome, nodes, failure) =>
      workflowRuntimeResult(context, outcome, nodes, failure),
    emitWorkflowPlanned: (nextContext) => emitWorkflowPlanned(nextContext),
    emitWorkflowStarted: (nextContext) => emitWorkflowStarted(nextContext),
    executeNode: (nodeId, nextContext) =>
      Effect.runPromise(executePlannedNode(nodeId, nextContext)),
    isCancelled: (nextContext) => isCancelled(nextContext),
    markNodeReady: (nodeId, nextContext) =>
      recordNodeEvent(nextContext, nodeId, { at: now(), type: "READY" }),
    resolveJournal: () => journal,
    runWorkflowHook: (event, failure, nextContext) =>
      Effect.runPromise(dispatchHooksEffect(nextContext, event, failure)),
    shouldContinueAfterNodeResult: (result, nextContext) =>
      shouldContinueAfterNodeResult(result, nextContext),
    skipNode: (nodeId, reason, nextContext) =>
      recordSkippedNodeState(nextContext, nodeId, reason, now()),
  });
}

function shouldContinueAfterNodeResult(
  result: RuntimeNodeResult,
  context: RuntimeContext
): boolean {
  if (result.status !== "failed") {
    return true;
  }
  const node = context.plan.graph.node(result.nodeId);
  return isRecoverableParallelFailure(node, result.output, context);
}

function isRecoverableParallelFailure(
  node: PlannedWorkflowNode | undefined,
  output: string,
  context: RuntimeContext
): boolean {
  if (!isParallelWithChildren(node, output)) {
    return false;
  }
  return hasOnlyDrainMergeDependents(node, context);
}

function isParallelWithChildren(
  node: PlannedWorkflowNode | undefined,
  output: string
): node is PlannedWorkflowNode {
  if (!node) {
    return false;
  }
  return node.kind === "parallel" ? parallelOutputHasChildren(output) : false;
}

function hasOnlyDrainMergeDependents(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): boolean {
  if (node.dependents.length === 0) {
    return false;
  }
  return node.dependents.every((dependentId) =>
    isDrainMergeNode(context.plan.graph.node(dependentId))
  );
}

function parallelOutputHasChildren(output: string): boolean {
  return (
    Object.keys(parseJsonObject(parseJsonObject(output).children)).length > 0
  );
}

function isDrainMergeNode(node: PlannedWorkflowNode | undefined): boolean {
  if (!node) {
    return false;
  }
  return node.kind === "builtin" ? node.builtin === "drain-merge" : false;
}

function executePlannedNode(
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

function dispatchHooksEffect(
  ...args: Parameters<typeof dispatchHooks>
): Effect.Effect<Awaited<ReturnType<typeof dispatchHooks>>, unknown> {
  return Effect.tryPromise(() => dispatchHooks(...args));
}

const runtimeRemediationDependencies: RuntimeRemediationDependencies = {
  executeNode,
  isCancelled,
  snapshotChangedFiles: snapshotChangedFilesEffect,
};

function plannedNodeById(
  context: RuntimeContext,
  nodeId: string
): PlannedWorkflowNode | undefined {
  return (
    context.plan.graph.node(nodeId) ??
    findPlannedNode(context.plan.topologicalOrder, nodeId)
  );
}

function workflowRuntimeResult(
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

function workflowRuntimeFailure(): RuntimeFailure {
  return {
    evidence: ["workflow failed without a specific failure"],
    gate: "workflow",
    reason: "workflow failed",
  };
}

function nodeRuntimeFailure(node: RuntimeNodeResult): RuntimeFailure {
  return {
    evidence: node.evidence,
    gate: node.nodeId,
    nodeId: node.nodeId,
    reason: `node '${node.nodeId}' failed`,
  };
}

function finishRuntime(
  context: RuntimeContext,
  result: PipelineRuntimeResult
): PipelineRuntimeResult {
  emitWorkflowFinish(context, result.outcome);
  return result;
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

function hydrateDependencyOutputs(
  context: RuntimeContext,
  dependencyOutputs: ScheduledWorkflowTaskRuntimeOptions["dependencyOutputs"]
): void {
  const outputs = dependencyOutputMap(dependencyOutputs);
  const finishedAt = now();
  for (const [nodeId, output] of outputs) {
    context.nodeStateStore.recordOutput(nodeId, output);
    context.nodeStateStore.markInheritedOutput(nodeId);
    context.nodeStateStore.setNodeState(
      nodeId,
      inheritedDependencyOutputState(context, nodeId, output, finishedAt)
    );
  }
}

function dependencyOutputMap(
  dependencyOutputs: ScheduledWorkflowTaskRuntimeOptions["dependencyOutputs"]
): Map<string, string> {
  if (dependencyOutputs instanceof Map) {
    return dependencyOutputs;
  }
  return new Map(Object.entries(dependencyOutputs ?? {}));
}

function inheritedDependencyOutputState(
  context: RuntimeContext,
  nodeId: string,
  output: string,
  finishedAt: string
): NodeExecutionState {
  const existing = context.nodeStateStore.getNodeState(nodeId);
  return {
    attempts: existingAttempts(existing),
    evidence: inheritedOutputEvidence(existing),
    exitCode: existingExitCode(existing),
    finishedAt: existingFinishedAt(existing, finishedAt),
    gates: existingGates(existing),
    id: nodeId,
    output,
    status: "passed",
  };
}

function existingAttempts(existing: NodeExecutionState | undefined): number {
  return existing ? existing.attempts : 1;
}

function inheritedOutputEvidence(
  existing: NodeExecutionState | undefined
): string[] {
  const evidence = existing ? existing.evidence : [];
  return [...evidence, "dependency output inherited from Argo artifact"];
}

function existingExitCode(existing: NodeExecutionState | undefined): number {
  return existing ? (existing.exitCode ?? 0) : 0;
}

function existingFinishedAt(
  existing: NodeExecutionState | undefined,
  fallback: string
): string {
  return existing ? (existing.finishedAt ?? fallback) : fallback;
}

function existingGates(
  existing: NodeExecutionState | undefined
): RuntimeGateResult[] {
  return existing ? existing.gates : [];
}

function hydrateScheduledDependencyStates(
  context: RuntimeContext,
  nodeId: string
): void {
  const finishedAt = now();
  for (const dependencyId of scheduledDependencyNodeIds(context, nodeId)) {
    const existing = context.nodeStateStore.getNodeState(dependencyId);
    context.nodeStateStore.setNodeState(
      dependencyId,
      scheduledDependencyState(dependencyId, finishedAt, existing)
    );
  }
}

function scheduledDependencyState(
  id: string,
  finishedAt: string,
  existing?: NodeExecutionState
): NodeExecutionState {
  const base = existing ?? emptyScheduledDependencyState(id);
  return completedScheduledDependencyState(base, finishedAt);
}

function emptyScheduledDependencyState(id: string): NodeExecutionState {
  return {
    attempts: 0,
    evidence: [],
    gates: [],
    id,
    status: "pending",
  };
}

function completedScheduledDependencyState(
  base: NodeExecutionState,
  finishedAt: string
): NodeExecutionState {
  return {
    ...base,
    attempts: positiveAttempts(base),
    evidence: dependencyEvidence(base),
    exitCode: base.exitCode ?? 0,
    finishedAt: base.finishedAt ?? finishedAt,
    output: base.output ?? "",
    status: "passed",
  };
}

function positiveAttempts(state: NodeExecutionState): number {
  return state.attempts > 0 ? state.attempts : 1;
}

function dependencyEvidence(state: NodeExecutionState): string[] {
  return state.evidence.length > 0
    ? state.evidence
    : ["dependency satisfied by scheduled workflow"];
}

function scheduledDependencyNodeIds(
  context: RuntimeContext,
  nodeId: string
): string[] {
  const visited = new Set<string>();
  const ordered: string[] = [];
  const visit = (candidateId: string): void => {
    if (visited.has(candidateId)) {
      return;
    }
    visited.add(candidateId);
    const candidate = context.plan.graph.node(candidateId);
    if (!candidate) {
      return;
    }
    for (const need of candidate.needs) {
      visit(need);
    }
    ordered.push(candidateId);
  };
  const node = context.plan.graph.node(nodeId);
  for (const need of node?.needs ?? []) {
    visit(need);
  }
  return ordered;
}

function cancelledFailure(): RuntimeFailure {
  return {
    evidence: ["pipeline cancelled by AbortSignal"],
    gate: "cancelled",
    reason: "pipeline cancelled",
  };
}

function recordSkippedNodeState(
  context: RuntimeContext,
  nodeId: string,
  reason: string,
  at: string
): void {
  recordNodeEvent(context, nodeId, { at, reason, type: "SKIPPED" });
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

function now(): string {
  return new Date().toISOString();
}

function isCancelled(context: RuntimeContext): boolean {
  return context.signal?.aborted === true;
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
  return Effect.catchAll(
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
      return "retry";
    }
    return yield* scheduleNodeRetry(node, context, retryPolicy, retry, attempt);
  });
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
    if (!retryDecision?.scheduled) {
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
  retryDecision: ReturnType<typeof decideNodeRetry>
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

// Effect's Effect.tryPromise wraps the real rejection in an UnknownException
// (whose own .message is the generic "An unknown error occurred in
// Effect.tryPromise"), and Effect.runPromise rejects with a FiberFailure whose
// .message is the pretty-printed cause. Unwrap both so a failed node surfaces the
// REAL cause as evidence instead of the opaque wrapper (the pre-Effect behaviour).
function unwrapAttemptError(error: unknown): unknown {
  const wrapped = error as { error?: unknown };
  const inner = wrapped?.error;
  return inner !== undefined && inner !== error ? inner : error;
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
  retry: ReturnType<typeof decideNodeRetry>,
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
  return Effect.async<void>((resume) => {
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
    // An infra failure (agent timeout/idle/provider) carries empty, unreliable
    // output. Running output gates on it only yields a misleading gate failure
    // and launders the retry-eligible EXIT_INFRA into a terminal gate failure.
    // Skip gates and let the infra exit propagate so the node retries.
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
        recordNodeEvent(childContext, childId, { at: now(), type: "READY" }),
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

export function formatConfigError(err: PipelineConfigError): string {
  return [
    err.message,
    ...err.issues.map((issue) =>
      issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`
    ),
  ].join("\n");
}
