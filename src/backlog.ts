// fallow-ignore-file unused-file
import { Effect } from "effect";
import {
  BacklogParseError,
  BacklogService,
  BacklogServiceLive,
} from "./runtime/services/backlog-service";

const PHASES = [
  { suffix: "R", label: "research", deps: [] as string[] },
  { suffix: "TW", label: "test-write", deps: ["R"] },
  { suffix: "CW", label: "implement", deps: ["TW"] },
  { suffix: "V", label: "verify", deps: ["CW"] },
  { suffix: "L", label: "learn", deps: ["V"] },
] as const;

export type BacklogStatus = "To Do" | "In Progress" | "Done";
export type PhaseSuffix = (typeof PHASES)[number]["suffix"];

export interface GateFailure {
  evidence: string[];
  gate: "RESEARCH" | "RED" | "GREEN" | "VERIFY" | "LEARN";
  reason: string;
}

export interface PipelineLifecycleResult {
  failureDetails: GateFailure[];
  outcome: "PASS" | "FAIL";
}

export interface PhaseStatusUpdate {
  status: BacklogStatus;
  taskId: string;
}

export interface PhaseLifecyclePlan {
  failureNote?: {
    note: string;
    taskId: string;
  };
  statusUpdates: PhaseStatusUpdate[];
}

/**
 * Map of phase suffix → real backlog task id assigned by `backlog task create`.
 * Returned by {@link createSwarmTasks}; consumed by
 * {@link applyPhaseLifecycle} and {@link planPhaseLifecycle}.
 */
export interface SwarmTaskMap {
  /** ID of the parent task that owns the 5 phase tasks. */
  parentId: string;
  /** Real (backlog-assigned) IDs of the per-phase child tasks. */
  phases: Record<PhaseSuffix, string>;
}

const GATE_PHASES: Record<GateFailure["gate"], PhaseSuffix> = {
  GREEN: "CW",
  LEARN: "L",
  RESEARCH: "R",
  RED: "TW",
  VERIFY: "V",
};

/**
 * `backlog task create` (with `--plain`) prints `Task <PREFIX>-<id> - <title>`
 * on the second non-blank line. We accept custom all-caps Backlog prefixes and
 * subtask ids like `PIPE-3.1`.
 */
const TASK_ID_RE = /^Task\s+([A-Z]+-[\w.]+)\b/m;

function parseTaskId(stdout: string): string | null {
  const m = TASK_ID_RE.exec(stdout);
  return m ? m[1] : null;
}

function parseTaskIdEffect(
  stdout: string,
  failureMessage: string
): Effect.Effect<string, BacklogParseError> {
  const taskId = parseTaskId(stdout);
  return taskId
    ? Effect.succeed(taskId)
    : Effect.fail(new BacklogParseError({ message: failureMessage }));
}

function createParentArgs(taskDescription: string): string[] {
  return [
    "task",
    "create",
    taskDescription,
    "--labels",
    "swarm-parent",
    "--plain",
  ];
}

function createChildArgs(
  taskDescription: string,
  parentId: string,
  phase: (typeof PHASES)[number]
): string[] {
  return [
    "task",
    "create",
    `${taskDescription} — ${phase.label}`,
    "--parent",
    parentId,
    "--labels",
    `swarm,phase-${phase.suffix}`,
    "--plain",
  ];
}

function runBacklogEffect(
  args: readonly string[],
  cwd: string
): Effect.Effect<string, never, BacklogService> {
  return Effect.gen(function* () {
    const backlog = yield* BacklogService;
    return yield* backlog
      .run(args, cwd)
      .pipe(Effect.catchAll((error) => Effect.succeed(error.stdout)));
  });
}

function parseParentId(
  stdout: string
): Effect.Effect<string, BacklogParseError> {
  return parseTaskIdEffect(
    stdout,
    `createSwarmTasks: could not parse parent task id from backlog output: ${stdout.slice(0, 200)}`
  );
}

