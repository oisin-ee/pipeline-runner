import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { Effect, Option } from "effect";

import type { PipelineConfig } from "../config";
import type { RunnerCommandPayload } from "../runner-command-contract";
import { GitPorcelainService, GitPorcelainServiceLive } from "../runtime/services/git-porcelain-service";
import { isStringValue } from "../safe-json";

const DEFAULT_WORKSPACE_PATH = "/workspace";
const DEFAULT_GIT_CREDENTIALS_DIR = "/etc/pipeline/git-credentials";
const WRITABLE_GIT_CREDENTIAL_STORE = resolve(tmpdir(), "pipeline-git-credentials");
const LS_REMOTE_FIELD_SEPARATOR_RE = /\s+/u;
const SCP_LIKE_SSH_REMOTE_RE = /^[^@\s]+@[^:\s]+:.+/u;
const MISSING_REMOTE_URL: Option.Option<string> = Option.none();

let preparedBasicAuthCredentialStore: Option.Option<{
  host: string;
  path: string;
}> = Option.none();

interface RunnerGitRefs {
  finalRef: string;
  nodeRef: string;
  prefix: string;
}

export interface PrepareRunnerGitWorkspaceOptions {
  cwd?: string;
  workspacePath?: string;
}

const runnerGitRefs = (payload: RunnerCommandPayload, nodeId: string): RunnerGitRefs => {
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
};

const parseLsRemoteSha = (stdout: string): Option.Option<string> => {
  const [firstLine = ""] = stdout.trim().split("\n");
  if (firstLine.length === 0) {
    return Option.none();
  }
  const [sha = ""] = firstLine.split(LS_REMOTE_FIELD_SEPARATOR_RE);
  return Option.some(sha);
};

/*
 * Checkpoint commits are plumbing (one per node, plus the promoted final), but
 * they land on the branch a target repo's commit-msg hook validates. jalgpall-web
 * (and many repos) enforce Conventional Commits, which rejects a bare
 * `pipeline: <node>` subject. Emit a Conventional-Commits-valid message —
 * `chore` is the honest type for a mechanical pipeline checkpoint — so the hook
 * passes without bypassing it (--no-verify is never used).
 */
export const runnerCommitMessage = (nodeId: string): string => `chore(pipeline): ${nodeId}`;

const gitCredentialsDir = (): string => process.env.PIPELINE_GIT_CREDENTIALS_DIR ?? DEFAULT_GIT_CREDENTIALS_DIR;

const writableGitCredentialStore = (): string =>
  process.env.PIPELINE_WRITABLE_GIT_CREDENTIAL_STORE ?? WRITABLE_GIT_CREDENTIAL_STORE;

const writeGitCredentialStore = (
  credentials: { password: string; username: string },
  writablePath: string,
  host: string,
): void => {
  mkdirSync(dirname(writablePath), { recursive: true });
  writeFileSync(
    writablePath,
    `https://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${host}\n`,
    { mode: 0o600 },
  );
  chmodSync(writablePath, 0o600);
};

const existingPreparedBasicAuthCredentialStore = (writablePath: string): Option.Option<string> =>
  Option.isSome(preparedBasicAuthCredentialStore) && preparedBasicAuthCredentialStore.value.path === writablePath
    ? Option.some(writablePath)
    : Option.none();

const isPreparedBasicAuthCredentialStore = (writablePath: string, host: string): boolean =>
  Option.isSome(preparedBasicAuthCredentialStore) &&
  preparedBasicAuthCredentialStore.value.path === writablePath &&
  preparedBasicAuthCredentialStore.value.host === host;

const errorCode = (error: unknown): Option.Option<string> =>
  error instanceof Error && "code" in error && isStringValue(error.code) ? Option.some(error.code) : Option.none();

const isReadOnlyFileSystemError = (error: unknown): boolean => Option.contains("EROFS")(errorCode(error));

const isOwnerReadOnly = (path: string): boolean => {
  const permissions = statSync(path).mode.toString(8).slice(-3);
  return ["4", "5", "6", "7"].includes(permissions[0]) && permissions.slice(1) === "00";
};

const ensureSshIdentityPermissions = (identityPath: string): void => {
  try {
    chmodSync(identityPath, 0o400);
    return;
  } catch (error) {
    if (!(isReadOnlyFileSystemError(error) && isOwnerReadOnly(identityPath))) {
      throw error;
    }
  }
};

const readCredentialFile = (path: string): string => readFileSync(path, "utf-8").trim();

