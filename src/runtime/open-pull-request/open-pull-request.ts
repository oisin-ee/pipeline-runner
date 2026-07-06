import { Effect, Layer } from "effect";

import type { PlannedWorkflowNode } from "../../planning/compile";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { CommandExecutor, CommandExecutorLive } from "../services/command-executor-service";
import { OpenPullRequestGitService, OpenPullRequestGitServiceLive } from "../services/open-pull-request-git-service";
import type { OpenPullRequestGitClient } from "../services/open-pull-request-git-service";

const INVALID_REF_CHAR_RE = /[^a-zA-Z0-9/_.-]/gu;
const PR_ALREADY_EXISTS_RE = /already exists/iu;
const NEWLINE_RE = /\r?\n/u;

interface OpenPrContext {
  baseBranch: string;
  committer: RuntimeContext["config"]["runner_command"]["git"]["committer"];
  headBranch: string;
  label: string;
  mode: "create-new-pr" | "update-existing-pr";
  runId: string;
  task: string;
}

type PullRequestDeliveryAction = "opened" | "updated";

const stripOriginPrefix = (ref: string): string => (ref.startsWith("origin/") ? ref.slice("origin/".length) : ref);

const fallbackBranch = (context: RuntimeContext): string =>
  context.runId !== undefined && context.runId.length > 0 ? `moka/run/${context.runId}` : "main";

const resolveCurrentBranch = (git: OpenPullRequestGitClient, context: RuntimeContext): Effect.Effect<string> =>
  git.raw(["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
    Effect.map((ref) => ref.trim()),
    Effect.catch(() => Effect.succeed(fallbackBranch(context))),
  );

const resolveDefaultBranch = (git: OpenPullRequestGitClient, context: RuntimeContext): Effect.Effect<string, unknown> =>
  git.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).pipe(
    Effect.map((ref) => stripOriginPrefix(ref.trim())),
    Effect.catch(() => resolveCurrentBranch(git, context)),
  );

const resolveHeadBranch = (runId?: string): string => {
  const raw = `moka/run/${runId ?? "local"}`;
  return raw.replace(INVALID_REF_CHAR_RE, "-");
};

