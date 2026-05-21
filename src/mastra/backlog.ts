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
  gate: "RED" | "GREEN" | "VERIFY";
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

const GATE_PHASES: Record<GateFailure["gate"], PhaseSuffix> = {
  GREEN: "CW",
  RED: "TW",
  VERIFY: "V",
};

function backlogArgs(...args: string[]): string[] {
  return [...args, "--no-git"];
}

async function runBacklog(args: string[]): Promise<string> {
  try {
    const result = await execa("backlog", backlogArgs(...args));
    return result.stdout;
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? "";
  }
}

export async function createSwarmTasks(
  parentId: string,
  _worktreePath: string
): Promise<void> {
  for (const phase of PHASES) {
    const id = `${parentId}-${phase.suffix}`;
    const deps = phase.deps.map((d) => `${parentId}-${d}`);
    const createArgs = [
      "task",
      "create",
      id,
      "--title",
      phase.label,
      "--label",
      "swarm",
    ];
    if (deps.length > 0) {
      createArgs.push("--depends-on", deps.join(","));
    }
    await runBacklog(createArgs);
  }
}

export async function markPhase(
  taskId: string,
  status: BacklogStatus
): Promise<void> {
  await runBacklog(["task", "edit", taskId, "--status", status]);
}

async function appendPhaseNote(taskId: string, note: string): Promise<void> {
  await runBacklog(["task", "edit", taskId, "--append-notes", note]);
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
  parentId: string,
  result: PipelineLifecycleResult
): PhaseLifecyclePlan {
  const firstFailure = result.failureDetails[0];
  let failedPhase: PhaseSuffix | null = null;
  if (result.outcome === "FAIL") {
    failedPhase = firstFailure ? GATE_PHASES[firstFailure.gate] : "R";
  }
  const statusUpdates: PhaseStatusUpdate[] = [];

  for (const phase of PHASES) {
    const taskId = `${parentId}-${phase.suffix}`;
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

export async function applyPhaseLifecycle(
  parentId: string,
  result: PipelineLifecycleResult,
  opts: { alreadyStarted?: PhaseSuffix[] } = {}
): Promise<void> {
  const plan = planPhaseLifecycle(parentId, result);
  for (const update of plan.statusUpdates) {
    const suffix = update.taskId.replace(`${parentId}-`, "") as PhaseSuffix;
    if (
      update.status === "In Progress" &&
      opts.alreadyStarted?.includes(suffix)
    ) {
      continue;
    }
    await markPhase(update.taskId, update.status);
  }
  if (plan.failureNote) {
    await appendPhaseNote(plan.failureNote.taskId, plan.failureNote.note);
  }
}
