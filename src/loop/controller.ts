import { Effect, Option } from "effect";

import type { BacklogTaskRecord } from "../tickets/backlog-task-store";
import { buildTicketGraphEffect } from "../tickets/ticket-graph";
import type { TicketGraph } from "../tickets/ticket-graph";
import type { LoopState } from "../tickets/ticket-graph-dto";
import { serializeTicketGraph } from "../tickets/ticket-graph-dto";
import type { TicketSelectionStrategy } from "../tickets/ticket-selection";
import { selectNextTicket } from "../tickets/ticket-selection";
import type { TerminalPhase } from "./argo-poll";
import type { CheckClassification, GhRunner, PrResolution } from "./gh-checks";
import type { MergeOutcome } from "./merge";

// The loop reacts to the same terminal Argo phases the poller reports — argo-poll
// is the single owner of that type; re-export it so loop consumers have one import.
export type { TerminalPhase } from "./argo-poll";

// ===========================================================================
// PIPE-88.7 — Loop traversal state machine (controller core, headless)
//
// Every external effect is an INJECTED seam (ControllerDeps). The loop body
// imports NO real network / k8s / git — only pure graph + selection helpers
// and the type-level shape of the injected boundaries. The integration test
// drives a deterministic chain by faking ControllerDeps end to end.
// ===========================================================================

type OpenPr = Extract<PrResolution, { found: true }>;

// ---------------------------------------------------------------------------
// Injected effect boundaries
// ---------------------------------------------------------------------------

/** Inputs to launch a child run. The submit seam owns the moka-submit wiring. */
export interface SubmitRunInput {
  /** "create-new-pr" for the first attempt, "update-existing-pr" for fixes. */
  readonly deliveryMode: "create-new-pr" | "update-existing-pr";
  readonly headBranch?: string;
  /**
   * For remediation (update-existing-pr): the PR head sha and the PR branch
   * (`moka/run/<originalRunId>`). The open-pull-request builtin owns no basing,
   * so the remediation workspace MUST already be the PR branch for fix-commits
   * to APPEND. Absent on the initial create-new-pr submit.
   */
  readonly repositorySha?: string;
  readonly ticketId: string;
}

/** Identity of a launched child run. */
export interface SubmitRunResult {
  readonly runId: string;
  readonly workflowName: string;
}

/** Decision input handed to the injected merge seam (reuses merge.ts shape). */
export interface MergeInput {
  readonly classification: CheckClassification;
  readonly pr: OpenPr;
}

/**
 * Single bundle of injected effects. No member resolves a real resource inside
 * the loop body — production wires submitMoka / pollWorkflowPhaseUntilTerminal /
 * git refresh at the edge; tests inject deterministic fakes.
 */
export interface ControllerDeps {
  /** Classify required-check state for the PR. */
  readonly classifyChecks: (
    pr: OpenPr,
    gh: GhRunner
  ) => Effect.Effect<MergePollSignal, Error>;
  /** Emit a loop.* lifecycle event. */
  readonly emit: (event: LoopControllerEvent) => Effect.Effect<void>;
  /** Raw gh runner passed to resolvePr / classifyChecks. */
  readonly gh: GhRunner;
  /** Load the backlog task records for the initial graph build. */
  readonly loadGraph: () => Effect.Effect<readonly BacklogTaskRecord[], Error>;
  /** Bounded merge polls before an indeterminate PR is declared blocked. */
  readonly maxMergePolls: number;
  /** Bounded remediation submits before a fixable PR is declared blocked. */
  readonly maxRemediationAttempts: number;
  /** Perform the merge action for a classification (admin-merge for infra-down). */
  readonly merge: (
    input: MergeInput
  ) => Effect.Effect<Option.Option<MergeOutcome>, Error>;
  /** Poll the child workflow until terminal (Succeeded / Failed / Error). */
  readonly pollPhase: (input: {
    readonly workflowName: string;
    readonly runId: string;
  }) => Effect.Effect<TerminalPhase, Error>;
  /** Project id from the runner payload; emitted for console run association. */
  readonly projectId: string;
  /** Git-refresh the backlog from main after a ticket passes; returns fresh records. */
  readonly refreshBacklog: () => Effect.Effect<
    readonly BacklogTaskRecord[],
    Error
  >;
  /** Resolve the open PR for a run id (`moka/run/<runId>` head branch). */
  readonly resolvePr: (
    runId: string,
    gh: GhRunner
  ) => Effect.Effect<PrResolution, Error>;
  /** Optional epic/root scope: traversal is restricted to this subtree. */
  readonly rootId?: string;
  /** Clock seam — bounded idle-wait between merge polls. */
  readonly sleep: (ms: number) => Effect.Effect<void>;
  /** Ready-ticket ordering strategy at the selection call site. */
  readonly strategy: TicketSelectionStrategy;
  /** Launch a child run (create-new-pr or update-existing-pr). */
  readonly submitRun: (
    input: SubmitRunInput
  ) => Effect.Effect<SubmitRunResult, Error>;
}

