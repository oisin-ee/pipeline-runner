import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildCommandScheduleYaml } from "../src/argo-submit";

const RUNNER_COMMAND = ["node", "-e", "console.log('runner command ok')"];
const tempDirs: string[] = [];

interface RunnerCommandFixtureOptions {
  hookPolicy?: {
    allowCommandHooks: boolean;
  };
  runId?: string;
  scheduleId?: string;
  tempPrefix?: string;
  workflowId?: string;
}

interface RunnerCommandFixture {
  descriptorPath: string;
  dir: string;
  payloadPath: string;
  schedulePath: string;
}

export function cleanupRunnerCommandFixtures(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
}

export function writeRunnerCommandFixture(
  options: RunnerCommandFixtureOptions = {}
): RunnerCommandFixture {
  const runId = options.runId ?? "run-1";
  const scheduleId = options.scheduleId ?? runId;
  const workflowId = options.workflowId ?? `schedule-${runId}-root`;
  const dir = mkdtempSync(
    join(tmpdir(), options.tempPrefix ?? "runner-command-")
  );
  tempDirs.push(dir);

  const descriptorPath = join(dir, "task.json");
  const eventTokenPath = join(dir, "event-token");
  const payloadPath = join(dir, "payload.json");
  const schedulePath = join(dir, "schedule.yaml");

  writeFileSync(descriptorPath, JSON.stringify({ nodeId: "command" }));
  writeFileSync(eventTokenPath, "test-token");
  writeFileSync(
    payloadPath,
    JSON.stringify({
      contractVersion: "1",
      delivery: { pullRequest: false },
      events: {
        authHeader: "Authorization",
        authTokenFile: eventTokenPath,
        url: "https://pipeline-console.example/api/pipeline/runner-events",
      },
      hookPolicy: options.hookPolicy,
      repository: {
        baseBranch: "main",
        sha: "0123456789abcdef0123456789abcdef01234567",
        url: "git@github.com:oisin-ee/pipeline-runner.git",
      },
      run: {
        id: runId,
        project: "pipeline-runner",
      },
      submission: {
        argv: RUNNER_COMMAND,
        kind: "command",
      },
      task: {
        kind: "prompt",
        prompt: "Run explicit command",
      },
      workflow: {
        id: workflowId,
      },
    })
  );
  writeFileSync(
    schedulePath,
    buildCommandScheduleYaml({
      command: RUNNER_COMMAND,
      generatedAt: new Date("2026-06-10T00:00:00.000Z"),
      scheduleId,
      task: "Run explicit command",
    })
  );

  return { descriptorPath, dir, payloadPath, schedulePath };
}

export function writeLifecycleConfig(project: string, events: string[]): void {
  writeProjectFile(
    project,
    ".pipeline/runners.yaml",
    `version: 1
runners:
  command:
    type: command
    command: node
    capabilities:
      native_subagents: false
      output_formats: [text]
`
  );
  writeProjectFile(
    project,
    ".pipeline/profiles.yaml",
    `version: 1
profiles:
  orchestrator:
    runner: command
    instructions: { inline: Orchestrate }
`
  );
  writeProjectFile(
    project,
    ".pipeline/pipeline.yaml",
    `version: 1
default_workflow: root
orchestrator:
  profile: orchestrator
hooks:
  functions:
    lifecycle:
      kind: command
      command: [hook-bin]
      trusted: true
  on:
${events.map((event) => lifecycleHookYaml(event)).join("")}workflows:
  root:
    nodes:
      - id: command
        kind: command
        command: [node, -e, "console.log('ok')"]
`
  );
}

export function commandHookResult(options: { failEvent?: string } = {}) {
  return (_command: string, _args: string[], execaOptions?: unknown) => {
    const env = (execaOptions as { env?: Record<string, string> } | undefined)
      ?.env;
    const inputPath = env?.PIPELINE_HOOK_INPUT ?? "";
    const resultPath = env?.PIPELINE_HOOK_RESULT ?? "";
    if (inputPath.length === 0 || resultPath.length === 0) {
      return { exitCode: 1, stderr: "missing hook env", stdout: "" };
    }
    const input = JSON.parse(readFileSync(inputPath, "utf8")) as {
      event: { type: string };
    };
    const status = input.event.type === options.failEvent ? "fail" : "pass";
    writeFileSync(
      resultPath,
      JSON.stringify({
        status,
        summary: `${input.event.type} ${status}`,
      })
    );
    return { exitCode: 0, stderr: "", stdout: "" };
  };
}

export function captureEventBatches(batches: unknown[][]) {
  return (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      events?: unknown[];
    };
    batches.push(body.events ?? []);
    return Promise.resolve(new Response(null, { status: 200 }));
  };
}

export function eventTypes(batches: unknown[][]): string[] {
  return flattenedEvents(batches).map((event) => event.type);
}

export function hookResultEvents(batches: unknown[][]): RunnerEvent[] {
  return flattenedEvents(batches).filter(
    (event) => event.type === "hook.result"
  );
}

export function finalResults(
  batches: unknown[][]
): Array<{ outcome: string; workflowId: string }> {
  return flattenedEvents(batches)
    .filter((event) => event.type === "workflow.finish")
    .map((event) => event.finalResult)
    .filter((result): result is { outcome: string; workflowId: string } =>
      Boolean(result)
    );
}

function writeProjectFile(root: string, path: string, content: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function lifecycleHookYaml(event: string): string {
  const id = event.slice(event.indexOf(".") + 1);
  return `    ${event}:
      - id: ${id}
        function: lifecycle
        failure: fail
        result: { publish: true }
`;
}

function flattenedEvents(batches: unknown[][]): RunnerEvent[] {
  return batches.flat() as RunnerEvent[];
}

interface RunnerEvent {
  finalResult?: { outcome: string; workflowId: string };
  hookResult?: { event?: string; status?: string };
  type: string;
}
