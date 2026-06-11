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
});
