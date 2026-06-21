import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import type { PipelineConfig } from "../config";
import type { RunnerCommandPayload } from "../runner-command-contract";
import {
  GitPorcelainService,
  GitPorcelainServiceLive,
} from "../runtime/services/git-porcelain-service";

const DEFAULT_WORKSPACE_PATH = "/workspace";
const DEFAULT_GIT_CREDENTIALS_DIR = "/etc/pipeline/git-credentials";
const WRITABLE_GIT_CREDENTIAL_STORE = resolve(
  tmpdir(),
  "pipeline-git-credentials"
);
const SCP_LIKE_SSH_REMOTE_RE = /^[^@\s]+@[^:\s]+:.+/u;

let preparedBasicAuthCredentialStore:
  | { host: string; path: string }
  | undefined;

interface RunnerGitRefs {
  finalRef: string;
  nodeRef: string;
  prefix: string;
}

export interface PrepareRunnerGitWorkspaceOptions {
  cwd?: string;
  workspacePath?: string;
}

function runnerGitRefs(
  payload: RunnerCommandPayload,
  nodeId: string
): RunnerGitRefs {
  /*
   * Runner semantic state is carried by git refs under
   * refs/heads/pipeline/runs/<run>/<workflow>/nodes/<node>, not by Argo
   * artifacts. Argo artifacts pass files between tasks, but they do not provide
   * merged git history; dependency pre-fetch merges these git refs before a
   * dependent node runs so state passing follows the workflow graph.
   */
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
  return await Effect.runPromise(
    Effect.provide(
      prepareRunnerGitWorkspaceEffect(payload, options),
      GitPorcelainServiceLive
    )
  );
}

function prepareRunnerGitWorkspaceEffect(
  payload: RunnerCommandPayload,
  options: PrepareRunnerGitWorkspaceOptions
): Effect.Effect<string, unknown, GitPorcelainService> {
  return Effect.gen(function* () {
    if (options.cwd) {
      return resolve(options.cwd);
    }
    const worktreePath = options.workspacePath ?? DEFAULT_WORKSPACE_PATH;
    yield* Effect.sync(() =>
      mkdirSync(dirname(worktreePath), { recursive: true })
    );
    yield* runGit(dirname(worktreePath), [
      "clone",
      "--no-tags",
      payload.repository.url,
      worktreePath,
    ]);
    yield* runGit(worktreePath, [
      "checkout",
      payload.repository.sha ?? `origin/${payload.repository.baseBranch}`,
    ]);
    return worktreePath;
  });
}