const resolveOpenPrContext = (
  git: OpenPullRequestGitClient,
  context: RuntimeContext,
): Effect.Effect<OpenPrContext, unknown> =>
  Effect.gen(function* effectBody() {
    const baseBranch = yield* resolveDefaultBranch(git, context);
    const headBranch = context.config.delivery?.pull_request?.head_branch ?? resolveHeadBranch(context.runId);
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

const checkoutOrCreateHeadBranch = (git: OpenPullRequestGitClient, headBranch: string): Effect.Effect<void, unknown> =>
  git.raw(["checkout", "-B", headBranch]).pipe(Effect.asVoid);

const configureCommitter = (
  git: OpenPullRequestGitClient,
  committer: OpenPrContext["committer"],
): Effect.Effect<void, unknown> =>
  git.raw(["config", "--local", "user.name", committer.name]).pipe(
    Effect.flatMap(() => git.raw(["config", "--local", "user.email", committer.email])),
    Effect.asVoid,
  );

const commitIfDirty = (
  git: OpenPullRequestGitClient,
  status: string,
  prCtx: OpenPrContext,
): Effect.Effect<void, unknown> => {
  if (status.length === 0) {
    return Effect.void;
  }
  return configureCommitter(git, prCtx.committer).pipe(
    Effect.flatMap(() => git.raw(["add", "-A"])),
    Effect.flatMap(() => git.raw(["commit", "-m", `open-pull-request: ${prCtx.runId}`])),
    Effect.asVoid,
  );
};

const stageAndCommitChanges = (git: OpenPullRequestGitClient, prCtx: OpenPrContext): Effect.Effect<void, unknown> =>
  git.raw(["status", "--porcelain"]).pipe(
    Effect.flatMap((status) => commitIfDirty(git, status.trim(), prCtx)),
    Effect.asVoid,
  );

// `checkout -B <headBranch>` resets the branch to the current workspace HEAD,
// then commits + force-with-lease push. In update-existing-pr mode this APPENDS
// fix-commits to the PR branch only because the run's workspace was checked out
// from that branch's head (the loop controller sets repository.sha = PR head sha
// before submitting a remediation run). A pre-checkout `git fetch` would be
// discarded by `checkout -B` and cannot make the fetched ref the base, so it is
// intentionally absent — basing is owned by the workspace, not this builtin.
const prepareHeadBranch = (git: OpenPullRequestGitClient, prCtx: OpenPrContext): Effect.Effect<void, unknown> =>
  checkoutOrCreateHeadBranch(git, prCtx.headBranch).pipe(
    Effect.flatMap(() => stageAndCommitChanges(git, prCtx)),
    Effect.asVoid,
  );

const pushHeadBranch = (git: OpenPullRequestGitClient, headBranch: string): Effect.Effect<void, unknown> =>
  git.raw(["push", "--force-with-lease", "origin", `HEAD:refs/heads/${headBranch}`]).pipe(Effect.asVoid);

interface CommandExecutorService {
  execute: (cmd: string[], ctx: RuntimeContext) => Effect.Effect<NodeAttemptResult, unknown>;
}

const extractPrTitle = (task: string): string => {
  const first = task.split(NEWLINE_RE)[0] ?? task;
  return first.trim() || "moka: open pull request";
};

const buildGhPrCreateArgs = (prCtx: OpenPrContext, title: string): string[] => [
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
];

const buildGhPrEditArgs = (headBranch: string, label: string): string[] => [
  "gh",
  "pr",
  "edit",
  headBranch,
  "--add-label",
  label,
];

const buildGhPrViewArgs = (headBranch: string): string[] => [
  "gh",
  "pr",
  "view",
  headBranch,
  "--json",
  "url",
  "--jq",
  ".url",
];

const isPrAlreadyExistsError = (output: string): boolean => PR_ALREADY_EXISTS_RE.test(output);

const extractPrUrl = (output: string): string => {
  const line = output
    .split(NEWLINE_RE)
    .map((l) => l.trim())
    .find((l) => l.startsWith("https://"));
  return line ?? output.trim();
};

const openPrSuccess = (
  context: RuntimeContext,
  url: string,
  action: PullRequestDeliveryAction,
  extraEvidence: string[] = [],
): NodeAttemptResult => {
  context.reporter?.({
    deliveryPullRequest: { action, url },
    type: "delivery.pull-request",
  });
  return {
    evidence: [`open-pull-request: PR ${action} — ${url}`, ...extraEvidence],
    exitCode: 0,
    output: JSON.stringify({ action, url }),
  };
};

const openPrFailure = (reason: string): NodeAttemptResult => ({
  evidence: [`open-pull-request failed: ${reason}`],
  exitCode: 1,
  output: JSON.stringify({ error: reason }),
});

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const runGhPrCreate = (
  executor: CommandExecutorService,
  prCtx: OpenPrContext,
  title: string,
  context: RuntimeContext,
): Effect.Effect<NodeAttemptResult> =>
  executor
    .execute(buildGhPrCreateArgs(prCtx, title), context)
    .pipe(Effect.catch((error) => Effect.succeed(openPrFailure(errorMessage(error)))));

const runGhPrEdit = (
  executor: CommandExecutorService,
  headBranch: string,
  label: string,
  context: RuntimeContext,
): Effect.Effect<NodeAttemptResult> =>
  executor
    .execute(buildGhPrEditArgs(headBranch, label), context)
    .pipe(Effect.catch((error) => Effect.succeed(openPrFailure(errorMessage(error)))));

// The label is enrichment, not the deliverable -- the PR opening is. gh pr
// create validates --label up front and refuses to create anything at all
// if the label is missing from the target repo, so labeling happens as a
// separate best-effort step after the PR exists: a missing/misconfigured
// label degrades to a note in evidence, never blocks delivery of the PR.
const labelCreatedPr = (
  executor: CommandExecutorService,
  prCtx: OpenPrContext,
  createResult: NodeAttemptResult,
  context: RuntimeContext,
): Effect.Effect<NodeAttemptResult> => {
  const url = extractPrUrl(createResult.output);
  return runGhPrEdit(executor, prCtx.headBranch, prCtx.label, context).pipe(
    Effect.map((editResult) =>
      editResult.exitCode === 0
        ? openPrSuccess(context, url, "opened")
        : openPrSuccess(context, url, "opened", [
            `open-pull-request: label '${prCtx.label}' not applied — ${editResult.output || `gh pr edit exited ${editResult.exitCode}`}`,
          ]),
    ),
  );
};

const runGhPrView = (
  executor: CommandExecutorService,
  headBranch: string,
  context: RuntimeContext,
): Effect.Effect<NodeAttemptResult> =>
  executor
    .execute(buildGhPrViewArgs(headBranch), context)
    .pipe(Effect.catch((error) => Effect.succeed(openPrFailure(errorMessage(error)))));

const handleExistingPr = (
  headBranch: string,
  label: string,
  context: RuntimeContext,
): Effect.Effect<NodeAttemptResult, never, CommandExecutor> =>
  Effect.gen(function* effectBody() {
    const executor = yield* CommandExecutor;
    const editResult = yield* runGhPrEdit(executor, headBranch, label, context);
    if (editResult.exitCode === 0) {
      const viewResult = yield* runGhPrView(executor, headBranch, context);
      return viewResult.exitCode === 0
        ? openPrSuccess(context, extractPrUrl(viewResult.output), "updated")
        : openPrFailure(viewResult.output || `gh pr view exited ${viewResult.exitCode}`);
    }
    return openPrFailure(editResult.output || `gh pr edit exited ${editResult.exitCode}`);
  });

const submitPullRequest = (
  prCtx: OpenPrContext,
  context: RuntimeContext,
): Effect.Effect<NodeAttemptResult, never, CommandExecutor> => {
  if (prCtx.mode === "update-existing-pr") {
    return handleExistingPr(prCtx.headBranch, prCtx.label, context);
  }
  return Effect.gen(function* effectBody() {
    const executor = yield* CommandExecutor;
    const title = extractPrTitle(prCtx.task);
    const createResult = yield* runGhPrCreate(executor, prCtx, title, context);
    if (createResult.exitCode === 0) {
      return yield* labelCreatedPr(executor, prCtx, createResult, context);
    }
    if (isPrAlreadyExistsError(createResult.output)) {
      return yield* handleExistingPr(prCtx.headBranch, prCtx.label, context);
    }
    return createResult;
  });
};

const executeOpenPr = (
  git: OpenPullRequestGitClient,
  prCtx: OpenPrContext,
  context: RuntimeContext,
): Effect.Effect<NodeAttemptResult, never, CommandExecutor> =>
  Effect.gen(function* effectBody() {
    const prepareResult = yield* Effect.result(prepareHeadBranch(git, prCtx));
    if (prepareResult._tag === "Failure") {
      return openPrFailure(errorMessage(prepareResult.failure));
    }
    const pushResult = yield* Effect.result(pushHeadBranch(git, prCtx.headBranch));
    if (pushResult._tag === "Failure") {
      return openPrFailure(errorMessage(pushResult.failure));
    }
    return yield* submitPullRequest(prCtx, context);
  });

export const openPullRequestProgram = (
  context: RuntimeContext,
): Effect.Effect<NodeAttemptResult, never, OpenPullRequestGitService | CommandExecutor> =>
  Effect.gen(function* effectBody() {
    const gitService = yield* OpenPullRequestGitService;
    const git = yield* gitService.create(context.worktreePath);
    const prCtx = yield* Effect.result(resolveOpenPrContext(git, context));
    if (prCtx._tag === "Failure") {
      return openPrFailure(errorMessage(prCtx.failure));
    }
    return yield* executeOpenPr(git, prCtx.success, context);
  });

export const executeOpenPullRequestBuiltin = async (
  context: RuntimeContext,
  _node?: PlannedWorkflowNode,
): Promise<NodeAttemptResult> => {
  const merged = Layer.merge(OpenPullRequestGitServiceLive, CommandExecutorLive);
  return await Effect.runPromise(Effect.provide(openPullRequestProgram(context), merged));
};
