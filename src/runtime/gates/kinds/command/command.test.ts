import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { CommandExecutionContext } from "../../../command-executor";
import type { CommandGateSpec } from "../../../contracts";
import type { CommandExecutorService } from "../../contract";
import { evaluateCommandGate } from "./command";

const stubExecutor = (exitCode: number): CommandExecutorService => ({
  execute: () =>
    Effect.succeed({ evidence: [`exit ${exitCode}`], exitCode, output: "" }),
});

const ctx: CommandExecutionContext = { worktreePath: process.cwd() };
const gate: CommandGateSpec = { command: ["echo", "hi"], kind: "command" };
const EXIT_MISMATCH_RE = /expected exit 0, got 1/u;

describe("evaluateCommandGate", () => {
  it("passes when exit code matches expected (default 0)", async () => {
    const result = await evaluateCommandGate(
      gate,
      "cmd:node",
      "node",
      ctx,
      stubExecutor(0)
    );
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("command");
    expect(result.gateId).toBe("cmd:node");
    expect(result.nodeId).toBe("node");
    expect(result.reason).toBeUndefined();
  });

  it("fails with reason when exit code mismatches", async () => {
    const result = await evaluateCommandGate(
      gate,
      "cmd:node",
      "node",
      ctx,
      stubExecutor(1)
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(EXIT_MISMATCH_RE);
  });

  it("passes when exit code matches a custom expect_exit_code", async () => {
    const nonZeroGate: CommandGateSpec = {
      command: ["false"],
      expect_exit_code: 1,
      kind: "command",
    };
    const result = await evaluateCommandGate(
      nonZeroGate,
      "cmd:node",
      "node",
      ctx,
      stubExecutor(1)
    );
    expect(result.passed).toBe(true);
  });
});
