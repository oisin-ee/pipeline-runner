import { join } from "node:path";
import micromatch from "micromatch";
import { createActor, waitFor } from "xstate";
import { artifactExists } from "../../gates";
import { runtimeActorId } from "../../runtime-machines/contracts";
import { gateEvaluationMachine } from "../../runtime-machines/gate-machine";
import { parseJson as parseSafeJson } from "../../safe-json";
import type { PlannedWorkflowNode } from "../../workflow-planner";
import { executeBuiltin } from "../builtins";
import { executeCommand } from "../command-executor";
import type {
  AcceptanceCriterion,
  AcceptanceGateSpec,
  ArtifactGateSpec,
  BuiltinGateSpec,
  ChangedFilesGateSpec,
  CommandGateSpec,
  GateSpec,
  JsonSchemaGateSpec,
  JsonSourceGateSpec,
  NodeAttemptResult,
  RuntimeContext,
  RuntimeGateResult,
  VerdictGateSpec,
} from "../contracts";
import {
  emitGateFinish,
  emitGateStart,
  runtimeInspection,
  runtimeSystemId,
} from "../events";
import {
  isRecord,
  readOptionalFile,
  validateJsonSchemaSource,
} from "../json-validation";

export type GateFailureHook = (
  node: PlannedWorkflowNode,
  result: RuntimeGateResult
) => Promise<void> | void;

export async function evaluateNodeGates(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: NodeAttemptResult,
  onGateFailure?: GateFailureHook
): Promise<RuntimeGateResult[]> {
  const results: RuntimeGateResult[] = [];
  for (const gate of nodeGateSpecs(node, context)) {
    const gateId = gate.id ?? `${gate.kind}:${node.id}`;
    if (isCancelled(context)) {
      break;
    }
    emitGateStart(context, node.id, gate, gateId);
    const result = await runGateEvaluationActor(
      gate,
      gateId,
      node.id,
      context,
      attempt
    );
    context.gates.push(result);
    results.push(result);
    emitGateFinish(context, gate, result);
    if (!result.passed) {
      await onGateFailure?.(node, result);
      if (gate.required !== false) {
        break;
      }
    }
  }
  return results;
}

async function runGateEvaluationActor(
  gate: GateSpec,
  gateId: string,
  nodeId: string,
  context: RuntimeContext,
  attempt: NodeAttemptResult
): Promise<RuntimeGateResult> {
  const actor = createActor(gateEvaluationMachine, {
    id: runtimeActorId("gate", {
      gateId,
      nodeId,
      runId: context.runId,
      workflowId: context.workflowId,
    }),
    input: {
      actor: {
        id: runtimeActorId("gate", {
          gateId,
          nodeId,
          runId: context.runId,
          workflowId: context.workflowId,
        }),
        kind: "gate",
        systemId: runtimeSystemId(context),
      },
      emit: context.observability,
      evaluate: () => evaluateGate(gate, nodeId, context, attempt),
      gateId,
      kind: gate.kind,
      nodeId,
    },
    ...(runtimeInspection(context)
      ? { inspect: runtimeInspection(context) }
      : {}),
  });
  actor.start();
  actor.send({ type: "START" });
  const snapshot = await waitFor(actor, (state) => state.status === "done");
  actor.stop();
  const result = snapshot.context.result;
  if (!result) {
    throw new Error(`gate '${gateId}' finished without a result`);
  }
  return result;
}

export function nodeGateSpecs(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): GateSpec[] {
  return [
    ...(node.gates ?? []),
    ...artifactGateSpecs(node),
    ...schemaGateSpecs(node, context),
  ];
}

export function artifactGateSpecs(node: PlannedWorkflowNode): GateSpec[] {
  return (node.artifacts ?? []).map(
    (artifact): GateSpec => ({
      id: `artifact:${artifact.path}`,
      kind: "artifact",
      path: artifact.path,
      required: artifact.required,
    })
  );
}

export function schemaGateSpecs(
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
  attempt: NodeAttemptResult
): RuntimeGateResult | Promise<RuntimeGateResult> {
  const gateId = gate.id ?? `${gate.kind}:${nodeId}`;
  const node = context.plan.graph.node(nodeId);
  switch (gate.kind) {
    case "command":
      return evaluateCommandGate(gate, gateId, nodeId, context);
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
  context: RuntimeContext
): Promise<RuntimeGateResult> {
  const result = await executeCommand(gate.command ?? [], context, {
    timeout: gate.timeout_ms,
  });
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
  try {
    return { value: parseSafeJson(source.source ?? "", "gate JSON") };
  } catch (err) {
    return {
      evidence: err instanceof Error ? err.message : String(err),
    };
  }
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

export function acceptanceEntries(
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

export function evaluateChangedFilesGate(
  gate: ChangedFilesGateSpec,
  gateId: string,
  nodeId: string,
  context: Pick<RuntimeContext, "nodeSnapshots">
): RuntimeGateResult {
  const changed = [...(context.nodeSnapshots.get(nodeId)?.files ?? new Set())];
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
