import { describe, expect, it } from "vitest";
import { executeCommand } from "./command-executor";

describe("executeCommand", () => {
  it("returns command output and evidence for successful commands", async () => {
    const result = await executeCommand(
      ["node", "-e", "console.log('hello')"],
      { worktreePath: process.cwd() }
    );

    expect(result).toMatchObject({
      evidence: ["command exited 0: node -e console.log('hello')"],
      exitCode: 0,
      output: "hello",
    });
  });

  it("reports failed commands and preserves stdout/stderr output", async () => {
    const result = await executeCommand(
      [
        "node",
        "-e",
        "console.log('out'); console.error('err'); process.exit(7)",
      ],
      { worktreePath: process.cwd() }
    );

    expect(result.exitCode).toBe(7);
    expect(result.output).toBe("out\nerr");
    expect(result.evidence).toContain(
      "command exited 7: node -e console.log('out'); console.error('err'); process.exit(7)"
    );
    expect(result.evidence).toContain("out\nerr");
  });

  it("honors command output limits passed to execa", async () => {
    const result = await executeCommand(
      ["node", "-e", "console.log('abcdef')"],
      { worktreePath: process.cwd() },
      { outputLimitBytes: 3 }
    );

    expect(result.output).toBe("abc");
    expect(result.evidence).toEqual([
      "command exited 0: node -e console.log('abcdef')",
      "abc",
    ]);
  });
});
