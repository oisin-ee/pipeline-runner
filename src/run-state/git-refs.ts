import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { PipelineConfig } from "../config";
import type { RunnerCommandPayload } from "../runner-command-contract";

const DEFAULT_WORKSPACE_PATH = "/workspace";

export interface RunnerGitRefs {
  finalRef: string;
  nodeRef: string;
  prefix: string;
}

export interface PrepareRunnerGitWorkspaceOptions {
  cwd?: string;
  workspacePath?: string;
}

export function runnerGitRefs(
  payload: RunnerCommandPayload,
  nodeId: string
): RunnerGitRefs {
  const prefix = `refs/heads/pipeline/runs/${payload.run.id}/${payload.workflow.id}`;
  return {
    finalRef: `${prefix}/final`,
    nodeRef: `${prefix}/nodes/${nodeId}`,
    prefix,
  };
}

export async function prepareRunnerGitWorkspace(
  payload: RunnerCommandPayload,
  options: PrepareRunnerGitWorkspaceOptions = {}
): Promise<string> {
  if (options.cwd) {
    return resolve(options.cwd);
  }
  const worktreePath = options.workspacePath ?? DEFAULT_WORKSPACE_PATH;
  mkdirSync(dirname(worktreePath), { recursive: true });
  await simpleGit().clone(payload.repository.url, worktreePath, ["--no-tags"]);
  const git = simpleGit({ baseDir: worktreePath });
  await git.checkout(
    payload.repository.sha ?? `origin/${payload.repository.baseBranch}`
  );
  return worktreePath;
}

export async function mergeDependencyRefs(input: {
  dependencyNodeIds: string[];
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Promise<void> {
  const git = simpleGit({ baseDir: input.worktreePath });
  for (const nodeId of input.dependencyNodeIds) {
    const ref = runnerGitRefs(input.payload, nodeId).nodeRef;
    await git.raw(["fetch", "origin", ref]);
    await git.raw(["merge", "--no-ff", "--no-edit", "FETCH_HEAD"]);
  }
}

export async function commitAndPushNodeRef(input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  nodeId: string;
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Promise<string> {
  const git = simpleGit({ baseDir: input.worktreePath });
  await commitChangesIfNeeded(git, input.nodeId, input.committer);
  const sha = (await git.revparse(["HEAD"])).trim();
  await git.raw([
    "push",
    "origin",
    `HEAD:${runnerGitRefs(input.payload, input.nodeId).nodeRef}`,
  ]);
  return sha;
}

export async function promoteFinalRef(input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  payload: RunnerCommandPayload;
  sourceNodeIds: string[];
  worktreePath: string;
}): Promise<string> {
  await mergeDependencyRefs({
    dependencyNodeIds: input.sourceNodeIds,
    payload: input.payload,
    worktreePath: input.worktreePath,
  });
  const git = simpleGit({ baseDir: input.worktreePath });
  await commitChangesIfNeeded(git, "final", input.committer);
  const sha = (await git.revparse(["HEAD"])).trim();
  await git.raw([
    "push",
    "origin",
    `HEAD:${runnerGitRefs(input.payload, "final").finalRef}`,
  ]);
  return sha;
}

async function commitChangesIfNeeded(
  git: SimpleGit,
  nodeId: string,
  committer: PipelineConfig["runner_command"]["git"]["committer"]
): Promise<void> {
  const status = await git.status();
  if (status.files.length === 0) {
    return;
  }
  await git.add(["--all"]);
  await git.addConfig("user.name", committer.name, false, "local");
  await git.addConfig("user.email", committer.email, false, "local");
  await git.commit(`pipeline: ${nodeId}`);
}
