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
import { loadPipelineConfig } from "../src/config";
import {
  formatPipelineInitResult,
  initPipelineProject,
} from "../src/pipeline-init";

function bootstrappedHostFilesExist(root: string): boolean {
  return [
    ".agents/skills/research/SKILL.md",
    ".opencode/commands/execute.md",
    ".opencode/opencode.json",
  ].every((relativePath) => existsSync(join(root, relativePath)));
}

describe("initPipelineProject", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pipeline-init-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const init = (options: Parameters<typeof initPipelineProject>[0] = {}) =>
    initPipelineProject({
      cwd: dir,
      ...options,
    });

  it("bootstraps skills and generated host resources without repo-local pipeline config", async () => {
    const result = await init();

    expect(result.files).toContain(".opencode/commands/execute.md");
    expect(result.files).toContain(".opencode/commands/quick.md");
    expect(result.files).toContain(".opencode/opencode.json");
    expect(existsSync(join(dir, ".pipeline"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(bootstrappedHostFilesExist(dir)).toBe(true);
    const opencode = JSON.parse(
      readFileSync(join(dir, ".opencode/opencode.json"), "utf8")
    );
    expect(opencode.mcp["pipeline-gateway"]).toMatchObject({
      type: "remote",
      url: "https://pipeline-mcp.momokaya.ee/mcp/",
    });

    const config = loadPipelineConfig(dir);
    expect(config.default_workflow).toBe("inspect");
    expect(config.entrypoints).toEqual(
      expect.objectContaining({
        execute: expect.objectContaining({ schedule: "execute-schedule" }),
        quick: expect.objectContaining({ schedule: "quick-schedule" }),
      })
    );
    expect(config.profiles["moka-researcher"].mcp_servers).toEqual([
      "pipeline-gateway",
    ]);
    expect(config.skills.research).toEqual({
      path: ".agents/skills/research/SKILL.md",
      source_root: "package",
    });
    expect(config.skills.verify).toEqual({
      path: ".agents/skills/verify/SKILL.md",
      source_root: "package",
    });
  });

  it("formats init as one-command package-owned setup", async () => {
    const result = await init();
    const output = formatPipelineInitResult(result);

    expect(output).toContain("Initialized package-owned pipeline support:");
    expect(output).toContain("installed default skills");
    expect(output).toContain("generated .opencode/opencode.json");
    expect(output).toContain(
      "no repo-local pipeline config files were created"
    );
  });

  it("does not write generated host resources when skill installation fails", async () => {
    await expect(
      initPipelineProject({
        cwd: dir,
        skillInstaller: () => Promise.reject(new Error("skills missing")),
      })
    ).rejects.toThrow("skills missing");

    expect(existsSync(join(dir, ".pipeline"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(dir, ".opencode/opencode.json"))).toBe(false);
  });

  it("does not modify existing repo-local pipeline files", async () => {
    mkdirSync(join(dir, ".pipeline"), { recursive: true });
    writeFileSync(join(dir, ".pipeline", "pipeline.yaml"), "custom: true\n");

    await init();

    expect(readFileSync(join(dir, ".pipeline", "pipeline.yaml"), "utf8")).toBe(
      "custom: true\n"
    );
    expect(existsSync(join(dir, ".pipeline", "profiles.yaml"))).toBe(false);
    expect(existsSync(join(dir, ".pipeline", "runners.yaml"))).toBe(false);
  });
});
