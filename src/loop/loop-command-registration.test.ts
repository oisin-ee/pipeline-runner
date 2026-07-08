import { describe, expect, it, vi } from "vitest";

import { findSubcommand, subcommandsOf } from "../cli/cli-tree";
import { createCliProgram } from "../cli/program";
import { runCli } from "../cli/program";

const captureStdout = async (run: () => Promise<void>): Promise<string> => {
  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((message) => {
    output.push(String(message));
  });
  try {
    await run();
    return output.join("\n");
  } finally {
    log.mockRestore();
  }
};

describe("loop command registration", () => {
  it("registers loop and hidden loop-controller", async () => {
    const program = createCliProgram();
    const names = subcommandsOf(program).map((command) => command.name);
    expect(names).toContain("loop");
    expect(names).toContain("loop-controller");
    expect(findSubcommand(program, "loop")).toBeDefined();

    const loopHelp = await captureStdout(async () => {
      await runCli(["node", "/repo/node_modules/.bin/moka", "loop", "--help"]);
    });
    expect(loopHelp).toContain("--strategy");
    expect(loopHelp).toContain("--root");
    expect(loopHelp).toContain("--max-remediation-attempts");
    expect(loopHelp).toContain("--merge-timeout");
  });
});