// ---------------------------------------------------------------------------
// Emitted events — mirror the loop.* runner-event shapes (envelope-free; the
// edge wraps these with runId/sequence/at when POSTing to the event sink).
// ---------------------------------------------------------------------------

export type LoopControllerEvent =
  | {
      readonly type: "loop.start";
      readonly projectId: string;
      readonly strategy: string;
    }
  | { readonly type: "loop.graph.snapshot"; readonly snapshot: unknown }
  | {
      readonly type: "loop.node.transition";
      readonly ticketId: string;
      readonly loopState: LoopState;
    }
  | {
      readonly type: "loop.finish";
      readonly passed: number;
      readonly blocked: number;
    };

/** Final tally returned to the caller. */
export interface LoopSummary {
  readonly blocked: number;
  readonly passed: number;
}

// ---------------------------------------------------------------------------
// Per-ticket merge-poll signal — ONE owner of the inner resolution variation.
//
// The merge poll observes either "merged" (the PR landed) or one of the
// CheckClassification values from gh-checks. A dispatch table maps each signal
// to a typed resolution; there is no nested if/else ladder.
// ---------------------------------------------------------------------------

export type MergePollSignal = "merged" | CheckClassification;

/** What the inner poll loop should do next for a given signal. */
type PollAction =
  | { readonly kind: "passed" }
  | { readonly kind: "remediate" }
  | { readonly kind: "admin-merge" }
  | { readonly kind: "wait" };

const POLL_ACTION: Readonly<Record<MergePollSignal, PollAction>> = {
  fixable: { kind: "remediate" },
  indeterminate: { kind: "wait" },
  "infra-down": { kind: "admin-merge" },
  merged: { kind: "passed" },
};

// ---------------------------------------------------------------------------
// Node lifecycle resolution — a node ends in exactly one terminal loop state.
// ---------------------------------------------------------------------------

/** A per-ticket resolution: the terminal loop state it reached. */
type NodeResolution = "passed" | "blocked";

const PASSED: NodeResolution = "passed";
const BLOCKED: NodeResolution = "blocked";

// ---------------------------------------------------------------------------
// Outer drain — strict sequential traversal with a passed/blocked overlay.
//
// Readiness derives from the CURRENT task records plus an in-memory passed-set
// (so a ticket whose run already passed is never re-selected even if the
// backlog .md is stale) and a blocked-set (so a permanently blocked ticket is
// not retried in the same loop run). The graph is rebuilt from records; it is
// never mutated in place.
// ---------------------------------------------------------------------------

interface DrainState {
  readonly blocked: ReadonlySet<string>;
  readonly passed: ReadonlySet<string>;
  /** Selection scope/order carried so traversal honours the configured strategy. */
  readonly selection: SelectionOptions;
  readonly tasks: readonly BacklogTaskRecord[];
}

/** The selection knobs forwarded to selectNextTicket on every drain step. */
interface SelectionOptions {
  readonly rootId?: string;
  readonly strategy: TicketSelectionStrategy;
}

/**
 * Rebuild a TicketGraph-shaped view from overlaid records. The dependency graph
 * edges are unchanged by a status flip, so we reuse the original dependencyGraph
 * and only swap the tasksById / childrenByParentId indexes that selection reads.
 */