export async function mergeDependencyRefs(input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  dependencyNodeIds: string[];
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Promise<void> {
  return await Effect.runPromise(
    Effect.provide(mergeDependencyRefsEffect(input), GitPorcelainServiceLive)
  );
}

function mergeDependencyRefsEffect(input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  dependencyNodeIds: string[];
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Effect.Effect<void, unknown, GitPorcelainService> {
  return Effect.gen(function* () {
    yield* configureGitCommitter(input.worktreePath, input.committer);
    yield* Effect.forEach(input.dependencyNodeIds, (nodeId) =>
      mergeDependencyRef(
        input.worktreePath,
        runnerGitRefs(input.payload, nodeId).nodeRef
      )
    );
  });
}

function mergeDependencyRef(
  worktreePath: string,
  ref: string
): Effect.Effect<void, unknown, GitPorcelainService> {
  return Effect.gen(function* () {
    yield* runGit(worktreePath, ["fetch", "origin", ref]);
    yield* runGit(worktreePath, [
      "merge",
      "--no-ff",
      "--no-edit",
      "FETCH_HEAD",
    ]);
  });
}

export async function commitAndPushNodeRef(input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  nodeId: string;
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Promise<string> {
  return await Effect.runPromise(
    Effect.provide(commitAndPushNodeRefEffect(input), GitPorcelainServiceLive)
  );
}

function commitAndPushNodeRefEffect(input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  nodeId: string;
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Effect.Effect<string, unknown, GitPorcelainService> {
  return Effect.gen(function* () {
    yield* commitChangesIfNeeded(
      input.worktreePath,
      input.nodeId,
      input.committer
    );
    const sha = yield* headSha(input.worktreePath);
    yield* runGit(input.worktreePath, [
      "push",
      "origin",
      `HEAD:${runnerGitRefs(input.payload, input.nodeId).nodeRef}`,
    ]);
    return sha;
  });
}

/**
 * Run a single git command through the runner's authenticated path: per-command
 * credential-helper store (basic-auth from the mounted git-credentials) plus
 * GIT_TERMINAL_PROMPT=0 so a missing credential fails fast instead of blocking
 * forever on an interactive username prompt. This is the ONE git-auth primitive;
 * every runner git operation (node delivery, dependency merge, open-pull-request)
 * must route through it rather than spawning naked git.
 */
export async function runAuthenticatedGit(
  cwd: string,
  args: string[]
): Promise<string> {
  return await Effect.runPromise(
    Effect.provide(runGit(cwd, args), GitPorcelainServiceLive)
  );
}

export async function promoteFinalRef(input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  payload: RunnerCommandPayload;
  sourceNodeIds: string[];
  worktreePath: string;
}): Promise<string> {
  return await Effect.runPromise(
    Effect.provide(promoteFinalRefEffect(input), GitPorcelainServiceLive)
  );
}

function promoteFinalRefEffect(input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  payload: RunnerCommandPayload;
  sourceNodeIds: string[];
  worktreePath: string;
}): Effect.Effect<string, unknown, GitPorcelainService> {
  return Effect.gen(function* () {
    yield* mergeDependencyRefsEffect({
      committer: input.committer,
      dependencyNodeIds: input.sourceNodeIds,
      payload: input.payload,
      worktreePath: input.worktreePath,
    });
    yield* commitChangesIfNeeded(input.worktreePath, "final", input.committer);
    const sha = yield* headSha(input.worktreePath);
    yield* runGit(input.worktreePath, [
      "push",
      "origin",
      `HEAD:${runnerGitRefs(input.payload, "final").finalRef}`,
    ]);
    return sha;
  });
}

function headSha(
  worktreePath: string
): Effect.Effect<string, unknown, GitPorcelainService> {
  return Effect.map(runGit(worktreePath, ["rev-parse", "HEAD"]), (sha) =>
    sha.trim()
  );
}

/*
 * Checkpoint commits are plumbing (one per node, plus the promoted final), but
 * they land on the branch a target repo's commit-msg hook validates. jalgpall-web
 * (and many repos) enforce Conventional Commits, which rejects a bare
 * `pipeline: <node>` subject. Emit a Conventional-Commits-valid message —
 * `chore` is the honest type for a mechanical pipeline checkpoint — so the hook
 * passes without bypassing it (--no-verify is never used).
 */
export function runnerCommitMessage(nodeId: string): string {
  return `chore(pipeline): ${nodeId}`;
}

function commitChangesIfNeeded(
  worktreePath: string,
  nodeId: string,
  committer: PipelineConfig["runner_command"]["git"]["committer"]
): Effect.Effect<void, unknown, GitPorcelainService> {
  return Effect.gen(function* () {
    const status = yield* runGit(worktreePath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (status.trim().length === 0) {
      return;
    }
    yield* runGit(worktreePath, ["add", "--all"]);
    yield* configureGitCommitter(worktreePath, committer);
    yield* runGit(worktreePath, ["commit", "-m", runnerCommitMessage(nodeId)]);
  });
}

function configureGitCommitter(
  worktreePath: string,
  committer: PipelineConfig["runner_command"]["git"]["committer"]
): Effect.Effect<void, unknown, GitPorcelainService> {
  return Effect.gen(function* () {
    yield* runGit(worktreePath, [
      "config",
      "--local",
      "user.name",
      committer.name,
    ]);
    yield* runGit(worktreePath, [
      "config",
      "--local",
      "user.email",
      committer.email,
    ]);
  });
}

function runnerGitCommandArgs(
  args: string[],
  remoteUrl: string | undefined
): string[] {
  return [...gitCredentialConfigArgs(remoteUrl), ...args];
}

function runGit(
  cwd: string,
  args: string[]
): Effect.Effect<string, unknown, GitPorcelainService> {
  return Effect.gen(function* () {
    const remoteUrl = yield* remoteUrlFromGitArgs(cwd, args);
    yield* Effect.try({
      try: () => assertSshCredentialsAvailable(remoteUrl),
      catch: (error) => error,
    });
    const git = yield* GitPorcelainService;
    const commandArgs = runnerGitCommandArgs(args, remoteUrl);
    return yield* git.run(cwd, commandArgs, runnerGitEnv(remoteUrl));
  });
}

function assertSshCredentialsAvailable(remoteUrl: string | undefined): void {
  if (!(remoteUrl && isSshRemote(remoteUrl))) {
    return;
  }
  const credentialsDir = gitCredentialsDir();
  const missing = [
    ["identity", resolve(credentialsDir, "identity")],
    ["known_hosts", resolve(credentialsDir, "known_hosts")],
  ]
    .filter(([, filePath]) => !existsSync(filePath))
    .map(([name]) => name);
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `SSH git remote ${remoteUrl} requires mounted git credential file(s): ${missing.join(", ")}`
  );
}

function gitCredentialConfigArgs(remoteUrl: string | undefined): string[] {
  const writablePath = prepareWritableGitCredentialStore(remoteUrl);
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

function prepareWritableGitCredentialStore(
  remoteUrl: string | undefined
): string | undefined {
  if (!remoteUrl) {
    return existingPreparedBasicAuthCredentialStore(
      writableGitCredentialStore()
    );
  }
  if (!isHttpRemote(remoteUrl)) {
    return;
  }
  const writablePath = writableGitCredentialStore();
  const basicAuth = availableBasicAuthCredentials();
  if (basicAuth) {
    return prepareBasicAuthCredentialStore(basicAuth, writablePath, remoteUrl);
  }
  return;
}

function availableBasicAuthCredentials():
  | { password: string; username: string }
  | undefined {
  const credentialsDir = gitCredentialsDir();
  const usernamePath = resolve(credentialsDir, "username");
  const passwordPath = resolve(credentialsDir, "password");
  if (!(existsSync(usernamePath) && existsSync(passwordPath))) {
    return;
  }
  return {
    password: readCredentialFile(passwordPath),
    username: readCredentialFile(usernamePath),
  };
}

function gitCredentialsDir(): string {
  return (
    process.env.PIPELINE_GIT_CREDENTIALS_DIR ?? DEFAULT_GIT_CREDENTIALS_DIR
  );
}

function writableGitCredentialStore(): string {
  return (
    process.env.PIPELINE_WRITABLE_GIT_CREDENTIAL_STORE ??
    WRITABLE_GIT_CREDENTIAL_STORE
  );
}

function writeGitCredentialStore(
  credentials: { password: string; username: string },
  writablePath: string,
  host: string
): void {
  mkdirSync(dirname(writablePath), { recursive: true });
  writeFileSync(
    writablePath,
    `https://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${host}\n`,
    { mode: 0o600 }
  );
  chmodSync(writablePath, 0o600);
}

function prepareBasicAuthCredentialStore(
  credentials: { password: string; username: string },
  writablePath: string,
  remoteUrl: string | undefined
): string | undefined {
  const host = remoteUrl ? credentialHost(remoteUrl) : undefined;
  if (!host) {
    return existingPreparedBasicAuthCredentialStore(writablePath);
  }
  if (isPreparedBasicAuthCredentialStore(writablePath, host)) {
    return writablePath;
  }
  writeGitCredentialStore(credentials, writablePath, host);
  preparedBasicAuthCredentialStore = { host, path: writablePath };
  return writablePath;
}

function existingPreparedBasicAuthCredentialStore(
  writablePath: string
): string | undefined {
  return preparedBasicAuthCredentialStore?.path === writablePath
    ? writablePath
    : undefined;
}

function isPreparedBasicAuthCredentialStore(
  writablePath: string,
  host: string
): boolean {
  return (
    preparedBasicAuthCredentialStore?.path === writablePath &&
    preparedBasicAuthCredentialStore.host === host
  );
}

function runnerGitEnv(remoteUrl: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const sshCommand = gitSshCommand();
  if (sshCommand && remoteUrl && isSshRemote(remoteUrl)) {
    env.GIT_SSH_COMMAND = sshCommand;
  }
  return env;
}

function gitSshCommand(): string | undefined {
  const credentialsDir = gitCredentialsDir();
  const identityPath = resolve(credentialsDir, "identity");
  const knownHostsPath = resolve(credentialsDir, "known_hosts");
  if (!(existsSync(identityPath) && existsSync(knownHostsPath))) {
    return;
  }
  ensureSshIdentityPermissions(identityPath);
  return [
    "ssh",
    "-i",
    shellQuote(identityPath),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
    "-o",
    "StrictHostKeyChecking=yes",
  ].join(" ");
}

function ensureSshIdentityPermissions(identityPath: string): void {
  try {
    chmodSync(identityPath, 0o400);
    return;
  } catch (error) {
    if (!(isReadOnlyFileSystemError(error) && isOwnerReadOnly(identityPath))) {
      throw error;
    }
  }
}

function isReadOnlyFileSystemError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EROFS"
  );
}

function isOwnerReadOnly(path: string): boolean {
  const permissions = statSync(path).mode.toString(8).slice(-3);
  return (
    ["4", "5", "6", "7"].includes(permissions[0] ?? "") &&
    permissions.slice(1) === "00"
  );
}

function readCredentialFile(path: string): string {
  return readFileSync(path, "utf8").trim();
}

function remoteUrlFromGitArgs(
  cwd: string,
  args: string[]
): Effect.Effect<string | undefined, unknown, GitPorcelainService> {
  return Effect.gen(function* () {
    const literalRemoteUrl = literalRemoteUrlFromGitArgs(args);
    if (literalRemoteUrl) {
      return literalRemoteUrl;
    }
    const remoteName = remoteNameFromGitArgs(args);
    return yield* remoteUrlForName(cwd, remoteName);
  });
}

function remoteUrlForName(
  cwd: string,
  remoteName: string | undefined
): Effect.Effect<string | undefined, unknown, GitPorcelainService> {
  return remoteName ? gitRemoteUrl(cwd, remoteName) : Effect.succeed(undefined);
}

function literalRemoteUrlFromGitArgs(args: string[]): string | undefined {
  if (args[0] === "clone") {
    return args.find((arg) => isRemoteUrl(arg));
  }
  if (args[0] === "fetch" || args[0] === "push" || args[0] === "ls-remote") {
    const remoteArg = args[1];
    return remoteArg && isRemoteUrl(remoteArg) ? remoteArg : undefined;
  }
  return;
}

function remoteNameFromGitArgs(args: string[]): string | undefined {
  if (args[0] === "fetch" || args[0] === "push" || args[0] === "ls-remote") {
    const remoteArg = args[1];
    if (remoteArg && !remoteArg.startsWith("-") && !isRemoteUrl(remoteArg)) {
      return remoteArg;
    }
  }
  return;
}

function gitRemoteUrl(
  cwd: string,
  remoteName: string
): Effect.Effect<string | undefined, unknown, GitPorcelainService> {
  return Effect.gen(function* () {
    const git = yield* GitPorcelainService;
    const stdout = yield* git.run(cwd, ["remote", "get-url", remoteName], {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    });
    return stdout.trim() || undefined;
  });
}

function isRemoteUrl(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("ssh://") ||
    isScpLikeSshRemote(value)
  );
}

function isSshRemote(value: string): boolean {
  return value.startsWith("ssh://") || isScpLikeSshRemote(value);
}

function isHttpRemote(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function isScpLikeSshRemote(value: string): boolean {
  return SCP_LIKE_SSH_REMOTE_RE.test(value);
}

function credentialHost(remoteUrl: string): string | undefined {
  try {
    return new URL(remoteUrl).host || undefined;
  } catch {
    return;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
