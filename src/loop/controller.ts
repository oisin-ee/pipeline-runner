import { Effect } from "effect";
import type { BacklogTaskRecord } from "../tickets/backlog-task-store";
import {
  buildTicketGraphEffect,
  type TicketGraph,
} from "../tickets/ticket-graph";
import type { LoopState } from "../tickets/ticket-graph-dto";
import { serializeTicketGraph } from "../tickets/ticket-graph-dto";
import { selectNextTicket } from "../tickets/ticket-selection";
import type { CheckClassification, GhRunner, PrResolution } from "./gh-checks";
import type { MergeOutcome } from "./merge";

// ===========================================================================
// PIPE-88.7 — Loop traversal state machine (controller core, headless)
//
// Every external effect is an INJECTED seam (ControllerDeps). The loop body
// imports NO real network / k8s / git — only pure graph + selection helpers
// and the type-level shape of the injected boundaries. The integration test
// drives a deterministic chain by faking ControllerDeps end to end.
// ===========================================================================

type OpenPr = Extract<PrResolution, { found: true }>;

/** Terminal Argo phase the loop reacts to (mirrors argo-poll's TerminalPhase). */
export type TerminalPhase = "Succeeded" | "Failed" | "Error";

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
  readonly emit: (event: LoopControllerEvent) => Effect.Effect<void, never>;
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
  ) => Effect.Effect<MergeOutcome | null, Error>;
  /** Poll the child workflow until terminal (Succeeded / Failed / Error). */
  readonly pollPhase: (input: {
    readonly workflowName: string;
    readonly runId: string;
  }) => Effect.Effect<TerminalPhase, Error>;
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
  /** Clock seam — bounded idle-wait between merge polls. */
  readonly sleep: (ms: number) => Effect.Effect<void, never>;
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
  | { readonly type: "loop.start"; readonly strategy: string }
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
  merged: { kind: "passed" },
  fixable: { kind: "remediate" },
  "infra-down": { kind: "admin-merge" },
  indeterminate: { kind: "wait" },
};

// ---------------------------------------------------------------------------
// Node lifecycle resolution — a node ends in exactly one terminal loop state.
// ---------------------------------------------------------------------------

/** A per-ticket resolution: the terminal loop state it reached. */
type NodeResolution = "passed" | "blocked";

const PASSED: NodeResolution = "passed";
const BLOCKED: NodeResolution = "blocked";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runLoopController(
  deps: ControllerDeps
): Effect.Effect<LoopSummary, Error> {
  return Effect.gen(function* () {
    const initialTasks = yield* deps.loadGraph();
    const graph = yield* buildTicketGraphEffect([...initialTasks]).pipe(
      Effect.mapError((error) => new Error(error.message))
    );

    yield* deps.emit({ type: "loop.start", strategy: "bfs" });
    const snapshot = yield* serializeTicketGraph(graph);
    yield* deps.emit({ type: "loop.graph.snapshot", snapshot });

    const summary = yield* drain(deps, [...initialTasks]);

    yield* deps.emit({
      type: "loop.finish",
      passed: summary.passed,
      blocked: summary.blocked,
    });
    return summary;
  });
}

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
  readonly tasks: readonly BacklogTaskRecord[];
}

function drain(
  deps: ControllerDeps,
  tasks: readonly BacklogTaskRecord[]
): Effect.Effect<LoopSummary, Error> {
  return drainStep(deps, { passed: new Set(), blocked: new Set(), tasks });
}

function drainStep(
  deps: ControllerDeps,
  state: DrainState
): Effect.Effect<LoopSummary, Error> {
  return Effect.gen(function* () {
    const next = yield* selectReadyExcluding(state);
    if (next === undefined) {
      return { passed: state.passed.size, blocked: state.blocked.size };
    }

    const resolution = yield* resolveTicket(deps, next.id);

    if (resolution === PASSED) {
      const refreshed = yield* deps.refreshBacklog();
      return yield* drainStep(deps, {
        passed: withId(state.passed, next.id),
        blocked: state.blocked,
        tasks: [...refreshed],
      });
    }

    return yield* drainStep(deps, {
      passed: state.passed,
      blocked: withId(state.blocked, next.id),
      tasks: state.tasks,
    });
  });
}

