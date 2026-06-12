import simpleGit from "simple-git";
import type { PlannedWorkflowNode } from "../../workflow-planner";
import { generateRuntimeRunId } from "../context";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { parseJsonObject } from "../json-validation";

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

export async function executeDrainMergeBuiltin(
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Promise<NodeAttemptResult> {
  const upstreamNodeId = node?.needs.at(0) ?? null;
  const integrationBranch = `runs/integration/${
    context.runId ?? generateRuntimeRunId()
  }`;
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
    return drainMergeResult(report);
  }

  report.baseSha = mergeable[0].output.baseSha;
  const divergent = mergeable.find(
    (child) => child.output.baseSha !== report.baseSha
  );
  if (divergent) {
    return drainMergeResult(report, {
      evidence: [
        `drain-merge child '${divergent.nodeId}' baseSha ${divergent.output.baseSha} diverges from ${report.baseSha}`,
      ],
      failed: true,
    });
  }

  const git = simpleGit({ baseDir: context.worktreePath });
  try {
    await checkoutDrainMergeIntegrationBranch(
      git,
      integrationBranch,
      report.baseSha
    );
  } catch (error) {
    return drainMergeResult(report, {
      evidence: [
        `drain-merge setup-error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      failed: true,
    });
  }

  for (const child of mergeable) {
    try {
      await git.raw([
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        "drain-merge: merge",
        child.output.branch,
      ]);
      report.merged.push({
        branch: child.output.branch,
        id: child.nodeId,
        worktreePath: child.output.worktreePath,
      });
    } catch {
      const files = await drainMergeConflictFiles(git);
      report.conflicts.push({
        branch: child.output.branch,
        files,
        id: child.nodeId,
        worktreePath: child.output.worktreePath,
      });
      await abortDrainMerge(git);
    }
  }

  return drainMergeResult(report);
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
    if (
      !(
        child.output.baseSha &&
        child.output.branch &&
        child.output.worktreePath
      )
    ) {
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

async function checkoutDrainMergeIntegrationBranch(
  git: ReturnType<typeof simpleGit>,
  integrationBranch: string,
  baseSha: string
): Promise<void> {
  try {
    await git.raw(["rev-parse", "--verify", integrationBranch]);
    await git.raw(["checkout", integrationBranch]);
  } catch {
    await git.raw(["checkout", "-b", integrationBranch, baseSha]);
  }
}

async function drainMergeConflictFiles(
  git: ReturnType<typeof simpleGit>
): Promise<string[]> {
  try {
    const output = await git.raw(["diff", "--name-only", "--diff-filter=U"]);
    return output.split(LINE_RE).filter(Boolean);
  } catch {
    return [];
  }
}

async function abortDrainMerge(
  git: ReturnType<typeof simpleGit>
): Promise<void> {
  try {
    await git.raw(["merge", "--abort"]);
  } catch {
    // The merge failure is already captured in the report; abort errors should
    // not prevent later siblings from being attempted.
  }
}

function parseDrainMergeChildOutput(
  value: unknown
): DrainMergeChildOutput | null {
  const output = parseJsonObject(value);
  if (Object.keys(output).length === 0) {
    return null;
  }
  return {
    baseSha: typeof output.baseSha === "string" ? output.baseSha : null,
    branch: typeof output.branch === "string" ? output.branch : null,
    status: output.status === "PASS" ? "PASS" : "FAIL",
    worktreePath:
      typeof output.worktreePath === "string" ? output.worktreePath : null,
  };
}

function drainMergeResult(
  report: DrainMergeReport,
  options: { evidence?: string[]; failed?: boolean } = {}
): NodeAttemptResult {
  const hasFailure = report.conflicts.length > 0 || options.failed === true;
  return {
    evidence: [
      ...(options.evidence ?? []),
      hasFailure
        ? `drain-merge completed with ${report.conflicts.length} conflicts`
        : `drain-merge merged ${report.merged.length} branches`,
    ],
    exitCode: hasFailure ? 1 : 0,
    output: JSON.stringify(report),
  };
}
