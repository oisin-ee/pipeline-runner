import micromatch from "micromatch";
import type {
  ChangedFilesGateSpec,
  RuntimeContext,
  RuntimeGateResult,
} from "../../../contracts";

/**
 * Evaluates changed-file allow/deny/require_any/include_untracked policies
 * against the set of files the node wrote during its run. Supervisor-owned
 * run-state writes (journal, run-control) are excluded before policy evaluation
 * so nodes are not penalised for bookkeeping they did not author.
 */
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
