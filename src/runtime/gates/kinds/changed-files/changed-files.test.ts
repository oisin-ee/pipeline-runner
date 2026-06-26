import { describe, expect, it } from "vitest";
import type { ChangedFilesGateSpec, RuntimeContext } from "../../../contracts";
import { NodeStateStore } from "../../../node-state-store";
import { evaluateChangedFilesGate } from "./changed-files";

function ctx(files: string[]): Pick<RuntimeContext, "nodeStateStore"> {
  return {
    nodeStateStore: new NodeStateStore({
      nodeSnapshots: new Map([
        ["node-a", { files: new Set(files), fingerprints: new Map() }],
      ]),
    }),
  };
}

describe("evaluateChangedFilesGate", () => {
  it("passes when changed files match allow + require_any policies", () => {
    const gate: ChangedFilesGateSpec = {
      changed_files: { allow: ["src/**"], require_any: ["src/**"] },
      kind: "changed_files",
    };
    const result = evaluateChangedFilesGate(
      gate,
      "cf:node-a",
      "node-a",
      ctx(["src/app.ts"])
    );
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("changed_files");
  });

  it("fails on denied files", () => {
    const gate: ChangedFilesGateSpec = {
      changed_files: { deny: ["**/*.md"] },
      kind: "changed_files",
    };
    const result = evaluateChangedFilesGate(
      gate,
      "cf:node-a",
      "node-a",
      ctx(["README.md"])
    );
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain("denied changes: README.md");
  });

  it("excludes supervisor run-state from policy evaluation", () => {
    // PIPE-91.12: with db.url set, run-control state lives in Postgres, but the
    // db.url-absent filesystem path still writes the full .pipeline/runs tree in
    // the worktree, so SUPERVISOR_RUN_STATE_GLOBS must keep hiding every part of
    // it (manifest/events/status/node stdout) from policy evaluation (AC4).
    const gate: ChangedFilesGateSpec = {
      changed_files: { allow: ["src/**"] },
      kind: "changed_files",
    };
    const files = [
      "src/app.ts",
      ".pipeline/runs/run-1/manifest.json",
      ".pipeline/runs/run-1/events.jsonl",
      ".pipeline/runs/run-1/status.json",
      ".pipeline/runs/run-1/nodes/writer/stdout.jsonl",
    ];
    const result = evaluateChangedFilesGate(
      gate,
      "cf:node-a",
      "node-a",
      ctx(files)
    );
    expect(result.passed).toBe(true);
    expect(JSON.stringify(result.evidence)).not.toContain(".pipeline");
  });

  it("still gates genuine node-authored output under .pipeline/ (AC4)", () => {
    // The run-state exclusion is narrow: a node that writes real output under
    // .pipeline/ (NOT runs/journal/runtime-events/status.json) is still gated,
    // so the Postgres cutover does not widen the bypass into a blanket .pipeline/
    // allowance.
    const gate: ChangedFilesGateSpec = {
      changed_files: { allow: ["src/**"] },
      kind: "changed_files",
    };
    const result = evaluateChangedFilesGate(
      gate,
      "cf:node-a",
      "node-a",
      ctx(["src/app.ts", ".pipeline/custom-output.json"])
    );
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain(
      "changes outside allow list: .pipeline/custom-output.json"
    );
  });

  it("drops untracked files when include_untracked is false", () => {
    const gate: ChangedFilesGateSpec = {
      changed_files: { include_untracked: false, require_any: ["src/**"] },
      kind: "changed_files",
    };
    // src/app.ts covers require_any; scratch.txt is stripped as untracked
    const result = evaluateChangedFilesGate(
      gate,
      "cf:node-a",
      "node-a",
      ctx(["?? scratch.txt", "src/app.ts"])
    );
    expect(result.passed).toBe(true);
  });
});
