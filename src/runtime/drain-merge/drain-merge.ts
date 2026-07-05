import { Effect } from "effect";
import {
  fromUndefinedOr,
  getOrNull,
  getOrUndefined,
  isNone,
  isSome,
  none,
  some,
} from "effect/Option";
import type { Option } from "effect/Option";

import type { PlannedWorkflowNode } from "../../planning/compile";
import { generateRuntimeRunId } from "../context";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { parseJsonObject } from "../json-validation";
import {
  DrainMergeGitService,
  DrainMergeGitServiceLive,
} from "../services/drain-merge-git-service";
import type { DrainMergeGitClient } from "../services/drain-merge-git-service";

const LINE_RE = /\r?\n/u;

type DrainMergeStatus = "FAIL" | "PASS";

interface DrainMergeChildOutput {
  baseSha: Option<string>;
  branch: Option<string>;
  status: DrainMergeStatus;
  worktreePath: Option<string>;
}

interface DrainMergeWorktreeOutput {
  baseSha: string;
  branch: string;
  status: DrainMergeStatus;
  worktreePath: string;
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
  baseSha: Option<string>;
  conflicts: DrainMergeConflictEntry[];
  integrationBranch: string;
  merged: DrainMergeMergeEntry[];
  skipped: DrainMergeSkipEntry[];
}

const firstNeededNode = (node?: PlannedWorkflowNode): Option<string> =>
  fromUndefinedOr(node?.needs.at(0));

const runIdForDrainMerge = (context: RuntimeContext): string =>
  context.runId ?? generateRuntimeRunId();

const drainMergeWorktreeOutput = (
  output: DrainMergeChildOutput
): Option<DrainMergeWorktreeOutput> => {
  const baseSha = getOrUndefined(output.baseSha);
  const branch = getOrUndefined(output.branch);
  const worktreePath = getOrUndefined(output.worktreePath);
  if (
    baseSha === undefined ||
    branch === undefined ||
    worktreePath === undefined
  ) {
    return none();
  }
  return some({
    baseSha,
    branch,
    status: output.status,
    worktreePath,
  });
};

const drainMergeMergeableChildren = (
  children: { nodeId: string; output: DrainMergeChildOutput }[],
  report: DrainMergeReport
): {
  nodeId: string;
  output: DrainMergeWorktreeOutput;
}[] =>
  children.flatMap((child) => {
    if (child.output.status !== "PASS") {
      report.skipped.push({
        id: child.nodeId,
        reason: "failed",
        status: child.output.status,
      });
      return [];
    }
    const output = drainMergeWorktreeOutput(child.output);
    if (isNone(output)) {
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
        output: output.value,
      },
    ];
  });

const divergentDrainMergeChild = (
  mergeable: {
    nodeId: string;
    output: DrainMergeWorktreeOutput;
  }[],
  baseSha: string
) => mergeable.find((child) => child.output.baseSha !== baseSha);

const checkoutDrainMergeIntegrationBranch = (
  git: DrainMergeGitClient,
  integrationBranch: string,
  baseSha: string
): Effect.Effect<void, unknown> =>
  git.raw(["rev-parse", "--verify", integrationBranch]).pipe(
    Effect.flatMap(() => git.raw(["checkout", integrationBranch])),
    Effect.catch(() => git.raw(["checkout", "-b", integrationBranch, baseSha])),
    Effect.asVoid
  );

const drainMergeChild = (
  git: DrainMergeGitClient,
  branch: string
): Effect.Effect<string, unknown> =>
  git.raw([
    "merge",
    "--no-ff",
    "--no-edit",
    "-m",
    "drain-merge: merge",
    branch,
  ]);

const recordDrainMergeSuccess = (
  report: DrainMergeReport,
  child: {
    nodeId: string;
    output: DrainMergeWorktreeOutput;
  }
): void => {
  report.merged.push({
    branch: child.output.branch,
    id: child.nodeId,
    worktreePath: child.output.worktreePath,
  });
};

const drainMergeConflictFiles = (
  git: DrainMergeGitClient
): Effect.Effect<string[]> =>
  git.raw(["diff", "--name-only", "--diff-filter=U"]).pipe(
    Effect.map((output) => output.split(LINE_RE).filter(Boolean)),
    Effect.catch(() => Effect.succeed([]))
  );

const abortDrainMerge = (git: DrainMergeGitClient): Effect.Effect<void> =>
  git.raw(["merge", "--abort"]).pipe(
    Effect.catch(() => Effect.void),
    Effect.asVoid
  );

const recordDrainMergeConflict = (
  git: DrainMergeGitClient,
  report: DrainMergeReport,
  child: {
    nodeId: string;
    output: DrainMergeWorktreeOutput;
  }
): Effect.Effect<void> =>
  Effect.gen(function* effectBody() {
    const files = yield* drainMergeConflictFiles(git);
    report.conflicts.push({
      branch: child.output.branch,
      files,
      id: child.nodeId,
      worktreePath: child.output.worktreePath,
    });
    yield* abortDrainMerge(git);
  });

