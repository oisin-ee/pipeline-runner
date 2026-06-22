import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import type { PipelineConfig } from "../config";
import {
  type MokaSubmitInput,
  type MokaSubmitResult,
  submitMoka,
} from "../moka-submit";
import { runAuthenticatedGit } from "../run-state/git-refs";
import type { RunnerEventRecord } from "../runner-command-contract";
import {
  RunnerEventSinkHttpService,
  RunnerEventSinkHttpServiceLive,
} from "../runtime/services/runner-event-sink-http-service";
import type { BacklogTaskRecord } from "../tickets/backlog-task-store";
import { ticketGraphDtoSchema } from "../tickets/ticket-graph-dto";
import type { TicketSelectionStrategy } from "../tickets/ticket-selection";
import { pollWorkflowPhaseUntilTerminal } from "./argo-poll";
import { loadBacklogRecords } from "./backlog-records";
import type {
  ControllerDeps,
  LoopControllerEvent,
  MergePollSignal,
  SubmitRunInput,
  SubmitRunResult,
  TerminalPhase,
} from "./controller";
import {
  classifyRequiredChecks,
  type GhRunner,
  type PrResolution,
  resolvePrForRun,
} from "./gh-checks";
import { createGhRunner } from "./gh-runner";
import { mergeForClassification } from "./merge";

// ===========================================================================
// PIPE-88.8 — production ControllerDeps
//
// Wires every injected seam of the headless controller to its real
// implementation: submitMoka, pollWorkflowPhaseUntilTerminal, the real
// GhRunner, classifyRequiredChecks, mergeForClassification, the backlog store,
// an authenticated git refresh, and the runner event sink. Every external
// boundary is itself injectable (defaults to the real impl) so the adapter is
// unit-testable without touching GitHub / k8s / git.
// ===========================================================================

type OpenPr = Extract<PrResolution, { found: true }>;

/** Static context for the in-cluster controller run (from the runner payload). */
export interface LoopControllerContext {
  /** Base repository the child runs target — sha/headBranch overridden per submit. */
  readonly baseBranch: string;
  readonly config: PipelineConfig;
  /** Event sink auth header (defaults to Authorization). */
  readonly eventAuthHeader?: string;
  /** Event sink bearer token (already resolved from its mounted file). */
  readonly eventAuthToken: string;
  /** Event sink URL the loop.* records are POSTed to. */
  readonly eventUrl: string;
  readonly gitCredentialsSecretName: string;
  readonly githubAuthSecretName?: string;
  readonly maxMergePolls: number;
  readonly maxRemediationAttempts: number;
  readonly namespace: string;
  readonly opencodeAuthSecretName?: string;
  readonly opencodeOpenaiAccountsSecretName?: string;
  readonly project: string;
  readonly rootId?: string;
  /** This loop run's id — the envelope/sequence key for emitted loop.* events. */
  readonly runId: string;
  readonly serviceAccountName?: string;
  readonly strategy: TicketSelectionStrategy;
  readonly url: string;
  /** Workspace the backlog store + git refresh read. */
  readonly worktreePath: string;
}

/** A normalized child-run submission the low-level submit seam consumes. */
export interface LoopSubmitRequest {
  readonly deliveryMode: "create-new-pr" | "update-existing-pr";
  readonly headBranch?: string;
  readonly repositorySha?: string;
  readonly runId: string;
  readonly task: string;
}

/** Lower seams; every one defaults to the real implementation, overridable in tests. */
export interface ControllerDepsSeams {
  /** Generate a child run id (defaults to a random hex id). */
  readonly generateRunId?: () => string;
  /** Build the raw gh runner (defaults to the real execa-backed GhRunner). */
  readonly gh?: GhRunner;
  /** Authenticated git refresh of main (defaults to runAuthenticatedGit). */
  readonly gitRefresh?: (worktreePath: string) => Promise<void>;
  /** Load backlog task records (defaults to the RepoIo-backed store). */
  readonly loadTasks?: (
    worktreePath: string
  ) => Effect.Effect<readonly BacklogTaskRecord[], Error>;
  /** Poll an Argo workflow to terminal (defaults to the in-cluster poller). */
  readonly pollPhase?: (input: {
    readonly namespace: string;
    readonly runId: string;
    readonly workflowName: string;
  }) => Effect.Effect<TerminalPhase, Error>;
  /** POST a loop.* event record (defaults to the runner event sink). */
  readonly postEvent?: (record: RunnerEventRecord) => Promise<void>;
  /** Raw submitMoka seam used by the default submit path (tests assert its input). */
  readonly submitMoka?: (input: MokaSubmitInput) => Promise<MokaSubmitResult>;
  /** Submit a child run (defaults to the submitMoka-backed path). */
  readonly submitRun?: (
    request: LoopSubmitRequest
  ) => Effect.Effect<{ readonly workflowName: string }, Error>;
}

/**
 * Build the production `ControllerDeps`. `context` carries the static run
 * context; `seams` overrides any external boundary (used by tests to avoid
 * GitHub / k8s / git).
 */
