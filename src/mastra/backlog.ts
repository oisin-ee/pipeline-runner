import { execa } from "execa";

const PHASES = [
  { suffix: "R", label: "research", deps: [] as string[] },
  { suffix: "TW", label: "test-write", deps: ["R"] },
  { suffix: "CW", label: "implement", deps: ["TW"] },
  { suffix: "V", label: "verify", deps: ["CW"] },
  { suffix: "L", label: "learn", deps: ["V"] },
] as const;

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

export async function markPhase(taskId: string, status: string): Promise<void> {
  await runBacklog(["task", "edit", taskId, "--status", status]);
}

interface BacklogTask {
  dependencies?: string[];
  id: string;
  status: string;
}

interface BacklogList {
  tasks?: BacklogTask[];
}

export async function findReadyPhase(parentId: string): Promise<string | null> {
  const output = await runBacklog([
    "task",
    "list",
    "--format",
    "json",
    "--label",
    "swarm",
  ]);
  try {
    const data = JSON.parse(output) as BacklogList;
    const tasks = (data?.tasks ?? []).filter(
      (t) => t.id.startsWith(`${parentId}-`) && t.status === "To Do"
    );
    for (const task of tasks) {
      const blockedByUnfinished = (task.dependencies ?? []).some((dep) => {
        const depTask = (data?.tasks ?? []).find((t) => t.id === dep);
        return depTask && depTask.status !== "Done";
      });
      if (!blockedByUnfinished) {
        return task.id;
      }
    }
  } catch {
    return null;
  }
  return null;
}
