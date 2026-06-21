import { Effect, Layer } from "effect";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import {
  CommandExecutor,
  CommandExecutorLive,
} from "../services/command-executor-service";
import {
  type OpenPullRequestGitClient,
  OpenPullRequestGitService,
  OpenPullRequestGitServiceLive,
} from "../services/open-pull-request-git-service";

const INVALID_REF_CHAR_RE = /[^a-zA-Z0-9/_.-]/g;
const PR_ALREADY_EXISTS_RE = /already exists/i;
const NEWLINE_RE = /\r?\n/;

interface OpenPrContext {
  baseBranch: string;
  committer: RuntimeContext["config"]["runner_command"]["git"]["committer"];
  headBranch: string;
  label: string;
  mode: "create-new-pr" | "update-existing-pr";
  runId: string;
  task: string;
}

export function executeOpenPullRequestBuiltin(
  context: RuntimeContext,
  _node?: PlannedWorkflowNode
): Promise<NodeAttemptResult> {
  const merged = Layer.merge(
    OpenPullRequestGitServiceLive,
    CommandExecutorLive
  );
  return Effect.runPromise(
    Effect.provide(openPullRequestProgram(context), merged)
  );
}

export function openPullRequestProgram(
  context: RuntimeContext
): Effect.Effect<
  NodeAttemptResult,
  never,
  OpenPullRequestGitService | CommandExecutor
> {
  return Effect.gen(function* () {
    const gitService = yield* OpenPullRequestGitService;
    const git = yield* gitService.create(context.worktreePath);
    const prCtx = yield* Effect.either(resolveOpenPrContext(git, context));
    if (prCtx._tag === "Left") {
      return openPrFailure(errorMessage(prCtx.left));
    }
    return yield* executeOpenPr(git, prCtx.right, context);
  });
}

function resolveOpenPrContext(
  git: OpenPullRequestGitClient,
  context: RuntimeContext
): Effect.Effect<OpenPrContext, unknown> {
  return Effect.gen(function* () {
    const baseBranch = yield* resolveDefaultBranch(git, context);
    const headBranch =
      context.config.delivery?.pull_request?.head_branch ??
      resolveHeadBranch(context.runId);
    return {
      baseBranch,
      committer: context.config.runner_command.git.committer,
      headBranch,
      label: context.config.delivery?.pull_request?.label ?? "preview",
      mode: context.config.delivery?.pull_request?.mode ?? "create-new-pr",
      runId: context.runId ?? "local",
      task: context.task,
    };
  });
}

function resolveDefaultBranch(
  git: OpenPullRequestGitClient,
  context: RuntimeContext
): Effect.Effect<string, unknown> {
  return git.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).pipe(
    Effect.map((ref) => stripOriginPrefix(ref.trim())),
    Effect.catchAll(() => resolveCurrentBranch(git, context))
  );
}

function stripOriginPrefix(ref: string): string {
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
}

