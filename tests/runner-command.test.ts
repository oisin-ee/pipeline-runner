import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { runRunnerCommand } from "../src/runner-command/run";
import {
  cleanupRunnerCommandFixtures,
  writeRunnerCommandFixture,
} from "./runner-command-fixture";

afterEach(() => {
  cleanupRunnerCommandFixtures();
});

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

  it("reports a startup failure when a scheduled task descriptor names no planned node", async () => {
    const { descriptorPath, dir, payloadPath, schedulePath } =
      writeRunnerCommandFixture();
    const stderr: string[] = [];
    writeFileSync(descriptorPath, JSON.stringify({ nodeId: "missing" }));

    const exitCode = await runRunnerCommand({
      cwd: dir,
      payloadFile: payloadPath,
      scheduleFile: schedulePath,
      stderr: { write: (chunk) => stderr.push(String(chunk)) > 0 },
      taskDescriptorFile: descriptorPath,
    });

    expect(exitCode).toBe(70);
    expect(stderr.join("")).toContain(
      "Argo task 'missing' is not declared in workflow"
    );
  });

  it("reports safe JSON parse context for malformed task descriptors", async () => {
    const { descriptorPath, dir, payloadPath, schedulePath } =
      writeRunnerCommandFixture();
    const stderr: string[] = [];
    writeFileSync(descriptorPath, "{not json");

    const exitCode = await runRunnerCommand({
      cwd: dir,
      payloadFile: payloadPath,
      scheduleFile: schedulePath,
      stderr: { write: (chunk) => stderr.push(String(chunk)) > 0 },
      taskDescriptorFile: descriptorPath,
    });

    expect(exitCode).toBe(70);
    expect(stderr.join("")).toContain(
      "Failed to parse runner task descriptor JSON"
    );
  });
});
