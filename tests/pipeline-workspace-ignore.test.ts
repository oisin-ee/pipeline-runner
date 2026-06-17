import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePipelineWorkspaceIgnore } from "../src/run-control/workspace";

describe("ensurePipelineWorkspaceIgnore", () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = mkdtempSync(join(tmpdir(), "pipeline-workspace-ignore-"));
  });

  afterEach(() => {
    rmSync(worktreePath, { force: true, recursive: true });
  });

  it("creates .pipeline/.gitignore containing '*' when it does not exist", () => {
    ensurePipelineWorkspaceIgnore(worktreePath);

    const gitignorePath = join(worktreePath, ".pipeline", ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, "utf8")).toBe("*\n");
  });

  it("is idempotent — calling twice leaves the same content", () => {
    ensurePipelineWorkspaceIgnore(worktreePath);
    ensurePipelineWorkspaceIgnore(worktreePath);

    const gitignorePath = join(worktreePath, ".pipeline", ".gitignore");
    expect(readFileSync(gitignorePath, "utf8")).toBe("*\n");
  });

  it("does not overwrite a pre-existing .pipeline/.gitignore with different content", () => {
    const pipelineDir = join(worktreePath, ".pipeline");
    mkdirSync(pipelineDir, { recursive: true });
    const gitignorePath = join(pipelineDir, ".gitignore");
    writeFileSync(gitignorePath, "schedule.yaml\n");

    ensurePipelineWorkspaceIgnore(worktreePath);

    expect(readFileSync(gitignorePath, "utf8")).toBe("schedule.yaml\n");
  });

  it("creates .pipeline/ dir if it does not yet exist", () => {
    const pipelineDir = join(worktreePath, ".pipeline");
    expect(existsSync(pipelineDir)).toBe(false);

    ensurePipelineWorkspaceIgnore(worktreePath);

    expect(existsSync(pipelineDir)).toBe(true);
  });
});
