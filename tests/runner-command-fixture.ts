import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildCommandScheduleYaml } from "../src/argo-submit";
import { isRecord, isStringValue, parseJson, stringRecord } from "../src/safe-json";

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

export const cleanupRunnerCommandFixtures = (): void => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
};

export const writeRunnerCommandFixture = (options: RunnerCommandFixtureOptions = {}): RunnerCommandFixture => {
  const runId = options.runId ?? "run-1";
  const scheduleId = options.scheduleId ?? runId;
  const workflowId = options.workflowId ?? `schedule-${runId}-root`;
  const dir = mkdtempSync(join(tmpdir(), options.tempPrefix ?? "runner-command-"));
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
    }),
  );
  writeFileSync(
    schedulePath,
    buildCommandScheduleYaml({
      command: RUNNER_COMMAND,
      generatedAt: new Date("2026-06-10T00:00:00.000Z"),
      scheduleId,
      task: "Run explicit command",
    }),
  );

  return { descriptorPath, dir, payloadPath, schedulePath };
};

export const commandHookResult =
  (options: { failEvent?: string } = {}) =>
  (_command: string, _args: string[], execaOptions?: unknown) => {
    const env = stringRecord(isRecord(execaOptions) ? execaOptions.env : undefined);
    const inputPath = stringRecordField(env, "PIPELINE_HOOK_INPUT");
    const resultPath = stringRecordField(env, "PIPELINE_HOOK_RESULT");
    if (inputPath.length === 0 || resultPath.length === 0) {
      return { exitCode: 1, stderr: "missing hook env", stdout: "" };
    }
    const input = parseJson(readFileSync(inputPath, "utf-8"), "hook input");
    const event = isRecord(input) && isRecord(input.event) ? input.event : {};
    const eventType = isStringValue(event.type) ? event.type : "";
    const status = eventType === options.failEvent ? "fail" : "pass";
    writeFileSync(
      resultPath,
      JSON.stringify({
        status,
        summary: `${eventType} ${status}`,
      }),
    );
    return { exitCode: 0, stderr: "", stdout: "" };
  };

const stringRecordField = (record: Record<string, string>, key: string): string => {
  const value: unknown = Reflect.get(record, key);
  return isStringValue(value) ? value : "";
};

export const captureEventBatches = (batches: unknown[][]) => async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = parseJson(String(init?.body ?? "{}"), "runner event batch");
  batches.push(isRecord(body) && Array.isArray(body.events) ? body.events : []);
  return new Response(null, { status: 200 });
};

const writeProjectFile = (root: string, path: string, content: string): void => {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
};

const lifecycleHookYaml = (event: string): string => {
  const id = event.slice(event.indexOf(".") + 1);
  return `    ${event}:
      - id: ${id}
        function: lifecycle
        failure: fail
        result: { publish: true }
`;
};

export const writeLifecycleConfig = (project: string, events: string[]): void => {
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
`,
  );
  writeProjectFile(
    project,
    ".pipeline/profiles.yaml",
    `version: 1
profiles:
  orchestrator:
    runner: command
    instructions: { inline: Orchestrate }
`,
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
`,
  );
};

interface RunnerEventFinalResult {
  outcome: string;
  workflowId: string;
}

interface RunnerEventHookResult {
  event?: string;
  status?: string;
}

type EventFinalResult = readonly [] | readonly [RunnerEventFinalResult];
type EventHookResult = readonly [] | readonly [RunnerEventHookResult];

const eventResult = (value: unknown): EventFinalResult => {
  if (!isRecord(value) || !isStringValue(value.outcome) || !isStringValue(value.workflowId)) {
    return [];
  }
  return [{ outcome: value.outcome, workflowId: value.workflowId }];
};

const hookResult = (value: unknown): EventHookResult => {
  if (!isRecord(value)) {
    return [];
  }
  return [
    {
      ...(isStringValue(value.event) ? { event: value.event } : {}),
      ...(isStringValue(value.status) ? { status: value.status } : {}),
    },
  ];
};

const runnerEvent = (value: unknown): RunnerEvent[] => {
  if (!isRecord(value) || !isStringValue(value.type)) {
    return [];
  }
  const [finalResult] = eventResult(value.finalResult);
  const [hookResultValue] = hookResult(value.hookResult);
  return [
    {
      ...(finalResult === undefined ? {} : { finalResult }),
      ...(hookResultValue === undefined ? {} : { hookResult: hookResultValue }),
      type: value.type,
    },
  ];
};

const flattenedEvents = (batches: unknown[][]): RunnerEvent[] => batches.flatMap((batch) => batch.flatMap(runnerEvent));

export const eventTypes = (batches: unknown[][]): string[] => flattenedEvents(batches).map((event) => event.type);

export const hookResultEvents = (batches: unknown[][]): RunnerEvent[] =>
  flattenedEvents(batches).filter((event) => event.type === "hook.result");

export const finalResults = (batches: unknown[][]): RunnerEventFinalResult[] =>
  flattenedEvents(batches)
    .filter((event) => event.type === "workflow.finish")
    .map((event) => event.finalResult)
    .filter((result): result is RunnerEventFinalResult => Boolean(result));

interface RunnerEvent {
  finalResult?: RunnerEventFinalResult;
  hookResult?: RunnerEventHookResult;
  type: string;
}
