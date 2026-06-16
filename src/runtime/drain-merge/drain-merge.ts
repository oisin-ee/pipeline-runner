import { Effect } from "effect";
import type { PlannedWorkflowNode } from "../../planning/compile";
import { generateRuntimeRunId } from "../context";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { parseJsonObject } from "../json-validation";
import {
  type DrainMergeGitClient,
  DrainMergeGitService,
  DrainMergeGitServiceLive,
} from "../services/drain-merge-git-service";

const LINE_RE = /\r?\n/;

type DrainMergeStatus = "FAIL" | "PASS";

interface DrainMergeChildOutput {
  baseSha: string | null;
  branch: string | null;
  status: DrainMergeStatus;
  worktreePath: string | null;
}

interface DrainMergeMergeEntry {
  branch: string;
  id: string;
  worktreePath: string;
}

interface DrainMergeSkipEntry {
  id: string;
  reason: "failed" | "no-worktree";
  status: DrainMergeStatus;
}

interface DrainMergeConflictEntry {
  branch: string;
  files: string[];
  id: string;
  worktreePath: string;
}

interface DrainMergeReport {
  baseSha: string | null;
  conflicts: DrainMergeConflictEntry[];
  integrationBranch: string;
  merged: DrainMergeMergeEntry[];
  skipped: DrainMergeSkipEntry[];
}

export function executeDrainMergeBuiltin(
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Promise<NodeAttemptResult> {
  return Effect.runPromise(
    Effect.provide(drainMergeProgram(context, node), DrainMergeGitServiceLive)
  );
}

function drainMergeProgram(
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Effect.Effect<NodeAttemptResult, never, DrainMergeGitService> {
  const upstreamNodeId = firstNeededNode(node);
  const integrationBranch = `runs/integration/${runIdForDrainMerge(context)}`;
  const report: DrainMergeReport = {
    baseSha: null,
    conflicts: [],
    integrationBranch,
    merged: [],
    skipped: [],
  };

  const children = drainMergeChildren(context, upstreamNodeId);
  const mergeable = drainMergeMergeableChildren(children, report);
  if (mergeable.length === 0) {
    return Effect.succeed(drainMergeResult(report));
  }

  const baseSha = mergeable[0].output.baseSha;
  report.baseSha = baseSha;
  const divergent = divergentDrainMergeChild(mergeable, baseSha);
  if (divergent) {
    return Effect.succeed(
      drainMergeResult(report, {
        evidence: [
          `drain-merge child '${divergent.nodeId}' baseSha ${divergent.output.baseSha} diverges from ${report.baseSha}`,
        ],
        failed: true,
      })
    );
  }

  return Effect.gen(function* () {
    const gitService = yield* DrainMergeGitService;
    const git = yield* gitService.create(context.worktreePath);
    const setup = checkoutDrainMergeIntegrationBranch(
      git,
      integrationBranch,
      baseSha
    );
    const setupResult = yield* Effect.either(setup);
    if (setupResult._tag === "Left") {
      return drainMergeSetupErrorResult(report, setupResult.left);
    }
    yield* Effect.forEach(
      mergeable,
      (child) => mergeDrainMergeChild(git, report, child),
      { concurrency: 1, discard: true }
    );
    return drainMergeResult(report);
  });
}

function firstNeededNode(node?: PlannedWorkflowNode): string | null {
  return node?.needs.at(0) ?? null;
}

function runIdForDrainMerge(context: RuntimeContext): string {
  return context.runId ?? generateRuntimeRunId();
}

function drainMergeChildren(
  context: RuntimeContext,
  upstreamNodeId: string | null
): Array<{ nodeId: string; output: DrainMergeChildOutput }> {
  if (!upstreamNodeId) {
    return [];
  }
  const upstream = context.plan.graph.node(upstreamNodeId);
  const output = parseJsonObject(
    context.nodeStateStore.getOutput(upstreamNodeId)
  );
  const childrenOutput = parseJsonObject(output.children);
  return (upstream?.children ?? []).flatMap((child) => {
    const childOutput = parseDrainMergeChildOutput(childrenOutput[child.id]);
    return childOutput ? [{ nodeId: child.id, output: childOutput }] : [];
  });
}

function drainMergeMergeableChildren(
  children: Array<{ nodeId: string; output: DrainMergeChildOutput }>,
  report: DrainMergeReport
): Array<{
  nodeId: string;
  output: DrainMergeChildOutput & {
    baseSha: string;
    branch: string;
    worktreePath: string;
  };
}> {
  return children.flatMap((child) => {
    if (child.output.status !== "PASS") {
      report.skipped.push({
        id: child.nodeId,
        reason: "failed",
        status: child.output.status,
      });
      return [];
    }
    if (!hasDrainMergeWorktree(child.output)) {
      report.skipped.push({
        id: child.nodeId,
        reason: "no-worktree",
        status: child.output.status,
      });
      return [];
    }
    return [
      {
        nodeId: child.nodeId,
        output: {
          baseSha: child.output.baseSha,
          branch: child.output.branch,
          status: child.output.status,
          worktreePath: child.output.worktreePath,
        },
      },
    ];
  });
}

function hasDrainMergeWorktree(
  output: DrainMergeChildOutput
): output is DrainMergeChildOutput & {
  baseSha: string;
  branch: string;
  worktreePath: string;
} {
  return (
    Boolean(output.baseSha) &&
    Boolean(output.branch) &&
    Boolean(output.worktreePath)
  );
}

function divergentDrainMergeChild(
  mergeable: Array<{
    nodeId: string;
    output: DrainMergeChildOutput & {
      baseSha: string;
      branch: string;
      worktreePath: string;
    };
  }>,
  baseSha: string
) {
  return mergeable.find((child) => child.output.baseSha !== baseSha);
}

function checkoutDrainMergeIntegrationBranch(
  git: DrainMergeGitClient,
  integrationBranch: string,
  baseSha: string
): Effect.Effect<void, unknown> {
  return git.raw(["rev-parse", "--verify", integrationBranch]).pipe(
    Effect.flatMap(() => git.raw(["checkout", integrationBranch])),
    Effect.catchAll(() =>
      git.raw(["checkout", "-b", integrationBranch, baseSha])
    ),
    Effect.asVoid
  );
}

function mergeDrainMergeChild(
  git: DrainMergeGitClient,
  report: DrainMergeReport,
  child: {
    nodeId: string;
    output: DrainMergeChildOutput & {
      baseSha: string;
      branch: string;
      worktreePath: string;
    };
  }
): Effect.Effect<void, never> {
  return drainMergeChild(git, child.output.branch).pipe(
    Effect.tap(() => Effect.sync(() => recordDrainMergeSuccess(report, child))),
    Effect.catchAll(() => recordDrainMergeConflict(git, report, child))
  );
}

function drainMergeChild(
  git: DrainMergeGitClient,
  branch: string
): Effect.Effect<string, unknown> {
  return git.raw([
    "merge",
    "--no-ff",
    "--no-edit",
    "-m",
    "drain-merge: merge",
    branch,
  ]);
}

function recordDrainMergeSuccess(
  report: DrainMergeReport,
  child: {
    nodeId: string;
    output: DrainMergeChildOutput & {
      baseSha: string;
      branch: string;
      worktreePath: string;
    };
  }
): void {
  report.merged.push({
    branch: child.output.branch,
    id: child.nodeId,
    worktreePath: child.output.worktreePath,
  });
}

function recordDrainMergeConflict(
  git: DrainMergeGitClient,
  report: DrainMergeReport,
  child: {
    nodeId: string;
    output: DrainMergeChildOutput & {
      baseSha: string;
      branch: string;
      worktreePath: string;
    };
  }
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const files = yield* drainMergeConflictFiles(git);
    report.conflicts.push({
      branch: child.output.branch,
      files,
      id: child.nodeId,
      worktreePath: child.output.worktreePath,
    });
    yield* abortDrainMerge(git);
  });
}

