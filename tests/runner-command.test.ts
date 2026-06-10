import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCommandScheduleYaml } from "../src/argo-submit";
import { runRunnerCommand } from "../src/runner-command/run";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-command-"));
  tempDirs.push(dir);
  return dir;
}

function payloadJson(eventTokenPath: string): string {
  return JSON.stringify({
    contractVersion: "1",
    delivery: { pullRequest: false },
    events: {
      authHeader: "Authorization",
      authTokenFile: eventTokenPath,
      url: "https://pipeline-console.example/api/pipeline/runner-events",
    },
    repository: {
      baseBranch: "main",
      sha: "0123456789abcdef0123456789abcdef01234567",
      url: "git@github.com:oisin-ee/pipeline-runner.git",
    },
    run: {
      id: "run-1",
      project: "pipeline-runner",
    },
    submission: {
      argv: ["node", "-e", "console.log('runner command ok')"],
      kind: "command",
    },
    task: {
      kind: "prompt",
      prompt: "Run explicit command",
    },
    workflow: {
      id: "schedule-run-1-root",
    },
  });
}

function writeRunnerCommandFixture(): {
  descriptorPath: string;
  dir: string;
  payloadPath: string;
  schedulePath: string;
} {
  const dir = tempDir();
  const descriptorPath = join(dir, "task.json");
  const eventTokenPath = join(dir, "event-token");
  const payloadPath = join(dir, "payload.json");
  const schedulePath = join(dir, "schedule.yaml");
  writeFileSync(descriptorPath, JSON.stringify({ nodeId: "command" }));
  writeFileSync(eventTokenPath, "test-token");
  writeFileSync(payloadPath, payloadJson(eventTokenPath));
  writeFileSync(
    schedulePath,
    buildCommandScheduleYaml({
      command: ["node", "-e", "console.log('runner command ok')"],
      generatedAt: new Date("2026-06-10T00:00:00.000Z"),
      scheduleId: "run-1",
      task: "Run explicit command",
    })
  );
  return { descriptorPath, dir, payloadPath, schedulePath };
}

describe("runner-command", () => {
  it("accepts mounted payload, schedule, and task descriptor inputs", async () => {
    const { descriptorPath, dir, payloadPath, schedulePath } =
      writeRunnerCommandFixture();

    const exitCode = await runRunnerCommand({
      cwd: dir,
      payloadFile: payloadPath,
      scheduleFile: schedulePath,
      taskDescriptorFile: descriptorPath,
    });

    expect(exitCode).toBe(70);
  });

  it("rejects missing required schedule file as validation failure", async () => {
    const { payloadPath } = writeRunnerCommandFixture();

    const exitCode = await runRunnerCommand({
      payloadFile: payloadPath,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(64);
  });
});
