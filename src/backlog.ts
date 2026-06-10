import { execa } from "execa";

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

async function runBacklog(args: string[], cwd: string): Promise<string> {
  try {
    const result = await execa("backlog", args, { cwd });
    return result.stdout;
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? "";
  }
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
  const parentOut = await runBacklog(
    ["task", "create", taskDescription, "--labels", "swarm-parent", "--plain"],
    worktreePath
  );
  const parentId = parseTaskId(parentOut);
  if (!parentId) {
    throw new Error(
      `createSwarmTasks: could not parse parent task id from backlog output: ${parentOut.slice(0, 200)}`
    );
  }

  const phases: Partial<Record<PhaseSuffix, string>> = {};
  for (const phase of PHASES) {
    const childOut = await runBacklog(
      [
        "task",
        "create",
        `${taskDescription} — ${phase.label}`,
        "--parent",
        parentId,
        "--labels",
        `swarm,phase-${phase.suffix}`,
        "--plain",
      ],
      worktreePath
    );
    const childId = parseTaskId(childOut);
    if (!childId) {
      throw new Error(
        `createSwarmTasks: could not parse ${phase.suffix} child task id from backlog output: ${childOut.slice(0, 200)}`
      );
    }
    phases[phase.suffix] = childId;
  }

  return { parentId, phases: phases as Record<PhaseSuffix, string> };
}

export async function markPhase(
  taskId: string,
  status: BacklogStatus,
  worktreePath: string
): Promise<void> {
  await runBacklog(["task", "edit", taskId, "--status", status], worktreePath);
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

export function planPhaseLifecycle(
  swarm: SwarmTaskMap,
  result: PipelineLifecycleResult
): PhaseLifecyclePlan {
  const firstFailure = result.failureDetails[0];
  let failedPhase: PhaseSuffix | null = null;
  if (result.outcome === "FAIL") {
    failedPhase = firstFailure ? GATE_PHASES[firstFailure.gate] : "R";
  }
  const statusUpdates: PhaseStatusUpdate[] = [];

  for (const phase of PHASES) {
    const taskId = swarm.phases[phase.suffix];
    statusUpdates.push({ taskId, status: "In Progress" });

    if (phase.suffix === failedPhase) {
      return {
        statusUpdates,
        failureNote: {
          taskId,
          note: firstFailure
            ? formatFailureNote(firstFailure)
            : "Pipeline failed before reporting gate failure details.",
        },
      };
    }

    statusUpdates.push({ taskId, status: "Done" });
  }

  return { statusUpdates };
}