const availableBasicAuthCredentials = (): Option.Option<{
  password: string;
  username: string;
}> => {
  const credentialsDir = gitCredentialsDir();
  const usernamePath = resolve(credentialsDir, "username");
  const passwordPath = resolve(credentialsDir, "password");
  if (!(existsSync(usernamePath) && existsSync(passwordPath))) {
    return Option.none();
  }
  return Option.some({
    password: readCredentialFile(passwordPath),
    username: readCredentialFile(usernamePath),
  });
};

const remoteArgFromGitArgs = (args: string[]): Option.Option<string> =>
  Option.fromUndefinedOr(args.slice(1).find((arg) => !arg.startsWith("-")));

const gitRemoteUrl = (
  cwd: string,
  remoteName: string,
): Effect.Effect<Option.Option<string>, unknown, GitPorcelainService> =>
  Effect.gen(function* effectBody() {
    const git = yield* GitPorcelainService;
    const stdout = yield* git.run(cwd, ["remote", "get-url", remoteName], {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
  });

const remoteUrlForName = (
  cwd: string,
  remoteName: Option.Option<string>,
): Effect.Effect<Option.Option<string>, unknown, GitPorcelainService> =>
  Option.isSome(remoteName) ? gitRemoteUrl(cwd, remoteName.value) : Effect.succeed(MISSING_REMOTE_URL);

const isHttpRemote = (value: string): boolean => value.startsWith("http://") || value.startsWith("https://");

const isScpLikeSshRemote = (value: string): boolean => SCP_LIKE_SSH_REMOTE_RE.test(value);

const isRemoteUrl = (value: string): boolean =>
  value.startsWith("http://") ||
  value.startsWith("https://") ||
  value.startsWith("ssh://") ||
  isScpLikeSshRemote(value);

const literalRemoteUrlFromGitArgs = (args: string[]): Option.Option<string> => {
  if (args[0] === "clone") {
    return Option.fromUndefinedOr(args.find((arg) => isRemoteUrl(arg)));
  }
  if (args[0] === "fetch" || args[0] === "push" || args[0] === "ls-remote") {
    const remoteArg = remoteArgFromGitArgs(args);
    if (Option.isSome(remoteArg) && isRemoteUrl(remoteArg.value)) {
      return remoteArg;
    }
  }
  return Option.none();
};

const remoteNameFromGitArgs = (args: string[]): Option.Option<string> => {
  if (args[0] === "fetch" || args[0] === "push" || args[0] === "ls-remote") {
    const remoteArg = remoteArgFromGitArgs(args);
    if (Option.isSome(remoteArg) && !isRemoteUrl(remoteArg.value)) {
      return remoteArg;
    }
  }
  return Option.none();
};

const remoteUrlFromGitArgs = (
  cwd: string,
  args: string[],
): Effect.Effect<Option.Option<string>, unknown, GitPorcelainService> =>
  Effect.gen(function* effectBody() {
    const literalRemoteUrl = literalRemoteUrlFromGitArgs(args);
    if (Option.isSome(literalRemoteUrl)) {
      return literalRemoteUrl;
    }
    const remoteName = remoteNameFromGitArgs(args);
    return yield* remoteUrlForName(cwd, remoteName);
  });

const isSshRemote = (value: string): boolean => value.startsWith("ssh://") || isScpLikeSshRemote(value);

const assertSshCredentialsAvailable = (remoteUrl: Option.Option<string>): void => {
  if (Option.isNone(remoteUrl) || !isSshRemote(remoteUrl.value)) {
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
  throw new Error(`SSH git remote ${remoteUrl.value} requires mounted git credential file(s): ${missing.join(", ")}`);
};

const credentialHost = (remoteUrl: string): Option.Option<string> => {
  try {
    const { host } = new URL(remoteUrl);
    return host.length > 0 ? Option.some(host) : Option.none();
  } catch {
    return Option.none();
  }
};

const prepareBasicAuthCredentialStore = (
  credentials: { password: string; username: string },
  writablePath: string,
  remoteUrl: Option.Option<string>,
): Option.Option<string> => {
  const host = Option.isSome(remoteUrl) ? credentialHost(remoteUrl.value) : Option.none();
  if (Option.isNone(host)) {
    return existingPreparedBasicAuthCredentialStore(writablePath);
  }
  if (isPreparedBasicAuthCredentialStore(writablePath, host.value)) {
    return Option.some(writablePath);
  }
  writeGitCredentialStore(credentials, writablePath, host.value);
  preparedBasicAuthCredentialStore = Option.some({
    host: host.value,
    path: writablePath,
  });
  return Option.some(writablePath);
};

const prepareWritableGitCredentialStore = (remoteUrl: Option.Option<string>): Option.Option<string> => {
  if (Option.isNone(remoteUrl)) {
    return existingPreparedBasicAuthCredentialStore(writableGitCredentialStore());
  }
  if (!isHttpRemote(remoteUrl.value)) {
    return Option.none();
  }
  const writablePath = writableGitCredentialStore();
  const basicAuth = availableBasicAuthCredentials();
  if (Option.isSome(basicAuth)) {
    return prepareBasicAuthCredentialStore(basicAuth.value, writablePath, remoteUrl);
  }
  return Option.none();
};

const gitCredentialConfigArgs = (remoteUrl: Option.Option<string>): string[] => {
  const writablePath = prepareWritableGitCredentialStore(remoteUrl);
  if (Option.isNone(writablePath)) {
    return [];
  }
  return ["-c", "credential.helper=", "-c", `credential.helper=store --file=${writablePath.value}`];
};

const runnerGitCommandArgs = (args: string[], remoteUrl: Option.Option<string>): string[] => [
  ...gitCredentialConfigArgs(remoteUrl),
  ...args,
];

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const gitSshCommand = (): Option.Option<string> => {
  const credentialsDir = gitCredentialsDir();
  const identityPath = resolve(credentialsDir, "identity");
  const knownHostsPath = resolve(credentialsDir, "known_hosts");
  if (!(existsSync(identityPath) && existsSync(knownHostsPath))) {
    return Option.none();
  }
  ensureSshIdentityPermissions(identityPath);
  return Option.some(
    [
      "ssh",
      "-i",
      shellQuote(identityPath),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
      "-o",
      "StrictHostKeyChecking=yes",
    ].join(" "),
  );
};

const runnerGitEnv = (remoteUrl: Option.Option<string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const sshCommand = gitSshCommand();
  if (Option.isSome(sshCommand) && Option.isSome(remoteUrl) && isSshRemote(remoteUrl.value)) {
    env.GIT_SSH_COMMAND = sshCommand.value;
  }
  return env;
};

const runGit = (cwd: string, args: string[]): Effect.Effect<string, unknown, GitPorcelainService> =>
  Effect.gen(function* effectBody() {
    const remoteUrl = yield* remoteUrlFromGitArgs(cwd, args);
    yield* Effect.try({
      catch: (error) => error,
      try: () => {
        assertSshCredentialsAvailable(remoteUrl);
      },
    });
    const git = yield* GitPorcelainService;
    const commandArgs = runnerGitCommandArgs(args, remoteUrl);
    return yield* git.run(cwd, commandArgs, runnerGitEnv(remoteUrl));
  });

const prepareRunnerGitWorkspaceEffect = (
  payload: RunnerCommandPayload,
  options: PrepareRunnerGitWorkspaceOptions,
): Effect.Effect<string, unknown, GitPorcelainService> =>
  Effect.gen(function* effectBody() {
    if (options.cwd !== undefined && options.cwd.length > 0) {
      return resolve(options.cwd);
    }
    const worktreePath = options.workspacePath ?? DEFAULT_WORKSPACE_PATH;
    yield* Effect.sync(() => mkdirSync(dirname(worktreePath), { recursive: true }));
    yield* runGit(dirname(worktreePath), ["clone", "--no-tags", payload.repository.url, worktreePath]);
    yield* runGit(worktreePath, ["checkout", payload.repository.sha ?? `origin/${payload.repository.baseBranch}`]);
    return worktreePath;
  });

export const prepareRunnerGitWorkspace = async (
  payload: RunnerCommandPayload,
  options: PrepareRunnerGitWorkspaceOptions = {},
): Promise<string> =>
  await Effect.runPromise(Effect.provide(prepareRunnerGitWorkspaceEffect(payload, options), GitPorcelainServiceLive));

const mergeDependencyRef = (worktreePath: string, ref: string): Effect.Effect<void, unknown, GitPorcelainService> =>
  Effect.gen(function* effectBody() {
    yield* runGit(worktreePath, ["fetch", "origin", ref]);
    yield* runGit(worktreePath, ["merge", "--no-ff", "--no-edit", "FETCH_HEAD"]);
  });

/**
 * Run a single git command through the runner's authenticated path: per-command
 * credential-helper store (basic-auth from the mounted git-credentials) plus
 * GIT_TERMINAL_PROMPT=0 so a missing credential fails fast instead of blocking
 * forever on an interactive username prompt. This is the ONE git-auth primitive;
 * every runner git operation (node delivery, dependency merge, open-pull-request)
 * must route through it rather than spawning naked git.
 */
export const runAuthenticatedGit = async (cwd: string, args: string[]): Promise<string> =>
  await Effect.runPromise(Effect.provide(runGit(cwd, args), GitPorcelainServiceLive));

const remoteHeadSha = (
  worktreePath: string,
  ref: string,
): Effect.Effect<Option.Option<string>, unknown, GitPorcelainService> =>
  Effect.map(runGit(worktreePath, ["ls-remote", "--heads", "origin", ref]), (stdout) => parseLsRemoteSha(stdout));

const pushGeneratedRef = (worktreePath: string, ref: string): Effect.Effect<void, unknown, GitPorcelainService> =>
  Effect.gen(function* effectBody() {
    const expectedSha = yield* remoteHeadSha(worktreePath, ref);
    yield* runGit(worktreePath, [
      "push",
      `--force-with-lease=${ref}:${Option.getOrElse(expectedSha, () => "")}`,
      "origin",
      `HEAD:${ref}`,
    ]);
  });

const headSha = (worktreePath: string): Effect.Effect<string, unknown, GitPorcelainService> =>
  Effect.map(runGit(worktreePath, ["rev-parse", "HEAD"]), (sha) => sha.trim());

const configureGitCommitter = (
  worktreePath: string,
  committer: PipelineConfig["runner_command"]["git"]["committer"],
): Effect.Effect<void, unknown, GitPorcelainService> =>
  Effect.gen(function* effectBody() {
    yield* runGit(worktreePath, ["config", "--local", "user.name", committer.name]);
    yield* runGit(worktreePath, ["config", "--local", "user.email", committer.email]);
  });

const mergeDependencyRefsEffect = (input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  dependencyNodeIds: string[];
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Effect.Effect<void, unknown, GitPorcelainService> =>
  Effect.gen(function* effectBody() {
    yield* configureGitCommitter(input.worktreePath, input.committer);
    yield* Effect.forEach(input.dependencyNodeIds, (nodeId) =>
      mergeDependencyRef(input.worktreePath, runnerGitRefs(input.payload, nodeId).nodeRef),
    );
  });

export const mergeDependencyRefs = async (input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  dependencyNodeIds: string[];
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Promise<void> => {
  await Effect.runPromise(Effect.provide(mergeDependencyRefsEffect(input), GitPorcelainServiceLive));
};

const commitChangesIfNeeded = (
  worktreePath: string,
  nodeId: string,
  committer: PipelineConfig["runner_command"]["git"]["committer"],
): Effect.Effect<void, unknown, GitPorcelainService> =>
  Effect.gen(function* effectBody() {
    const status = yield* runGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.trim().length === 0) {
      return;
    }
    yield* runGit(worktreePath, ["add", "--all"]);
    yield* configureGitCommitter(worktreePath, committer);
    yield* runGit(worktreePath, ["commit", "-m", runnerCommitMessage(nodeId)]);
  });

const commitAndPushNodeRefEffect = (input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  nodeId: string;
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Effect.Effect<string, unknown, GitPorcelainService> =>
  Effect.gen(function* effectBody() {
    yield* commitChangesIfNeeded(input.worktreePath, input.nodeId, input.committer);
    const sha = yield* headSha(input.worktreePath);
    yield* pushGeneratedRef(input.worktreePath, runnerGitRefs(input.payload, input.nodeId).nodeRef);
    return sha;
  });

export const commitAndPushNodeRef = async (input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  nodeId: string;
  payload: RunnerCommandPayload;
  worktreePath: string;
}): Promise<string> =>
  await Effect.runPromise(Effect.provide(commitAndPushNodeRefEffect(input), GitPorcelainServiceLive));

const promoteFinalRefEffect = (input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  payload: RunnerCommandPayload;
  sourceNodeIds: string[];
  worktreePath: string;
}): Effect.Effect<string, unknown, GitPorcelainService> =>
  Effect.gen(function* effectBody() {
    yield* mergeDependencyRefsEffect({
      committer: input.committer,
      dependencyNodeIds: input.sourceNodeIds,
      payload: input.payload,
      worktreePath: input.worktreePath,
    });
    yield* commitChangesIfNeeded(input.worktreePath, "final", input.committer);
    const sha = yield* headSha(input.worktreePath);
    yield* pushGeneratedRef(input.worktreePath, runnerGitRefs(input.payload, "final").finalRef);
    return sha;
  });

export const promoteFinalRef = async (input: {
  committer: PipelineConfig["runner_command"]["git"]["committer"];
  payload: RunnerCommandPayload;
  sourceNodeIds: string[];
  worktreePath: string;
}): Promise<string> => await Effect.runPromise(Effect.provide(promoteFinalRefEffect(input), GitPorcelainServiceLive));
