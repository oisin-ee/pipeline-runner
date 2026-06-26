import { join } from "node:path";
import { Effect } from "effect";
import micromatch from "micromatch";
import { artifactExists } from "../../gates";
import type { PlannedWorkflowNode } from "../../planning/compile";
import { isRecord, parseJsonResult } from "../../safe-json";
import { executeBuiltin } from "../builtins";
import type {
  AcceptanceCriterion,
  AcceptanceGateSpec,
  ArtifactGateSpec,
  BuiltinGateSpec,
  ChangedFilesGateSpec,
  CommandGateSpec,
  JsonSchemaGateSpec,
  JsonSourceGateSpec,
  NodeAttemptResult,
  RuntimeContext,
  RuntimeGateResult,
  UnmetCriterion,
  VerdictGateSpec,
} from "../contracts";
import { readOptionalFile, validateJsonSchemaSource } from "../json-validation";
import type { CommandExecutorService } from "./contract";

export async function evaluateCommandGate(
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

export function evaluateArtifactGate(
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

export async function evaluateBuiltinGate(
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

export function evaluateVerdictGate(
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

export function evaluateAcceptanceGate(
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
  const unmet = acceptanceUnmetCriteria(expected, entries);
  const passed = unmet.length === 0;
  return {
    evidence: passed
      ? ["acceptance coverage passed"]
      : unmet.map((item) => item.reason),
    gateId,
    kind: gate.kind,
    nodeId,
    passed,
    reason: passed ? undefined : "acceptance coverage failed",
    unmet,
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

/**
 * Structured refusal producer (PIPE-90.1): the single source of truth for which
 * acceptance criteria a node failed to satisfy. Each {@link UnmetCriterion}
 * names the criterion, a human-readable reason, and deterministic proof. The
 * acceptance gate's flat `evidence` field is the `reason` projection of this,
 * so refusal text and ordering stay in lockstep with the structured form.
 */
export function acceptanceUnmetCriteria(
  expected: AcceptanceCriterion[],
  entries: Record<string, unknown>[]
): UnmetCriterion[] {
  const unmet: UnmetCriterion[] = [];
  const expectedIds = new Set(expected.map((criterion) => criterion.id));
  const seen = new Map<string, number>();
  for (const entry of entries) {
    unmet.push(...entryUnmetCriteria(entry, expectedIds, seen));
  }
  for (const id of expectedIds) {
    unmet.push(...coverageCountUnmetCriteria(id, seen.get(id) ?? 0));
  }
  return unmet;
}

function entryUnmetCriteria(
  entry: Record<string, unknown>,
  expectedIds: Set<string>,
  seen: Map<string, number>
): UnmetCriterion[] {
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!id) {
    return [
      {
        criterion: "",
        evidence: ["acceptance entry has no id field"],
        reason: "acceptance entry missing id",
      },
    ];
  }
  seen.set(id, (seen.get(id) ?? 0) + 1);
  const unmet: UnmetCriterion[] = [];
  if (!expectedIds.has(id)) {
    unmet.push({
      criterion: id,
      evidence: [`id '${id}' not in task acceptance context`],
      reason: `extra acceptance criterion '${id}'`,
    });
  }
  const verdict = entry.verdict;
  if (verdict !== "PASS") {
    unmet.push({
      criterion: id,
      evidence: [`reported verdict '${String(verdict)}'`],
      reason: `acceptance criterion '${id}' verdict '${String(verdict)}'`,
    });
  }
  if (verdict === "PASS" && !hasNonEmptyEvidence(entry.evidence)) {
    unmet.push({
      criterion: id,
      evidence: ["verdict 'PASS' reported without supporting evidence"],
      reason: `acceptance criterion '${id}' has no evidence`,
    });
  }
  return unmet;
}

function coverageCountUnmetCriteria(
  id: string,
  count: number
): UnmetCriterion[] {
  const unmet: UnmetCriterion[] = [];
  if (count === 0) {
    unmet.push({
      criterion: id,
      evidence: [`criterion '${id}' absent from acceptance report`],
      reason: `missing acceptance criterion '${id}'`,
    });
  }
  if (count > 1) {
    unmet.push({
      criterion: id,
      evidence: [`criterion '${id}' reported ${count} times`],
      reason: `duplicate acceptance criterion '${id}'`,
    });
  }
  return unmet;
}

function hasNonEmptyEvidence(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.filter((item) => typeof item === "string" && item.trim()).length > 0
  );
}

export function evaluateChangedFilesGate(
  gate: ChangedFilesGateSpec,
  gateId: string,
  nodeId: string,
  context: Pick<RuntimeContext, "nodeStateStore">
): RuntimeGateResult {
  const changed = context.nodeStateStore.changedFiles(nodeId);
  const policy = gate.changed_files ?? {};
  const evidence: string[] = [];
  const untrackedFiltered =
    policy.include_untracked === false
      ? changed.filter((file) => !file.startsWith("?? "))
      : changed;
  // Drop the supervisor's own run-state writes before any deny/allow/require_any
  // evaluation. The run-control store and journal write into .pipeline/ inside
  // the worktree WHILE nodes run (PIPE-85), so without this every write-mode
  // node would fail the gate on bookkeeping it never authored. Scope is limited
  // to named run-state paths so genuine node output under .pipeline/ is still
  // gated.
  const included = untrackedFiltered.filter(
    (file) => !isSupervisorRunStatePath(file)
  );
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

/**
 * Supervisor-owned run-state the run-control store and journal write into the
 * worktree's .pipeline/ during a run (src/run-control/store.ts RUNS_DIRECTORY
 * and src/runtime/run-journal.ts). These are never node-authored content under
 * test, so the changed_files gate must not attribute them to a node. Narrowly
 * scoped to run-state, NOT a blanket .pipeline/ bypass, so a node that writes
 * real output under .pipeline/ is still gated.
 */
const SUPERVISOR_RUN_STATE_GLOBS = [
  "**/.pipeline/runs/**",
  "**/.pipeline/journal/**",
  "**/.pipeline/runtime-events.jsonl",
  "**/.pipeline/**/status.json",
];

function isSupervisorRunStatePath(file: string): boolean {
  const path = stripPorcelainStatusPrefix(file);
  return SUPERVISOR_RUN_STATE_GLOBS.some((pattern) => globMatch(pattern, path));
}

/**
 * Snapshot entries are repo-relative paths (the porcelain parser already strips
 * the status code), but some fixtures and untracked entries carry a leading
 * "XY " status prefix. Strip it before matching run-state globs so both shapes
 * resolve to the same path; non-prefixed paths (".pipeline/...") are unchanged.
 */
const PORCELAIN_STATUS_PREFIX = /^.{2} /;

function stripPorcelainStatusPrefix(file: string): string {
  return PORCELAIN_STATUS_PREFIX.test(file) ? file.slice(3) : file;
}

function globMatch(pattern: string, value: string): boolean {
  return micromatch.isMatch(value, pattern, { dot: true });
}

export function evaluateJsonSchemaGate(
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