function drainMergeConflictFiles(
  git: DrainMergeGitClient
): Effect.Effect<string[], never> {
  return git.raw(["diff", "--name-only", "--diff-filter=U"]).pipe(
    Effect.map((output) => output.split(LINE_RE).filter(Boolean)),
    Effect.catchAll(() => Effect.succeed([]))
  );
}

function abortDrainMerge(git: DrainMergeGitClient): Effect.Effect<void, never> {
  return git.raw(["merge", "--abort"]).pipe(
    Effect.catchAll(() => Effect.void),
    Effect.asVoid
  );
}

function parseDrainMergeChildOutput(
  value: unknown
): DrainMergeChildOutput | null {
  const output = parseJsonObject(value);
  if (Object.keys(output).length === 0) {
    return null;
  }
  return {
    baseSha: stringFieldOrNull(output.baseSha),
    branch: stringFieldOrNull(output.branch),
    status: drainMergeStatus(output.status),
    worktreePath: stringFieldOrNull(output.worktreePath),
  };
}

function stringFieldOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function drainMergeStatus(value: unknown): DrainMergeStatus {
  return value === "PASS" ? "PASS" : "FAIL";
}

function drainMergeResult(
  report: DrainMergeReport,
  options: { evidence?: string[]; failed?: boolean } = {}
): NodeAttemptResult {
  const hasFailure = hasDrainMergeFailure(report, options.failed);
  return {
    evidence: drainMergeEvidence(report, options.evidence, hasFailure),
    exitCode: drainMergeExitCode(hasFailure),
    output: JSON.stringify(report),
  };
}

function hasDrainMergeFailure(
  report: DrainMergeReport,
  failed?: boolean
): boolean {
  return report.conflicts.length > 0 || failed === true;
}

function drainMergeEvidence(
  report: DrainMergeReport,
  evidence: string[] | undefined,
  hasFailure: boolean
): string[] {
  return [...(evidence ?? []), drainMergeSummary(report, hasFailure)];
}

function drainMergeSummary(
  report: DrainMergeReport,
  hasFailure: boolean
): string {
  return hasFailure
    ? `drain-merge completed with ${report.conflicts.length} conflicts`
    : `drain-merge merged ${report.merged.length} branches`;
}

function drainMergeExitCode(hasFailure: boolean): 0 | 1 {
  return hasFailure ? 1 : 0;
}

function drainMergeSetupErrorResult(
  report: DrainMergeReport,
  error: unknown
): NodeAttemptResult {
  return drainMergeResult(report, {
    evidence: [`drain-merge setup-error: ${errorMessage(error)}`],
    failed: true,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
