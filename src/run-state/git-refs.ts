import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { PipelineConfig } from "../config";
import type { RunnerCommandPayload } from "../runner-command-contract";

const DEFAULT_WORKSPACE_PATH = "/workspace";
const DEFAULT_GIT_CREDENTIAL_STORE = "/root/.git-credentials";
const WRITABLE_GIT_CREDENTIAL_STORE = resolve(
  tmpdir(),
  "pipeline-git-credentials"
);
const execGit = promisify(execFile);

let preparedCredentialStore: string | undefined;

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
  await runGit(dirname(worktreePath), [
    "clone",
    "--no-tags",
    payload.repository.url,
    worktreePath,
  ]);
  await runGit(worktreePath, [
    "checkout",
    payload.repository.sha ?? `origin/${payload.repository.baseBranch}`,
  ]);
  return worktreePath;
}

export async function mergeDependencyRefs(input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  dependencyNodeIds: string[];
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Promise<void> {
  await configureGitCommitter(input.worktreePath, input.committer);
  for (const nodeId of input.dependencyNodeIds) {
    const ref = runnerGitRefs(input.payload, nodeId).nodeRef;
    await runGit(input.worktreePath, ["fetch", "origin", ref]);
    await runGit(input.worktreePath, [
      "merge",
      "--no-ff",
      "--no-edit",
      "FETCH_HEAD",
    ]);
  }
}

export async function commitAndPushNodeRef(input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  nodeId: string;
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Promise<string> {
  await commitChangesIfNeeded(
    input.worktreePath,
    input.nodeId,
    input.committer
  );
  const sha = (await runGit(input.worktreePath, ["rev-parse", "HEAD"])).trim();
  await runGit(input.worktreePath, [
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
    committer: input.committer,
    dependencyNodeIds: input.sourceNodeIds,
    payload: input.payload,
    worktreePath: input.worktreePath,
  });
  await commitChangesIfNeeded(input.worktreePath, "final", input.committer);
  const sha = (await runGit(input.worktreePath, ["rev-parse", "HEAD"])).trim();
  await runGit(input.worktreePath, [
    "push",
    "origin",
    `HEAD:${runnerGitRefs(input.payload, "final").finalRef}`,
  ]);
  return sha;
}

async function commitChangesIfNeeded(
  worktreePath: string,
  nodeId: string,
  committer: PipelineConfig["runner_command"]["git"]["committer"]
): Promise<void> {
  const status = await runGit(worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (status.trim().length === 0) {
    return;
  }
  await runGit(worktreePath, ["add", "--all"]);
  await configureGitCommitter(worktreePath, committer);
  await runGit(worktreePath, ["commit", "-m", `pipeline: ${nodeId}`]);
}

async function configureGitCommitter(
  worktreePath: string,
  committer: PipelineConfig["runner_command"]["git"]["committer"]
): Promise<void> {
  await runGit(worktreePath, [
    "config",
    "--local",
    "user.name",
    committer.name,
  ]);
  await runGit(worktreePath, [
    "config",
    "--local",
    "user.email",
    committer.email,
  ]);
}

function runnerGitCommandArgs(args: string[]): string[] {
  return [...gitCredentialConfigArgs(), ...args];
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execGit("git", runnerGitCommandArgs(args), {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

function gitCredentialConfigArgs(): string[] {
  const writablePath = prepareWritableGitCredentialStore();
  if (!writablePath) {
    return [];
  }
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=store --file=${writablePath}`,
  ];
}

function prepareWritableGitCredentialStore(): string | undefined {
  const sourcePath = availableGitCredentialStore();
  if (!sourcePath) {
    return;
  }
  const writablePath = writableGitCredentialStore();
  copyGitCredentialStore(sourcePath, writablePath);
  return writablePath;
}

function availableGitCredentialStore(): string | undefined {
  const sourcePath =
    process.env.PIPELINE_GIT_CREDENTIAL_STORE ?? DEFAULT_GIT_CREDENTIAL_STORE;
  return existsSync(sourcePath) ? sourcePath : undefined;
}

function writableGitCredentialStore(): string {
  return (
    process.env.PIPELINE_WRITABLE_GIT_CREDENTIAL_STORE ??
    WRITABLE_GIT_CREDENTIAL_STORE
  );
}

function copyGitCredentialStore(
  sourcePath: string,
  writablePath: string
): void {
  if (preparedCredentialStore === writablePath) {
    return;
  }
  mkdirSync(dirname(writablePath), { recursive: true });
  copyFileSync(sourcePath, writablePath);
  chmodSync(writablePath, 0o600);
  preparedCredentialStore = writablePath;
}