const overlaidGraphFromTasks = (
  graph: TicketGraph,
  overlaidTasks: readonly BacklogTaskRecord[]
): TicketGraph => {
  const tasksById = new Map<string, BacklogTaskRecord>();
  for (const task of overlaidTasks) {
    tasksById.set(task.id, task);
  }
  const childrenByParentId = new Map<string, BacklogTaskRecord[]>();
  for (const task of overlaidTasks) {
    if (task.parentTaskId === undefined) {
      continue;
    }
    const siblings = childrenByParentId.get(task.parentTaskId) ?? [];
    siblings.push(task);
    childrenByParentId.set(task.parentTaskId, siblings);
  }
  return {
    childrenByParentId,
    danglingDependencies: graph.danglingDependencies,
    dependencyGraph: graph.dependencyGraph,
    tasksById,
  };
};

/**
 * Overlay the passed-set onto a fresh graph by marking passed tickets Done.
 * selectNextTicket's readiness treats a dependency as satisfied iff its status
 * is "Done"; marking passed tickets Done makes their dependents become ready
 * without mutating the original records. Returns a NEW graph view.
 */
const overlayGraph = (
  graph: TicketGraph,
  passed: ReadonlySet<string>
): TicketGraph => {
  if (passed.size === 0) {
    return graph;
  }
  const overlaidTasks = [...graph.tasksById.values()].map(
    (task): BacklogTaskRecord =>
      passed.has(task.id) ? { ...task, status: "Done" } : task
  );
  return overlaidGraphFromTasks(graph, overlaidTasks);
};

/**
 * Select the next genuinely-actionable ready ticket, skipping ids already in
 * the passed/blocked overlay (a blocked ticket stays "To Do" in records but
 * must not be retried within this run).
 */
const selectReadyChain = (
  graph: TicketGraph,
  state: DrainState
): Option.Option<BacklogTaskRecord> => {
  /**
   * The top candidate is already resolved (passed or blocked). Drop it from a
   * throwaway overlay so the next-best ready ticket surfaces. A blocked node's
   * true dependents remain unready because the blocked node is only removed from
   * THIS local selection view, never marked Done in the durable passed-set.
   */
  const selectAfterSkip = (
    skipId: string
  ): Option.Option<BacklogTaskRecord> => {
    const remaining = [...graph.tasksById.values()].filter(
      (task) => task.id !== skipId
    );
    if (remaining.length === graph.tasksById.size) {
      return Option.none();
    }
    return selectReadyChain(overlaidGraphFromTasks(graph, remaining), state);
  };

  const candidate = selectNextTicket(graph, {
    rootId: state.selection.rootId,
    strategy: state.selection.strategy,
  });
  if (Option.isNone(candidate)) {
    return Option.none();
  }
  if (state.passed.has(candidate.value.id)) {
    return selectAfterSkip(candidate.value.id);
  }
  if (state.blocked.has(candidate.value.id)) {
    return selectAfterSkip(candidate.value.id);
  }
  return candidate;
};

const ticketGraphError = (error: { readonly message: string }): Error =>
  new Error(error.message);

/**
 * Build the graph from current records and select the next ready ticket,
 * skipping any id already in the passed- or blocked-overlay. The passed
 * overlay is the durable source of truth: a stale backlog cannot re-surface a
 * ticket whose run already passed.
 */
const selectReadyExcluding = (
  state: DrainState
): Effect.Effect<Option.Option<BacklogTaskRecord>, Error> =>
  buildTicketGraphEffect([...state.tasks]).pipe(
    Effect.mapError(ticketGraphError),
    Effect.map((graph) =>
      selectReadyChain(overlayGraph(graph, state.passed), state)
    )
  );

const withId = (set: ReadonlySet<string>, id: string): ReadonlySet<string> =>
  new Set([...set, id]);

interface MergeLoopState {
  readonly mergePolls: number;
  readonly pr: OpenPr;
  readonly remediationAttempts: number;
  readonly runId: string;
  readonly ticketId: string;
}

type MergePollDecision =
  | { readonly kind: "continue"; readonly state: MergeLoopState }
  | { readonly kind: "done"; readonly resolution: NodeResolution };

