import { join } from "node:path";
import { Effect } from "effect";
import micromatch from "micromatch";
import { artifactExists } from "../../gates";
import type { PlannedWorkflowNode } from "../../planning/compile";
import { isRecord, parseJsonResult } from "../../safe-json";
import { runtimeActorId } from "../actor-ids";
import { executeBuiltin } from "../builtins";
import type { CommandExecutionContext } from "../command-executor";
import type {
  AcceptanceCriterion,
  AcceptanceGateSpec,
  ArtifactGateSpec,
  BuiltinGateSpec,
  ChangedFilesGateSpec,
  CommandExecutionOptions,
  CommandGateSpec,
  GateSpec,
  JsonSchemaGateSpec,
  JsonSourceGateSpec,
  NodeAttemptResult,
  RuntimeContext,
  RuntimeGateResult,
  VerdictGateSpec,
} from "../contracts";
import { emitGateFinish, emitGateStart, runtimeSystemId } from "../events";
import { readOptionalFile, validateJsonSchemaSource } from "../json-validation";
import {
  CommandExecutor,
  CommandExecutorLive,
} from "../services/command-executor-service";

export type GateFailureHook = (
  node: PlannedWorkflowNode,
  result: RuntimeGateResult
) => Promise<void> | void;

interface CommandExecutorService {
  readonly execute: (
    command: string[],
    context: CommandExecutionContext,
    options?: CommandExecutionOptions
  ) => Effect.Effect<NodeAttemptResult, unknown>;
}

type GateLoopAction = "continue" | "stop";

export function evaluateNodeGates(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  onGateFailure?: GateFailureHook
): Promise<RuntimeGateResult[]> {
  return Effect.runPromise(
    Effect.provide(
      evaluateNodeGatesEffect(node, context, attempt, onGateFailure),
      CommandExecutorLive
    )
  );
}

function evaluateNodeGatesEffect(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  onGateFailure?: GateFailureHook
): Effect.Effect<RuntimeGateResult[], unknown, CommandExecutor> {
  return Effect.gen(function* () {
    const executor = yield* CommandExecutor;
    return yield* Effect.tryPromise(() =>
      evaluateNodeGatesWithExecutor(
        node,
        context,
        attempt,
        executor,
        onGateFailure
      )
    );
  });
}

async function evaluateNodeGatesWithExecutor(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  executor: CommandExecutorService,
  onGateFailure?: GateFailureHook
): Promise<RuntimeGateResult[]> {
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
}

async function evaluateNodeGateIteration(
  gate: GateSpec,
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  executor: CommandExecutorService,
  results: RuntimeGateResult[],
  onGateFailure?: GateFailureHook
): Promise<GateLoopAction> {
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
  return handleGateFailure(gate, node, result, onGateFailure);
}

function runObservedGate(
  gate: GateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  executor: CommandExecutorService
): Promise<RuntimeGateResult> {
  emitGateStart(context, nodeId, gate, gateId);
  return runGateEvaluation(gate, gateId, nodeId, context, attempt, executor);
}

function recordGateResult(
  context: RuntimeContext,
  gate: GateSpec,
  result: RuntimeGateResult,
  results: RuntimeGateResult[]
): void {
  context.gates.push(result);
  results.push(result);
  emitGateFinish(context, gate, result);
}

async function handleGateFailure(
  gate: GateSpec,
  node: PlannedWorkflowNode,
  result: RuntimeGateResult,
  onGateFailure?: GateFailureHook
): Promise<GateLoopAction> {
  if (result.passed) {
    return "continue";
  }
  if (onGateFailure) {
    await onGateFailure(node, result);
  }
  return gate.required === false ? "continue" : "stop";
}

async function runGateEvaluation(
  gate: GateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  executor: CommandExecutorService
): Promise<RuntimeGateResult> {
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
}