/**
 * Build the graph from current records and select the next ready ticket,
 * skipping any id already in the passed- or blocked-overlay. The passed
 * overlay is the durable source of truth: a stale backlog cannot re-surface a
 * ticket whose run already passed.
 */
function selectReadyExcluding(
  state: DrainState
): Effect.Effect<BacklogTaskRecord | undefined, Error> {
  return buildTicketGraphEffect([...state.tasks]).pipe(
    Effect.mapError((error) => new Error(error.message)),
    Effect.map((graph) =>
      selectReadyChain(overlayGraph(graph, state.passed), state)
    )
  );
}

/**
 * Overlay the passed-set onto a fresh graph by marking passed tickets Done.
 * selectNextTicket's readiness treats a dependency as satisfied iff its status
 * is "Done"; marking passed tickets Done makes their dependents become ready
 * without mutating the original records. Returns a NEW graph view.
 */
function overlayGraph(
  graph: TicketGraph,
  passed: ReadonlySet<string>
): TicketGraph {
  if (passed.size === 0) {
    return graph;
  }
  const overlaidTasks = [...graph.tasksById.values()].map(
    (task): BacklogTaskRecord =>
      passed.has(task.id) ? { ...task, status: "Done" } : task
  );
  return overlaidGraphFromTasks(graph, overlaidTasks);
}

/**
 * Rebuild a TicketGraph-shaped view from overlaid records. The dependency graph
 * edges are unchanged by a status flip, so we reuse the original dependencyGraph
 * and only swap the tasksById / childrenByParentId indexes that selection reads.
 */
function overlaidGraphFromTasks(
  graph: TicketGraph,
  overlaidTasks: readonly BacklogTaskRecord[]
): TicketGraph {
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
}

/**
 * Select the next genuinely-actionable ready ticket, skipping ids already in
 * the passed/blocked overlay (a blocked ticket stays "To Do" in records but
 * must not be retried within this run).
 */
function selectReadyChain(
  graph: TicketGraph,
  state: DrainState
): BacklogTaskRecord | undefined {
  const candidate = selectNextTicket(graph, { strategy: "bfs" });
  if (candidate === undefined) {
    return;
  }
  if (state.passed.has(candidate.id)) {
    return selectAfterSkip(graph, state, candidate.id);
  }
  if (state.blocked.has(candidate.id)) {
    return selectAfterSkip(graph, state, candidate.id);
  }
  return candidate;
}

/**
 * The top candidate is already resolved (passed or blocked). Drop it from a
 * throwaway overlay so the next-best ready ticket surfaces. A blocked node's
 * true dependents remain unready because the blocked node is only removed from
 * THIS local selection view, never marked Done in the durable passed-set.
 */
function selectAfterSkip(
  graph: TicketGraph,
  state: DrainState,
  skipId: string
): BacklogTaskRecord | undefined {
  const remaining = [...graph.tasksById.values()].filter(
    (task) => task.id !== skipId
  );
  if (remaining.length === graph.tasksById.size) {
    return;
  }
  return selectReadyChain(overlaidGraphFromTasks(graph, remaining), state);
}

function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  next.add(id);
  return next;
}

// ---------------------------------------------------------------------------
// Per-ticket resolution — running -> (poll pipeline) -> merging -> passed/blocked.
// ---------------------------------------------------------------------------

function resolveTicket(
  deps: ControllerDeps,
  ticketId: string
): Effect.Effect<NodeResolution, Error> {
  return Effect.gen(function* () {
    yield* transition(deps, ticketId, "running");
    const run = yield* deps.submitRun({
      ticketId,
      deliveryMode: "create-new-pr",
    });
    const phase = yield* deps.pollPhase({
      workflowName: run.workflowName,
      runId: run.runId,
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
      ticketId,
      runId: run.runId,
      pr: resolution,
      remediationAttempts: 0,
      mergePolls: 0,
    });
  });
}

interface MergeLoopState {
  readonly mergePolls: number;
  readonly pr: OpenPr;
  readonly remediationAttempts: number;
  readonly runId: string;
  readonly ticketId: string;
}