export function buildControllerDeps(
  context: LoopControllerContext,
  seams: ControllerDepsSeams = {}
): ControllerDeps {
  const gh = seams.gh ?? createGhRunner();
  const generateRunId = seams.generateRunId ?? defaultRunId;
  const submit =
    seams.submitRun ??
    defaultSubmitRun(context, seams.submitMoka ?? submitMoka);
  const loadTasks = seams.loadTasks ?? loadBacklogRecords;
  const gitRefresh = seams.gitRefresh ?? defaultGitRefresh;
  const pollPhase = seams.pollPhase ?? defaultPollPhase;
  const emit = buildEmit(context, seams.postEvent);

  return {
    classifyChecks: (pr, runner) => classifyMergeSignal(pr, runner),
    emit,
    gh,
    loadGraph: () => loadTasks(context.worktreePath),
    maxMergePolls: context.maxMergePolls,
    maxRemediationAttempts: context.maxRemediationAttempts,
    merge: ({ classification, pr }) =>
      mergeForClassification({ classification, gh, pr }),
    pollPhase: (input) =>
      pollPhase({
        namespace: context.namespace,
        runId: input.runId,
        workflowName: input.workflowName,
      }),
    refreshBacklog: () =>
      Effect.tryPromise({
        catch: refreshError,
        try: () => gitRefresh(context.worktreePath),
      }).pipe(Effect.flatMap(() => loadTasks(context.worktreePath))),
    resolvePr: (runId, runner) => resolvePrForRun(runId, runner),
    rootId: context.rootId,
    sleep: (ms) => Effect.sleep(ms),
    strategy: context.strategy,
    submitRun: (input) => adaptSubmit(submit, generateRunId, input),
  };
}

// ---------------------------------------------------------------------------
// classifyChecks — widened seam: MERGED short-circuits, else required checks.
// ---------------------------------------------------------------------------

/**
 * Return "merged" when GitHub reports the PR landed; otherwise delegate to the
 * required-check classifier. The PR-state read is a single `gh pr view` json
 * call; an unparsable response is surfaced (never silently treated as merged).
 */
function classifyMergeSignal(
  pr: OpenPr,
  gh: GhRunner
): Effect.Effect<MergePollSignal, Error> {
  return gh.json(["pr", "view", String(pr.number), "--json", "state"]).pipe(
    Effect.flatMap((raw) => parsePrState(raw)),
    Effect.flatMap((state) =>
      state === "MERGED"
        ? Effect.succeed<MergePollSignal>("merged")
        : classifyRequiredChecks(pr, gh)
    )
  );
}

function parsePrState(raw: unknown): Effect.Effect<string, Error> {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "state" in raw &&
    typeof raw.state === "string"
  ) {
    return Effect.succeed(raw.state);
  }
  return Effect.fail(new Error("gh pr view response missing string `state`"));
}

// ---------------------------------------------------------------------------
// submitRun — adapt SubmitRunInput → submitMoka, forwarding remediation fields.
// ---------------------------------------------------------------------------

function adaptSubmit(
  submit: (
    request: LoopSubmitRequest
  ) => Effect.Effect<{ readonly workflowName: string }, Error>,
  generateRunId: () => string,
  input: SubmitRunInput
): Effect.Effect<SubmitRunResult, Error> {
  const runId = generateRunId();
  return submit({
    deliveryMode: input.deliveryMode,
    headBranch: input.headBranch,
    repositorySha: input.repositorySha,
    runId,
    task: input.ticketId,
  }).pipe(
    Effect.map((result) => ({ runId, workflowName: result.workflowName }))
  );
}

/**
 * Default submit seam: shape a graph submitMoka call. For remediation
 * (`update-existing-pr`) it forwards `delivery.mode`, the PR head sha
 * (`repository.sha`) and the PR branch (`repository.headBranch` =
 * `moka/run/<originalRunId>`) so fix-commits APPEND to the existing PR branch.
 */
function defaultSubmitRun(
  context: LoopControllerContext,
  submit: (input: MokaSubmitInput) => Promise<MokaSubmitResult>
): (
  request: LoopSubmitRequest
) => Effect.Effect<{ readonly workflowName: string }, Error> {
  return (request) =>
    Effect.tryPromise({
      catch: submitError,
      try: () =>
        submit({
          config: context.config,
          delivery: { mode: request.deliveryMode, pullRequest: true },
          eventUrl: context.eventUrl,
          gitCredentialsSecretName: context.gitCredentialsSecretName,
          githubAuthSecretName: context.githubAuthSecretName,
          mode: "full",
          namespace: context.namespace,
          opencodeAuthSecretName: context.opencodeAuthSecretName,
          opencodeOpenaiAccountsSecretName:
            context.opencodeOpenaiAccountsSecretName,
          repository: submitRepository(context, request),
          run: { id: request.runId, project: context.project },
          serviceAccountName: context.serviceAccountName,
          task: request.task,
          type: "graph",
        }),
    }).pipe(Effect.map((result) => ({ workflowName: result.workflowName })));
}