function parseChildId(
  stdout: string,
  phase: PhaseSuffix
): Effect.Effect<string, BacklogParseError> {
  return parseTaskIdEffect(
    stdout,
    `createSwarmTasks: could not parse ${phase} child task id from backlog output: ${stdout.slice(0, 200)}`
  );
}

function createSwarmTasksEffect(
  taskDescription: string,
  worktreePath: string
): Effect.Effect<SwarmTaskMap, BacklogParseError, BacklogService> {
  return Effect.gen(function* () {
    const parentOut = yield* runBacklogEffect(
      createParentArgs(taskDescription),
      worktreePath
    );
    const parentId = yield* parseParentId(parentOut);
    const phases: Partial<Record<PhaseSuffix, string>> = {};
    for (const phase of PHASES) {
      const childOut = yield* runBacklogEffect(
        createChildArgs(taskDescription, parentId, phase),
        worktreePath
      );
      phases[phase.suffix] = yield* parseChildId(childOut, phase.suffix);
    }
    return { parentId, phases: phases as Record<PhaseSuffix, string> };
  });
}

function markPhaseEffect(
  taskId: string,
  status: BacklogStatus,
  worktreePath: string
): Effect.Effect<void, never, BacklogService> {
  return Effect.gen(function* () {
    yield* runBacklogEffect(
      ["task", "edit", taskId, "--status", status],
      worktreePath
    );
  });
}

/**
 * Create a parent task plus one child task per phase via the `backlog` CLI.
 *
 * `backlog task create` does NOT accept a positional task id (the positional
 * is the title; ids are auto-assigned), so we parse the assigned id out of
 * `backlog`'s stdout and return the resulting map.
 */
export async function createSwarmTasks(
  taskDescription: string,
  worktreePath: string
): Promise<SwarmTaskMap> {
  return await Effect.runPromise(
    Effect.provide(
      createSwarmTasksEffect(taskDescription, worktreePath),
      BacklogServiceLive
    )
  );
}

export async function markPhase(
  taskId: string,
  status: BacklogStatus,
  worktreePath: string
): Promise<void> {
  await Effect.runPromise(
    Effect.provide(
      markPhaseEffect(taskId, status, worktreePath),
      BacklogServiceLive
    )
  );
}

function formatFailureNote(failure: GateFailure): string {
  const evidence = failure.evidence
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `- ${item}`)
    .join("\n");
  return [
    `${failure.gate} gate failed: ${failure.reason}`,
    evidence ? `Evidence:\n${evidence}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function failedPhaseFor(result: PipelineLifecycleResult): PhaseSuffix | null {
  const firstFailure = result.failureDetails[0];
  if (result.outcome === "PASS") {
    return null;
  }
  if (!firstFailure) {
    return "R";
  }
  return GATE_PHASES[firstFailure.gate];
}

function phaseLifecycleFailureNote(
  taskId: string,
  failure: GateFailure | undefined
): PhaseLifecyclePlan["failureNote"] {
  return {
    taskId,
    note: failure
      ? formatFailureNote(failure)
      : "Pipeline failed before reporting gate failure details.",
  };
}

function phaseStatusUpdatesUntil(
  swarm: SwarmTaskMap,
  failedPhase: PhaseSuffix | null
): PhaseStatusUpdate[] {
  const statusUpdates: PhaseStatusUpdate[] = [];
  for (const phase of PHASES) {
    const taskId = swarm.phases[phase.suffix];
    statusUpdates.push({ taskId, status: "In Progress" });
    if (phase.suffix === failedPhase) {
      return statusUpdates;
    }
    statusUpdates.push({ taskId, status: "Done" });
  }
  return statusUpdates;
}

export function planPhaseLifecycle(
  swarm: SwarmTaskMap,
  result: PipelineLifecycleResult
): PhaseLifecyclePlan {
  const failedPhase = failedPhaseFor(result);
  const statusUpdates = phaseStatusUpdatesUntil(swarm, failedPhase);
  if (!failedPhase) {
    return { statusUpdates };
  }
  return {
    statusUpdates,
    failureNote: phaseLifecycleFailureNote(
      swarm.phases[failedPhase],
      result.failureDetails[0]
    ),
  };
}