type PollHandlerTable = Readonly<
  Record<
    PollAction["kind"],
    (
      deps: ControllerDeps,
      state: MergeLoopState
    ) => Effect.Effect<MergePollDecision, Error>
  >
>;

const MERGE_POLL_INTERVAL_MS = 5000;

const transition = (
  deps: ControllerDeps,
  ticketId: string,
  loopState: LoopState
): Effect.Effect<void> =>
  deps.emit({ loopState, ticketId, type: "loop.node.transition" });

const passNode = (
  deps: ControllerDeps,
  ticketId: string
): Effect.Effect<NodeResolution, Error> =>
  transition(deps, ticketId, "passed").pipe(Effect.map(() => PASSED));

const blockNode = (
  deps: ControllerDeps,
  ticketId: string
): Effect.Effect<NodeResolution, Error> =>
  transition(deps, ticketId, "blocked").pipe(Effect.map(() => BLOCKED));

const doneDecision = (resolution: NodeResolution): MergePollDecision => ({
  kind: "done",
  resolution,
});

const continueDecision = (state: MergeLoopState): MergePollDecision => ({
  kind: "continue",
  state,
});

const adminMergeNode = (
  deps: ControllerDeps,
  state: MergeLoopState
): Effect.Effect<MergePollDecision, Error> =>
  Effect.gen(function* effectBody() {
    const outcome = yield* deps.merge({
      classification: "infra-down",
      pr: state.pr,
    });
    if (Option.isSome(outcome) && outcome.value._tag === "merged") {
      const resolution = yield* passNode(deps, state.ticketId);
      return doneDecision(resolution);
    }
    // Admin-merge could not land (missing token / conflict) → blocked, surfaced.
    const resolution = yield* blockNode(deps, state.ticketId);
    return doneDecision(resolution);
  });

const remediateNode = (
  deps: ControllerDeps,
  state: MergeLoopState
): Effect.Effect<MergePollDecision, Error> =>
  Effect.gen(function* effectBody() {
    if (state.remediationAttempts >= deps.maxRemediationAttempts) {
      const resolution = yield* blockNode(deps, state.ticketId);
      return doneDecision(resolution);
    }
    // Submit a remediation child run in update-existing-pr mode. The workspace
    // MUST be the PR branch (moka/run/<originalRunId>) at the PR head sha so
    // fix-commits APPEND — the open-pull-request builtin owns no basing.
    yield* deps.submitRun({
      deliveryMode: "update-existing-pr",
      headBranch: `moka/run/${state.runId}`,
      repositorySha: state.pr.headRefName,
      ticketId: state.ticketId,
    });
    return continueDecision({
      ...state,
      remediationAttempts: state.remediationAttempts + 1,
    });
  });

const waitNode = (
  deps: ControllerDeps,
  state: MergeLoopState
): Effect.Effect<MergePollDecision, Error> =>
  Effect.gen(function* effectBody() {
    if (state.mergePolls >= deps.maxMergePolls) {
      // Bounded wait exhausted with no positive signal → blocked. NEVER merge
      // an indeterminate state.
      const resolution = yield* blockNode(deps, state.ticketId);
      return doneDecision(resolution);
    }
    yield* deps.sleep(MERGE_POLL_INTERVAL_MS);
    return continueDecision({
      ...state,
      mergePolls: state.mergePolls + 1,
    });
  });

/**
 * Handler table keyed on the poll action kind — the single owner of the inner
 * resolution dispatch. Each handler returns the node's next Effect; there is no
 * branch ladder.
 */
const pollHandlers: PollHandlerTable = {
  "admin-merge": (deps, state) => adminMergeNode(deps, state),
  passed: (deps, state) =>
    passNode(deps, state.ticketId).pipe(Effect.map(doneDecision)),
  remediate: (deps, state) => remediateNode(deps, state),
  wait: (deps, state) => waitNode(deps, state),
};

const dispatchPollAction = (
  deps: ControllerDeps,
  state: MergeLoopState,
  action: PollAction
): Effect.Effect<MergePollDecision, Error> =>
  pollHandlers[action.kind](deps, state);

