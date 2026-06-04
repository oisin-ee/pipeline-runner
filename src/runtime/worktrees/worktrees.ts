import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import simpleGit from "simple-git";
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
