import { describe, expect, it } from "vitest";

import type { RuntimeNodeResult } from "../runtime/contracts";
import { nodeProcessExitCode } from "./run";

const nodeResult = (overrides: Partial<RuntimeNodeResult> = {}): RuntimeNodeResult => ({
  attempts: 1,
  evidence: [],
  exitCode: 0,
  nodeId: "n",
  output: "",
  status: "passed",
  ...overrides,
});

describe("nodeProcessExitCode", () => {
  it("maps a passed node to exit 0", () => {
    expect(nodeProcessExitCode(nodeResult({ status: "passed" }))).toBe(0);
  });

  it("maps an infra-classed failure (EXIT_INFRA) to exit 70 so argo retries", () => {
    expect(nodeProcessExitCode(nodeResult({ exitCode: 70, status: "failed" }))).toBe(70);
  });

  it("maps a genuine task failure to exit 1 (argo must not retry)", () => {
    expect(nodeProcessExitCode(nodeResult({ exitCode: 1, status: "failed" }))).toBe(1);
  });
});
