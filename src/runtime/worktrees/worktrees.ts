import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import simpleGit from "simple-git";
import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../workflow-planner";
import {
  generateRuntimeRunId,
  NODE_ID_TOKEN_RE,
  RUN_ID_TOKEN_RE,
} from "../context";
import type { RuntimeContext } from "../contracts";

export interface WorkflowNodeWorktree {
  baseSha: string | null;
  branch: string | null;
  commitSha?: string | null;
  worktreePath: string | null;
}

export async function prepareWorkflowNodeWorktree(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): Promise<WorkflowNodeWorktree> {
  if (!node.worktreeRoot) {
    return { baseSha: null, branch: null, worktreePath: null };
  }

  const baseSha = await workflowBaseSha(context);
  const branch = `${context.runId ?? generateRuntimeRunId()}/${node.id}`;
  const worktreePath = resolveWorkflowNodeWorktreePath(node, context);
  mkdirSync(dirname(worktreePath), { recursive: true });
  await simpleGit({ baseDir: context.worktreePath }).raw([
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    baseSha,
  ]);
  ensurePipelineSymlink(context.worktreePath, worktreePath);
  return { baseSha, branch, worktreePath };
}

export function workflowBaseSha(context: RuntimeContext): Promise<string> {
  context.baseSha ??= simpleGit({ baseDir: context.worktreePath }).revparse([
    "HEAD",
  ]);
  return context.baseSha;
}

export function resolveWorkflowNodeWorktreePath(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): string {
  const rendered = (node.worktreeRoot ?? "")
    .replaceAll(RUN_ID_TOKEN_RE, context.runId ?? generateRuntimeRunId())
    .replaceAll(NODE_ID_TOKEN_RE, node.id);
  return resolve(context.worktreePath, rendered);
}

export function ensurePipelineSymlink(
  parentWorktreePath: string,
  childWorktreePath: string
): void {
  if (!existsSync(childWorktreePath)) {
    return;
  }
  const source = join(parentWorktreePath, ".pipeline");
  const target = join(childWorktreePath, ".pipeline");
  if (existsSync(source) && !existsSync(target)) {
    symlinkSync(source, target, "dir");
  }
}

export async function removeWorkflowNodeWorktree(
  worktreePath: string
): Promise<void> {
  await simpleGit().raw(["worktree", "remove", "--force", worktreePath]);
}

export async function commitWorkflowNodeWorktree(
  worktreePath: string,
  nodeId: string,
  committer: PipelineConfig["runner_job"]["git"]["committer"]
): Promise<string | null> {
  const git = simpleGit({ baseDir: worktreePath });
  const status = await git.status();
  if (status.files.length === 0) {
    return null;
  }
  await git.add(["--all"]);
  await git.addConfig("user.name", committer.name, false, "local");
  await git.addConfig("user.email", committer.email, false, "local");
  await git.commit(`pipeline: ${nodeId}`);
  const remainingStatus = await git.status();
  if (remainingStatus.files.length > 0) {
    throw new Error(
      `workflow node '${nodeId}' has uncommitted changes after commit`
    );
  }
  return (await git.revparse(["HEAD"])).trim();
}
