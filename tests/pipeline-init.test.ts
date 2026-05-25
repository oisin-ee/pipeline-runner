import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPipelineConfig } from "../src/mastra/config.js";
import {
  defaultPipelineScaffoldFiles,
  initPipelineProject,
  PipelineInitError,
} from "../src/pipeline-init.js";

describe("initPipelineProject", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pipeline-init-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates .pipeline/pipeline.yaml when no config exists", async () => {
    const result = await initPipelineProject({ cwd: dir });

    expect(result.files).toContain(".pipeline/pipeline.yaml");
    expect(existsSync(join(dir, ".pipeline", "pipeline.yaml"))).toBe(true);
    expect(loadPipelineConfig(dir).default_workflow).toBe("default");
  });

  it("scaffolds prompt files, schema files, and host resource inputs", async () => {
    await initPipelineProject({ cwd: dir });

    for (const path of [
      ".pipeline/prompts/researcher.md",
      ".pipeline/prompts/test-writer.md",
      ".pipeline/prompts/code-writer.md",
      ".pipeline/prompts/verifier.md",
      ".pipeline/prompts/learner.md",
      ".pipeline/schemas/research.schema.json",
      ".pipeline/schemas/verify.schema.json",
      ".pipeline/schemas/learn.schema.json",
      ".pipeline/host-resources/claude.md",
      ".pipeline/host-resources/codex.md",
      ".pipeline/host-resources/opencode.md",
      ".pipeline/host-resources/kimi.md",
      ".pipeline/host-resources/pi.md",
    ]) {
      expect(existsSync(join(dir, path))).toBe(true);
    }
  });

  it("expresses the default phases as workflow nodes", async () => {
    await initPipelineProject({ cwd: dir });

    const config = loadPipelineConfig(dir);
    expect(config.workflows.default.nodes.map((node) => node.id)).toEqual([
      "research",
      "red",
      "green",
      "verify",
      "learn",
    ]);
    expect(
      config.workflows.default.nodes.every((node) => node.kind === "agent")
    ).toBe(true);
  });

  it("refuses to overwrite existing scaffold files without --overwrite", async () => {
    await initPipelineProject({ cwd: dir });

    await expect(initPipelineProject({ cwd: dir })).rejects.toThrow(
      PipelineInitError
    );
  });

  it("overwrites existing scaffold files when requested", async () => {
    await initPipelineProject({ cwd: dir });
    writeFileSync(join(dir, ".pipeline", "pipeline.yaml"), "custom: true\n");

    await initPipelineProject({ cwd: dir, overwrite: true });

    expect(readFileSync(join(dir, ".pipeline", "pipeline.yaml"), "utf8")).toBe(
      defaultPipelineScaffoldFiles()[".pipeline/pipeline.yaml"]
    );
  });

  it("keeps the scaffold manifest complete", () => {
    expect(Object.keys(defaultPipelineScaffoldFiles()).sort()).toEqual([
      ".pipeline/host-resources/claude.md",
      ".pipeline/host-resources/codex.md",
      ".pipeline/host-resources/kimi.md",
      ".pipeline/host-resources/opencode.md",
      ".pipeline/host-resources/pi.md",
      ".pipeline/pipeline.yaml",
      ".pipeline/prompts/code-writer.md",
      ".pipeline/prompts/learner.md",
      ".pipeline/prompts/orchestrator.md",
      ".pipeline/prompts/researcher.md",
      ".pipeline/prompts/test-writer.md",
      ".pipeline/prompts/verifier.md",
      ".pipeline/rules/test-first.md",
      ".pipeline/rules/verification.md",
      ".pipeline/schemas/learn.schema.json",
      ".pipeline/schemas/research.schema.json",
      ".pipeline/schemas/verify.schema.json",
    ]);
  });
});