const mergeDrainMergeChild = (
  git: DrainMergeGitClient,
  report: DrainMergeReport,
  child: {
    nodeId: string;
    output: DrainMergeWorktreeOutput;
  }
): Effect.Effect<void> =>
  drainMergeChild(git, child.output.branch).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        recordDrainMergeSuccess(report, child);
      })
    ),
    Effect.catch(() => recordDrainMergeConflict(git, report, child))
  );

const stringFieldOption = (value: unknown): Option<string> =>
  typeof value === "string" ? some(value) : none();

const drainMergeStatus = (value: unknown): DrainMergeStatus =>
  value === "PASS" ? "PASS" : "FAIL";

const parseDrainMergeChildOutput = (
  value: unknown
): Option<DrainMergeChildOutput> => {
  const output = parseJsonObject(value);
  if (Object.keys(output).length === 0) {
    return none();
  }
  return some({
    baseSha: stringFieldOption(output.baseSha),
    branch: stringFieldOption(output.branch),
    status: drainMergeStatus(output.status),
    worktreePath: stringFieldOption(output.worktreePath),
  });
};

const drainMergeChildren = (
  context: RuntimeContext,
  upstreamNodeId: Option<string>
): { nodeId: string; output: DrainMergeChildOutput }[] => {
  if (isNone(upstreamNodeId)) {
    return [];
  }
  if (!context.plan.graph.hasNode(upstreamNodeId.value)) {
    return [];
  }
  const upstream = context.plan.graph.node(upstreamNodeId.value);
  const output = parseJsonObject(
    fromUndefinedOr(
      context.nodeStateStore.lastOutputByNode.get(upstreamNodeId.value)
    )
  );
  const childrenOutput = parseJsonObject(output.children);
  return (upstream.children ?? []).flatMap((child) => {
    const childOutput = parseDrainMergeChildOutput(childrenOutput[child.id]);
    return isSome(childOutput)
      ? [{ nodeId: child.id, output: childOutput.value }]
      : [];
  });
};

const hasDrainMergeFailure = (
  report: DrainMergeReport,
  failed?: boolean
): boolean => report.conflicts.length > 0 || failed === true;

const drainMergeSummary = (
  report: DrainMergeReport,
  hasFailure: boolean
): string =>
  hasFailure
    ? `drain-merge completed with ${report.conflicts.length} conflicts`
    : `drain-merge merged ${report.merged.length} branches`;

const drainMergeEvidence = (
  report: DrainMergeReport,
  hasFailure: boolean,
  evidence?: string[]
): string[] => [...(evidence ?? []), drainMergeSummary(report, hasFailure)];

const drainMergeExitCode = (hasFailure: boolean): 0 | 1 => (hasFailure ? 1 : 0);

const drainMergeResult = (
  report: DrainMergeReport,
  options: { evidence?: string[]; failed?: boolean } = {}
): NodeAttemptResult => {
  const hasFailure = hasDrainMergeFailure(report, options.failed);
  return {
    evidence: drainMergeEvidence(report, hasFailure, options.evidence),
    exitCode: drainMergeExitCode(hasFailure),
    output: JSON.stringify({
      ...report,
      baseSha: getOrNull(report.baseSha),
    }),
  };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const drainMergeSetupErrorResult = (
  report: DrainMergeReport,
  error: unknown
): NodeAttemptResult =>
  drainMergeResult(report, {
    evidence: [`drain-merge setup-error: ${errorMessage(error)}`],
    failed: true,
  });

const drainMergeProgram = (
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Effect.Effect<NodeAttemptResult, never, DrainMergeGitService> => {
  const upstreamNodeId = firstNeededNode(node);
  const integrationBranch = `runs/integration/${runIdForDrainMerge(context)}`;
  const report: DrainMergeReport = {
    baseSha: none(),
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

  const { baseSha } = mergeable[0].output;
  report.baseSha = some(baseSha);
  const divergent = divergentDrainMergeChild(mergeable, baseSha);
  if (divergent) {
    return Effect.succeed(
      drainMergeResult(report, {
        evidence: [
          `drain-merge child '${divergent.nodeId}' baseSha ${divergent.output.baseSha} diverges from ${baseSha}`,
        ],
        failed: true,
      })
    );
  }

  return Effect.gen(function* effectBody() {
    const gitService = yield* DrainMergeGitService;
    const git = yield* gitService.create(context.worktreePath);
    const setup = checkoutDrainMergeIntegrationBranch(
      git,
      integrationBranch,
      baseSha
    );
    const setupResult = yield* Effect.result(setup);
    if (setupResult._tag === "Failure") {
      return drainMergeSetupErrorResult(report, setupResult.failure);
    }
    yield* Effect.forEach(
      mergeable,
      (child) => mergeDrainMergeChild(git, report, child),
      { concurrency: 1, discard: true }
    );
    return drainMergeResult(report);
  });
};

export const executeDrainMergeBuiltin = async (
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Promise<NodeAttemptResult> =>
  await Effect.runPromise(
    Effect.provide(drainMergeProgram(context, node), DrainMergeGitServiceLive)
  );