/**
 * Inner merge-resolution loop. Each iteration classifies the PR's required
 * checks and dispatches on the signal via POLL_ACTION (the single owner). The
 * handlers advance bounded counters; exhaustion is the only path to blocked.
 */
const resolveMerge = (
  deps: ControllerDeps,
  state: MergeLoopState
): Effect.Effect<NodeResolution, Error> =>
  Effect.gen(function* effectBody() {
    const signal = yield* deps.classifyChecks(state.pr, deps.gh);
    const decision = yield* dispatchPollAction(
      deps,
      state,
      POLL_ACTION[signal]
    );
    if (decision.kind === "done") {
      return decision.resolution;
    }
    return yield* resolveMerge(deps, decision.state);
  });

// ---------------------------------------------------------------------------
// Per-ticket resolution — running -> (poll pipeline) -> merging -> passed/blocked.
// ---------------------------------------------------------------------------

const resolveTicket = (
  deps: ControllerDeps,
  ticketId: string
): Effect.Effect<NodeResolution, Error> =>
  Effect.gen(function* effectBody() {
    yield* transition(deps, ticketId, "running");
    const run = yield* deps.submitRun({
      deliveryMode: "create-new-pr",
      ticketId,
    });
    const phase = yield* deps.pollPhase({
      runId: run.runId,
      workflowName: run.workflowName,
    });

    if (phase !== "Succeeded") {
      // Failed / Error pipeline → blocked; no PR resolution attempted.
      return yield* blockNode(deps, ticketId);
    }

    const resolution = yield* deps.resolvePr(run.runId, deps.gh);
    if (!resolution.found) {
      return yield* blockNode(deps, ticketId);
    }

    yield* transition(deps, ticketId, "merging");
    // Arm GitHub auto-merge. The injected merge seam returns null on the
    // fixable (non-admin) arming path; GitHub holds the PR until CI is green,
    // and the merge-poll loop below observes the landing.
    yield* deps.merge({ classification: "fixable", pr: resolution });

    return yield* resolveMerge(deps, {
      mergePolls: 0,
      pr: resolution,
      remediationAttempts: 0,
      runId: run.runId,
      ticketId,
    });
  });

const drainStep = (
  deps: ControllerDeps,
  state: DrainState
): Effect.Effect<LoopSummary, Error> =>
  Effect.gen(function* effectBody() {
    const next = yield* selectReadyExcluding(state);
    if (Option.isNone(next)) {
      return { blocked: state.blocked.size, passed: state.passed.size };
    }

    const resolution = yield* resolveTicket(deps, next.value.id);

    if (resolution === PASSED) {
      const refreshed = yield* deps.refreshBacklog();
      return yield* drainStep(deps, {
        blocked: state.blocked,
        passed: withId(state.passed, next.value.id),
        selection: state.selection,
        tasks: [...refreshed],
      });
    }

    return yield* drainStep(deps, {
      blocked: withId(state.blocked, next.value.id),
      passed: state.passed,
      selection: state.selection,
      tasks: state.tasks,
    });
  });

const drain = (
  deps: ControllerDeps,
  tasks: readonly BacklogTaskRecord[]
): Effect.Effect<LoopSummary, Error> =>
  drainStep(deps, {
    blocked: new Set(),
    passed: new Set(),
    selection: { rootId: deps.rootId, strategy: deps.strategy },
    tasks,
  });

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const runLoopController = (
  deps: ControllerDeps
): Effect.Effect<LoopSummary, Error> =>
  Effect.gen(function* effectBody() {
    const initialTasks = yield* deps.loadGraph();
    const graph = yield* buildTicketGraphEffect([...initialTasks]).pipe(
      Effect.mapError(ticketGraphError)
    );

    yield* deps.emit({
      projectId: deps.projectId,
      strategy: deps.strategy,
      type: "loop.start",
    });
    const snapshot = yield* serializeTicketGraph(graph);
    yield* deps.emit({ snapshot, type: "loop.graph.snapshot" });

    const summary = yield* drain(deps, [...initialTasks]);

    yield* deps.emit({
      blocked: summary.blocked,
      passed: summary.passed,
      type: "loop.finish",
    });
    return summary;
  });
