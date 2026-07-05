import { describe, expect, it } from "vitest";

import { createCliProgram } from "../cli/program";

describe("loop command registration", () => {
  it("registers loop and hidden loop-controller", () => {
    const program = createCliProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("loop");
    expect(names).toContain("loop-controller");
    const loop = program.commands.find((c) => c.name() === "loop");
    const optionNames = loop?.options.map((o) => o.long);
    expect(optionNames).toContain("--strategy");
    expect(optionNames).toContain("--root");
    expect(optionNames).toContain("--max-remediation-attempts");
    expect(optionNames).toContain("--merge-timeout");
  });
});
