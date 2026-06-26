import { describe, expect, it } from "vitest";
import type { ArtifactGateSpec } from "../../../contracts";
import { evaluateArtifactGate } from "./artifact";

const ctx = { worktreePath: process.cwd() };

describe("evaluateArtifactGate", () => {
  it("passes when the artifact file exists", () => {
    // package.json is guaranteed to exist in the working dir during tests
    const gate: ArtifactGateSpec = { kind: "artifact", path: "package.json" };
    const result = evaluateArtifactGate(gate, "artifact:node", "node", ctx);
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("artifact");
    expect(result.gateId).toBe("artifact:node");
    expect(result.reason).toBeUndefined();
  });

  it("fails when the artifact file does not exist", () => {
    const gate: ArtifactGateSpec = {
      kind: "artifact",
      path: "does-not-exist.txt",
    };
    const result = evaluateArtifactGate(gate, "artifact:node", "node", ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("missing artifact");
  });

  it("fails when path is empty", () => {
    const gate: ArtifactGateSpec = { kind: "artifact", path: "" };
    const result = evaluateArtifactGate(gate, "artifact:node", "node", ctx);
    expect(result.passed).toBe(false);
  });
});