/**
 * Repository context for a child submit. Remediation overrides the head sha and
 * head branch so the workspace IS the PR branch; the create path leaves them
 * absent (the runner cuts a fresh `moka/run/<runId>` branch from baseBranch).
 */
function submitRepository(
  context: LoopControllerContext,
  request: LoopSubmitRequest
): {
  baseBranch: string;
  headBranch?: string;
  sha?: string;
  url: string;
} {
  return {
    baseBranch: context.baseBranch,
    ...(request.headBranch ? { headBranch: request.headBranch } : {}),
    ...(request.repositorySha ? { sha: request.repositorySha } : {}),
    url: context.url,
  };
}

// ---------------------------------------------------------------------------
// emit — wrap the envelope (runId/sequence/at) and POST the loop.* record.
// ---------------------------------------------------------------------------

interface Envelope {
  readonly at: string;
  readonly runId: string;
  readonly sequence: number;
}

/** One owner of LoopControllerEvent → RunnerEventRecord, keyed on event type. */
const RECORD_BUILDER: Readonly<
  Record<
    LoopControllerEvent["type"],
    (event: LoopControllerEvent, envelope: Envelope) => RunnerEventRecord
  >
> = {
  "loop.start": (event, envelope) =>
    event.type === "loop.start"
      ? {
          ...envelope,
          loopStart: { strategy: event.strategy },
          type: "loop.start",
        }
      : unreachable(event),
  "loop.graph.snapshot": (event, envelope) =>
    event.type === "loop.graph.snapshot"
      ? {
          ...envelope,
          loopGraphSnapshot: ticketGraphDtoSchema.parse(event.snapshot),
          type: "loop.graph.snapshot",
        }
      : unreachable(event),
  "loop.node.transition": (event, envelope) =>
    event.type === "loop.node.transition"
      ? {
          ...envelope,
          loopNodeTransition: {
            loopState: event.loopState,
            ticketId: event.ticketId,
          },
          type: "loop.node.transition",
        }
      : unreachable(event),
  "loop.finish": (event, envelope) =>
    event.type === "loop.finish"
      ? {
          ...envelope,
          loopFinish: { blocked: event.blocked, passed: event.passed },
          type: "loop.finish",
        }
      : unreachable(event),
};

function unreachable(event: LoopControllerEvent): never {
  throw new Error(`unexpected loop event for builder: ${event.type}`);
}

function buildEmit(
  context: LoopControllerContext,
  postEvent: ((record: RunnerEventRecord) => Promise<void>) | undefined
): (event: LoopControllerEvent) => Effect.Effect<void, never> {
  const post = postEvent ?? defaultPostEvent(context);
  let sequence = 0;
  return (event) =>
    Effect.promise(() => {
      sequence += 1;
      const record = RECORD_BUILDER[event.type](event, {
        at: new Date().toISOString(),
        runId: context.runId,
        sequence,
      });
      return post(record);
    });
}

/**
 * Default sink: POST the single loop.* record through the authenticated runner
 * event-sink batch endpoint (the same path runtime records use). The records
 * carry the loop.* shapes the console consumes; sequence is monotonic per run.
 */
function defaultPostEvent(
  context: LoopControllerContext
): (record: RunnerEventRecord) => Promise<void> {
  const fetchImpl = globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error("Loop controller event sink requires fetch support");
  }
  return (record) =>
    Effect.runPromise(
      Effect.provide(
        Effect.flatMap(RunnerEventSinkHttpService, (service) =>
          service.postBatch({
            authHeader: context.eventAuthHeader,
            authToken: context.eventAuthToken,
            events: [record],
            fetch: fetchImpl,
            maxRetries: 0,
            retryDelayMs: 250,
            url: context.eventUrl,
          })
        ),
        RunnerEventSinkHttpServiceLive
      )
    );
}

// ---------------------------------------------------------------------------
// Defaults for the remaining seams.
// ---------------------------------------------------------------------------

async function defaultGitRefresh(worktreePath: string): Promise<void> {
  // Fetch then fast-forward main through the authenticated git path so the
  // backlog reload sees freshly-landed tickets. --ff-only never creates a merge
  // commit; a divergence fails loudly rather than silently rewriting history.
  await runAuthenticatedGit(worktreePath, ["fetch", "origin", "main"]);
  await runAuthenticatedGit(worktreePath, [
    "pull",
    "--ff-only",
    "origin",
    "main",
  ]);
}

function defaultPollPhase(input: {
  readonly namespace: string;
  readonly runId: string;
  readonly workflowName: string;
}): Effect.Effect<TerminalPhase, Error> {
  // In-cluster service-account auth (loadFromDefault) — no kubeconfig path.
  return pollWorkflowPhaseUntilTerminal({
    namespace: input.namespace,
    workflowName: input.workflowName,
  }).pipe(Effect.mapError(toError));
}

function defaultRunId(): string {
  return `loop-${randomBytes(8).toString("hex")}`;
}

function refreshError(error: unknown): Error {
  return new Error(`backlog refresh failed: ${messageOf(error)}`);
}

function submitError(error: unknown): Error {
  return new Error(`child run submit failed: ${messageOf(error)}`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