function resolveCurrentBranch(
  git: OpenPullRequestGitClient,
  context: RuntimeContext
): Effect.Effect<string, never> {
  return git.raw(["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
    Effect.map((ref) => ref.trim()),
    Effect.catchAll(() => Effect.succeed(fallbackBranch(context)))
  );
}

function fallbackBranch(context: RuntimeContext): string {
  return context.runId ? `moka/run/${context.runId}` : "main";
}

function resolveHeadBranch(runId?: string): string {
  const raw = `moka/run/${runId ?? "local"}`;
  return raw.replace(INVALID_REF_CHAR_RE, "-");
}

function executeOpenPr(
  git: OpenPullRequestGitClient,
  prCtx: OpenPrContext,
  context: RuntimeContext
): Effect.Effect<NodeAttemptResult, never, CommandExecutor> {
  return Effect.gen(function* () {
    const prepareResult = yield* Effect.either(prepareHeadBranch(git, prCtx));
    if (prepareResult._tag === "Left") {
      return openPrFailure(errorMessage(prepareResult.left));
    }
    const pushResult = yield* Effect.either(
      pushHeadBranch(git, prCtx.headBranch)
    );
    if (pushResult._tag === "Left") {
      return openPrFailure(errorMessage(pushResult.left));
    }
    return yield* submitPullRequest(prCtx, context);
  });
}

function prepareHeadBranch(
  git: OpenPullRequestGitClient,
  prCtx: OpenPrContext
): Effect.Effect<void, unknown> {
  return fetchExistingBranchIfUpdate(git, prCtx).pipe(
    Effect.flatMap(() => checkoutOrCreateHeadBranch(git, prCtx.headBranch)),
    Effect.flatMap(() => stageAndCommitChanges(git, prCtx)),
    Effect.asVoid
  );
}

function fetchExistingBranchIfUpdate(
  git: OpenPullRequestGitClient,
  prCtx: OpenPrContext
): Effect.Effect<void, unknown> {
  if (prCtx.mode !== "update-existing-pr") {
    return Effect.void;
  }
  return git.raw(["fetch", "origin", prCtx.headBranch]).pipe(Effect.asVoid);
}

function checkoutOrCreateHeadBranch(
  git: OpenPullRequestGitClient,
  headBranch: string
): Effect.Effect<void, unknown> {
  return git.raw(["checkout", "-B", headBranch]).pipe(Effect.asVoid);
}

function stageAndCommitChanges(
  git: OpenPullRequestGitClient,
  prCtx: OpenPrContext
): Effect.Effect<void, unknown> {
  return git.raw(["status", "--porcelain"]).pipe(
    Effect.flatMap((status) => commitIfDirty(git, status.trim(), prCtx)),
    Effect.asVoid
  );
}

function commitIfDirty(
  git: OpenPullRequestGitClient,
  status: string,
  prCtx: OpenPrContext
): Effect.Effect<void, unknown> {
  if (status.length === 0) {
    return Effect.void;
  }
  return configureCommitter(git, prCtx.committer).pipe(
    Effect.flatMap(() => git.raw(["add", "-A"])),
    Effect.flatMap(() =>
      git.raw(["commit", "-m", `open-pull-request: ${prCtx.runId}`])
    ),
    Effect.asVoid
  );
}

function configureCommitter(
  git: OpenPullRequestGitClient,
  committer: OpenPrContext["committer"]
): Effect.Effect<void, unknown> {
  return git.raw(["config", "--local", "user.name", committer.name]).pipe(
    Effect.flatMap(() =>
      git.raw(["config", "--local", "user.email", committer.email])
    ),
    Effect.asVoid
  );
}

function pushHeadBranch(
  git: OpenPullRequestGitClient,
  headBranch: string
): Effect.Effect<void, unknown> {
  return git
    .raw([
      "push",
      "--force-with-lease",
      "origin",
      `HEAD:refs/heads/${headBranch}`,
    ])
    .pipe(Effect.asVoid);
}

function submitPullRequest(
  prCtx: OpenPrContext,
  context: RuntimeContext
): Effect.Effect<NodeAttemptResult, never, CommandExecutor> {
  if (prCtx.mode === "update-existing-pr") {
    return handleExistingPr(prCtx.headBranch, prCtx.label, context);
  }
  return Effect.gen(function* () {
    const executor = yield* CommandExecutor;
    const title = extractPrTitle(prCtx.task);
    const createResult = yield* runGhPrCreate(executor, prCtx, title, context);
    if (createResult.exitCode === 0) {
      return openPrSuccess(extractPrUrl(createResult.output), "opened");
    }
    if (isPrAlreadyExistsError(createResult.output)) {
      return yield* handleExistingPr(prCtx.headBranch, prCtx.label, context);
    }
    return createResult;
  });
}

interface CommandExecutorService {
  execute: (
    cmd: string[],
    ctx: RuntimeContext
  ) => Effect.Effect<NodeAttemptResult, unknown>;
}

function runGhPrCreate(
  executor: CommandExecutorService,
  prCtx: OpenPrContext,
  title: string,
  context: RuntimeContext
): Effect.Effect<NodeAttemptResult, never> {
  return executor
    .execute(buildGhPrCreateArgs(prCtx, title), context)
    .pipe(
      Effect.catchAll((e) => Effect.succeed(openPrFailure(errorMessage(e))))
    );
}

function handleExistingPr(
  headBranch: string,
  label: string,
  context: RuntimeContext
): Effect.Effect<NodeAttemptResult, never, CommandExecutor> {
  return Effect.gen(function* () {
    const executor = yield* CommandExecutor;
    const editResult = yield* runGhPrEdit(executor, headBranch, label, context);
    if (editResult.exitCode === 0) {
      return openPrSuccess(headBranch, "updated");
    }
    return openPrFailure(
      editResult.output || `gh pr edit exited ${editResult.exitCode}`
    );
  });
}

function runGhPrEdit(
  executor: CommandExecutorService,
  headBranch: string,
  label: string,
  context: RuntimeContext
): Effect.Effect<NodeAttemptResult, never> {
  return executor
    .execute(buildGhPrEditArgs(headBranch, label), context)
    .pipe(
      Effect.catchAll((e) => Effect.succeed(openPrFailure(errorMessage(e))))
    );
}

function extractPrTitle(task: string): string {
  const first = task.split(NEWLINE_RE)[0] ?? task;
  return first.trim() || "moka: open pull request";
}

function buildGhPrCreateArgs(prCtx: OpenPrContext, title: string): string[] {
  return [
    "gh",
    "pr",
    "create",
    "--base",
    prCtx.baseBranch,
    "--head",
    prCtx.headBranch,
    "--title",
    title,
    "--body",
    `Opened by moka run ${prCtx.runId}`,
    "--label",
    prCtx.label,
  ];
}

function buildGhPrEditArgs(headBranch: string, label: string): string[] {
  return ["gh", "pr", "edit", headBranch, "--add-label", label];
}

function isPrAlreadyExistsError(output: string): boolean {
  return PR_ALREADY_EXISTS_RE.test(output);
}

function extractPrUrl(output: string): string {
  const line = output
    .split(NEWLINE_RE)
    .map((l) => l.trim())
    .find((l) => l.startsWith("https://"));
  return line ?? output.trim();
}

function openPrSuccess(
  url: string,
  action: "opened" | "updated"
): NodeAttemptResult {
  return {
    evidence: [`open-pull-request: PR ${action} — ${url}`],
    exitCode: 0,
    output: JSON.stringify({ action, url }),
  };
}

function openPrFailure(reason: string): NodeAttemptResult {
  return {
    evidence: [`open-pull-request failed: ${reason}`],
    exitCode: 1,
    output: JSON.stringify({ error: reason }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