/**
 * Inner merge-resolution loop. Each iteration classifies the PR's required
 * checks and dispatches on the signal via POLL_ACTION (the single owner). The
 * handlers advance bounded counters; exhaustion is the only path to blocked.
 */
function resolveMerge(
  deps: ControllerDeps,
  state: MergeLoopState
): Effect.Effect<NodeResolution, Error> {
  return Effect.gen(function* () {
    const signal = yield* deps.classifyChecks(state.pr, deps.gh);
    return yield* dispatchPollAction(deps, state, POLL_ACTION[signal]);
  });
}

/**
 * Handler table keyed on the poll action kind — the single owner of the inner
 * resolution dispatch. Each handler returns the node's next Effect; there is no
 * branch ladder.
 */
const POLL_HANDLER: Readonly<
  Record<
    PollAction["kind"],
    (
      deps: ControllerDeps,
      state: MergeLoopState
    ) => Effect.Effect<NodeResolution, Error>
  >
> = {
  passed: (deps, state) => passNode(deps, state.ticketId),
  "admin-merge": (deps, state) => adminMergeNode(deps, state),
  remediate: (deps, state) => remediateNode(deps, state),
  wait: (deps, state) => waitNode(deps, state),
};

function dispatchPollAction(
  deps: ControllerDeps,
  state: MergeLoopState,
  action: PollAction
): Effect.Effect<NodeResolution, Error> {
  return POLL_HANDLER[action.kind](deps, state);
}

function passNode(
  deps: ControllerDeps,
  ticketId: string
): Effect.Effect<NodeResolution, Error> {
  return transition(deps, ticketId, "passed").pipe(Effect.map(() => PASSED));
}

function adminMergeNode(
  deps: ControllerDeps,
  state: MergeLoopState
): Effect.Effect<NodeResolution, Error> {
  return Effect.gen(function* () {
    const outcome = yield* deps.merge({
      classification: "infra-down",
      pr: state.pr,
    });
    if (outcome !== null && outcome._tag === "merged") {
      return yield* passNode(deps, state.ticketId);
    }
    // Admin-merge could not land (missing token / conflict) → blocked, surfaced.
    return yield* blockNode(deps, state.ticketId);
  });
}

function remediateNode(
  deps: ControllerDeps,
  state: MergeLoopState
): Effect.Effect<NodeResolution, Error> {
  return Effect.gen(function* () {
    if (state.remediationAttempts >= deps.maxRemediationAttempts) {
      return yield* blockNode(deps, state.ticketId);
    }
    // Submit a remediation child run in update-existing-pr mode. The workspace
    // MUST be the PR branch (moka/run/<originalRunId>) at the PR head sha so
    // fix-commits APPEND — the open-pull-request builtin owns no basing.
    yield* deps.submitRun({
      ticketId: state.ticketId,
      deliveryMode: "update-existing-pr",
      repositorySha: state.pr.headRefName,
      headBranch: `moka/run/${state.runId}`,
    });
    return yield* resolveMerge(deps, {
      ...state,
      remediationAttempts: state.remediationAttempts + 1,
    });
  });
}

function waitNode(
  deps: ControllerDeps,
  state: MergeLoopState
): Effect.Effect<NodeResolution, Error> {
  return Effect.gen(function* () {
    if (state.mergePolls >= deps.maxMergePolls) {
      // Bounded wait exhausted with no positive signal → blocked. NEVER merge
      // an indeterminate state.
      return yield* blockNode(deps, state.ticketId);
    }
    yield* deps.sleep(MERGE_POLL_INTERVAL_MS);
    return yield* resolveMerge(deps, {
      ...state,
      mergePolls: state.mergePolls + 1,
    });
  });
}

const MERGE_POLL_INTERVAL_MS = 5000;

function blockNode(
  deps: ControllerDeps,
  ticketId: string
): Effect.Effect<NodeResolution, Error> {
  return transition(deps, ticketId, "blocked").pipe(Effect.map(() => BLOCKED));
}

function transition(
  deps: ControllerDeps,
  ticketId: string,
  loopState: LoopState
): Effect.Effect<void, never> {
  return deps.emit({ type: "loop.node.transition", ticketId, loopState });
}