async function resolveGateResult(
  gate: GateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  executor: CommandExecutorService
): Promise<RuntimeGateResult> {
  try {
    return await evaluateGate(gate, nodeId, context, attempt, executor);
  } catch (err) {
    return {
      evidence: [err instanceof Error ? err.message : String(err)],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: false,
      reason: err instanceof Error ? err.message : "gate evaluation failed",
    };
  }
}

function runtimeGateActor(
  context: RuntimeContext,
  gateId: string,
  nodeId: string
) {
  return {
    id: runtimeActorId("gate", {
      gateId,
      nodeId,
      runId: context.runId,
      workflowId: context.workflowId,
    }),
    kind: "gate" as const,
    systemId: runtimeSystemId(context),
  };
}

function runtimeTimestamp(): string {
  return new Date().toISOString();
}

function emitRuntimeGateStarted(
  context: RuntimeContext,
  gate: GateSpec,
  gateId: string,
  nodeId: string
): void {
  context.observability?.({
    actor: runtimeGateActor(context, gateId, nodeId),
    gateId,
    kind: gate.kind,
    nodeId,
    timestamp: runtimeTimestamp(),
    type: "runtime.gate.started",
  });
}

function emitRuntimeGateResult(
  context: RuntimeContext,
  result: RuntimeGateResult
): void {
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
}

function emitRuntimeGateCancelled(
  context: RuntimeContext,
  gate: GateSpec,
  gateId: string,
  nodeId: string,
  reason: string
): void {
  context.observability?.({
    actor: runtimeGateActor(context, gateId, nodeId),
    gateId,
    kind: gate.kind,
    nodeId,
    reason,
    timestamp: runtimeTimestamp(),
    type: "runtime.gate.cancelled",
  });
}

function nodeGateSpecs(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): GateSpec[] {
  return [
    ...(node.gates ?? []),
    ...artifactGateSpecs(node),
    ...schemaGateSpecs(node, context),
  ];
}

function artifactGateSpecs(node: PlannedWorkflowNode): GateSpec[] {
  return (node.artifacts ?? []).map(
    (artifact): GateSpec => ({
      id: `artifact:${artifact.path}`,
      kind: "artifact",
      path: artifact.path,
      required: artifact.required,
    })
  );
}

