import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