function schemaGateSpecs(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): GateSpec[] {
  const profile = node.profile
    ? context.config.profiles[node.profile]
    : undefined;
  if (
    profile?.output?.format !== "json_schema" ||
    !profile.output.schema_path
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
}

function evaluateGate(
  gate: GateSpec,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  executor: CommandExecutorService
): RuntimeGateResult | Promise<RuntimeGateResult> {
  const gateId = gate.id ?? `${gate.kind}:${nodeId}`;
  const node = context.plan.graph.node(nodeId);
  switch (gate.kind) {
    case "command":
      return evaluateCommandGate(gate, gateId, nodeId, context, executor);
    case "artifact":
      return evaluateArtifactGate(gate, gateId, nodeId, context);
    case "builtin":
      return evaluateBuiltinGate(gate, gateId, nodeId, context);
    case "verdict":
      return evaluateVerdictGate(gate, gateId, nodeId, context, attempt);
    case "acceptance":
      return evaluateAcceptanceGate(
        gate,
        gateId,
        nodeId,
        context,
        attempt,
        node
      );
    case "changed_files":
      return evaluateChangedFilesGate(gate, gateId, nodeId, context);
    case "json_schema":
      return evaluateJsonSchemaGate(gate, gateId, nodeId, context, attempt);
    default:
      return assertNever(gate);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported gate kind: ${String(value)}`);
}

async function evaluateCommandGate(
  gate: CommandGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  executor: CommandExecutorService
): Promise<RuntimeGateResult> {
  const result = await Effect.runPromise(
    executor.execute(gate.command ?? [], context, { timeout: gate.timeout_ms })
  );
  const expected = gate.expect_exit_code ?? 0;
  return {
    evidence: result.evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed: result.exitCode === expected,
    reason:
      result.exitCode === expected
        ? undefined
        : `expected exit ${expected}, got ${result.exitCode}`,
  };
}

function evaluateArtifactGate(
  gate: ArtifactGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext
): RuntimeGateResult {
  const path = gate.path ?? "";
  const passed = Boolean(path) && artifactExists(context.worktreePath, path);
  return {
    evidence: [
      passed ? `artifact exists: ${path}` : `missing artifact: ${path}`,
    ],
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : `missing artifact '${path}'`,
  };
}

async function evaluateBuiltinGate(
  gate: BuiltinGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext
): Promise<RuntimeGateResult> {
  const result = await executeBuiltin(gate.builtin ?? "", context);
  return {
    evidence: result.evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed: result.exitCode === 0,
    reason:
      result.exitCode === 0
        ? undefined
        : `builtin '${gate.builtin ?? ""}' failed`,
  };
}

function gateJsonSource(
  gate: JsonSourceGateSpec,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): { evidence?: string; source?: string } {
  if (gate.target === "artifact") {
    if (!gate.path) {
      return { evidence: "missing JSON artifact path" };
    }
    const source = readOptionalFile(join(context.worktreePath, gate.path));
    return source === null
      ? { evidence: `missing JSON artifact: ${gate.path}` }
      : { source };
  }
  return { source: attempt.output };
}

function parseGateJson(
  gate: JsonSourceGateSpec,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): { evidence?: string; value?: unknown } {
  const source = gateJsonSource(gate, context, attempt);
  if (source.evidence) {
    return { evidence: source.evidence };
  }
  const parsed = parseJsonResult(source.source ?? "", "gate JSON");
  return parsed.error ? { evidence: parsed.error } : { value: parsed.value };
}

function evaluateVerdictGate(
  gate: VerdictGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): RuntimeGateResult {
  const parsed = parseGateJson(gate, context, attempt);
  const field = gate.field ?? "verdict";
  const expected = gate.equals ?? "PASS";
  if (parsed.evidence) {
    return {
      evidence: [parsed.evidence],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: false,
      reason: "verdict gate JSON parse failed",
    };
  }
  const value = isRecord(parsed.value) ? parsed.value[field] : undefined;
  const passed = value === expected;
  return {
    evidence: [
      passed
        ? `verdict '${field}' matched '${expected}'`
        : `verdict '${field}' expected '${expected}', got '${String(value)}'`,
    ],
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : "verdict requirement failed",
  };
}

function evaluateAcceptanceGate(
  gate: AcceptanceGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  node?: PlannedWorkflowNode
): RuntimeGateResult {
  const expected =
    (node ? effectiveTaskContext(node, context) : context.taskContext)
      ?.acceptanceCriteria ?? [];
  if (expected.length === 0) {
    return {
      evidence: ["no acceptance criteria in task context"],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: gate.required === false,
      reason:
        gate.required === false ? undefined : "missing task acceptance context",
    };
  }
  const parsed = parseGateJson(gate, context, attempt);
  if (parsed.evidence) {
    return {
      evidence: [parsed.evidence],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: false,
      reason: "acceptance gate JSON parse failed",
    };
  }
  const entries = acceptanceEntries(parsed.value, gate.acceptance_key);
  const evidence = acceptanceCoverageEvidence(expected, entries);
  const passed = evidence.length === 0;
  return {
    evidence: passed ? ["acceptance coverage passed"] : evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : "acceptance coverage failed",
  };
}

function effectiveTaskContext(
  node: PlannedWorkflowNode,
  context: RuntimeContext
) {
  return node.taskContext ?? context.taskContext;
}

function acceptanceEntries(
  value: unknown,
  key = "acceptance"
): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return [];
  }
  const raw = value[key] ?? value.criteria ?? value.acceptanceCriteria;
  return Array.isArray(raw)
    ? raw.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

// fallow-ignore-next-line unused-export
export function acceptanceCoverageEvidence(
  expected: AcceptanceCriterion[],
  entries: Record<string, unknown>[]
): string[] {
  const evidence: string[] = [];
  const expectedIds = new Set(expected.map((criterion) => criterion.id));
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id) {
      evidence.push("acceptance entry missing id");
      continue;
    }
    seen.set(id, (seen.get(id) ?? 0) + 1);
    if (!expectedIds.has(id)) {
      evidence.push(`extra acceptance criterion '${id}'`);
    }
    const verdict = entry.verdict;
    if (verdict !== "PASS") {
      evidence.push(
        `acceptance criterion '${id}' verdict '${String(verdict)}'`
      );
    }
    const itemEvidence = entry.evidence;
    if (
      verdict === "PASS" &&
      (!Array.isArray(itemEvidence) ||
        itemEvidence.filter((item) => typeof item === "string" && item.trim())
          .length === 0)
    ) {
      evidence.push(`acceptance criterion '${id}' has no evidence`);
    }
  }
  for (const id of expectedIds) {
    const count = seen.get(id) ?? 0;
    if (count === 0) {
      evidence.push(`missing acceptance criterion '${id}'`);
    }
    if (count > 1) {
      evidence.push(`duplicate acceptance criterion '${id}'`);
    }
  }
  return evidence;
}

// fallow-ignore-next-line unused-export
export function evaluateChangedFilesGate(
  gate: ChangedFilesGateSpec,
  gateId: string,
  nodeId: string,
  context: Pick<RuntimeContext, "nodeStateStore">
): RuntimeGateResult {
  const changed = context.nodeStateStore.changedFiles(nodeId);
  const policy = gate.changed_files ?? {};
  const evidence: string[] = [];
  const included =
    policy.include_untracked === false
      ? changed.filter((file) => !file.startsWith("?? "))
      : changed;
  const denied = included.filter((file) =>
    (policy.deny ?? []).some((pattern) => globMatch(pattern, file))
  );
  if (denied.length > 0) {
    evidence.push(`denied changes: ${denied.join(", ")}`);
  }
  const disallowed = included.filter(
    (file) =>
      (policy.allow?.length ?? 0) > 0 &&
      !(policy.allow ?? []).some((pattern) => globMatch(pattern, file))
  );
  if (disallowed.length > 0) {
    evidence.push(`changes outside allow list: ${disallowed.join(", ")}`);
  }
  if (
    (policy.require_any?.length ?? 0) > 0 &&
    !included.some((file) =>
      (policy.require_any ?? []).some((pattern) => globMatch(pattern, file))
    )
  ) {
    evidence.push(
      `missing required changes matching: ${(policy.require_any ?? []).join(", ")}`
    );
  }
  const passed = evidence.length === 0;
  return {
    evidence: passed
      ? [`changed files: ${included.join(", ") || "none"}`]
      : evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : "changed-file policy failed",
  };
}

function globMatch(pattern: string, value: string): boolean {
  return micromatch.isMatch(value, pattern, { dot: true });
}

function evaluateJsonSchemaGate(
  gate: JsonSchemaGateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): RuntimeGateResult {
  const schemaPath = gate.schema_path ?? "";
  const source =
    gate.target === "artifact" && gate.path
      ? readOptionalFile(join(context.worktreePath, gate.path))
      : attempt.output;
  if (source === null) {
    return {
      evidence: [`missing JSON artifact: ${gate.path ?? ""}`],
      gateId,
      kind: gate.kind,
      nodeId,
      passed: false,
      reason: `missing JSON artifact '${gate.path ?? ""}'`,
    };
  }
  const result = validateJsonSchemaSource(
    source,
    schemaPath,
    context.worktreePath
  );
  return {
    evidence: result.evidence,
    gateId,
    kind: gate.kind,
    nodeId,
    passed: result.passed,
    reason: result.reason,
  };
}

function isCancelled(context: RuntimeContext): boolean {
  return context.signal?.aborted === true;
}
