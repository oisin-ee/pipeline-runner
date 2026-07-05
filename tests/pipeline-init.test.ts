import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatPipelineInitResult,
  initPipelineProject,
} from "../src/pipeline-init";

// `moka init` now installs only Moka's own host adapters (command surfaces,
// native-agent projections, and singleton MCP gateway config). The agent
// harness (skills, hooks, instruction rules) is provisioned from oisin-ee/agent
// via chezmoi, not Moka, so this suite asserts an adapter-only install with no
// network side effects.

const bootstrappedHostFilesExist = (home: string): boolean =>
  [
    join(home, ".config", "opencode", "commands", "moka-execute.md"),
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".claude", "commands", "moka-execute.md"),
  ].every((absolutePath) => existsSync(absolutePath));

describe("initPipelineProject (global scope)", () => {
  let dir: string;
  let home: string;
  const savedEnv: NodeJS.ProcessEnv = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pipeline-init-repo-"));
    home = mkdtempSync(join(tmpdir(), "pipeline-init-home-"));
    for (const key of [
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "OPENCODE_CONFIG_DIR",
      "GEMINI_CONFIG_DIR",
      "HOME",
    ]) {
      savedEnv[key] = process.env[key];
    }
    // Redirect the per-machine host dirs into the temp home so the global
    // install never touches the real ~/.claude, ~/.codex, ~/.config/opencode.
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    process.env.CODEX_HOME = join(home, ".codex");
    process.env.OPENCODE_CONFIG_DIR = join(home, ".config", "opencode");
    process.env.GEMINI_CONFIG_DIR = join(home, ".gemini");
    process.env.HOME = home;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  });

  it("installs host adapters without repo-local pipeline config", async () => {
    const result = await initPipelineProject({ cwd: dir });

    expect(result.files).toContain(".opencode/commands/moka-execute.md");
    expect(result.files).toContain(".opencode/commands/moka-quick.md");
    expect(result.files).toContain(".opencode/commands/moka-inspect.md");
    expect(result.files).toContain(".opencode/opencode.json");
    expect(result.files).toContain(".claude/commands/moka-execute.md");
    expect(existsSync(join(dir, ".pipeline"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(bootstrappedHostFilesExist(home)).toBe(true);
    const opencode = JSON.parse(
      readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf-8")
    );
    expect(opencode.mcp["pipeline-gateway"]).toMatchObject({
      type: "remote",
      url: "https://pipeline-mcp.momokaya.ee/mcp/",
    });
  });

  it("does not install skills, agent hooks, or instruction rules", async () => {
    await initPipelineProject({ cwd: dir });

    // Harness assets come from oisin-ee/agent via chezmoi; moka init must not
    // write any of them into the host dirs. (settings.json is deliberately
    // written by the command-adapter install — it carries the MCP gateway
    // config — so it is not asserted here.)
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);
    expect(existsSync(join(home, ".config", "opencode", "AGENTS.md"))).toBe(
      false
    );
    expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(home, ".config", "opencode", "skills"))).toBe(false);
  });

  it("formats init as one-command host adapter setup", async () => {
    const result = await initPipelineProject({ cwd: dir });
    const output = formatPipelineInitResult(result);

    expect(output).toContain("Initialized Moka host adapters:");
    expect(output).toContain("Moka host adapters");
    expect(output).toContain("chezmoi");
    expect(output).toContain("generated .opencode/opencode.json");
    expect(output).toContain(
      "no repo-local pipeline config files were created"
    );
  });

  it("does not modify existing repo-local pipeline files", async () => {
    mkdirSync(join(dir, ".pipeline"), { recursive: true });
    writeFileSync(join(dir, ".pipeline", "pipeline.yaml"), "custom: true\n");

    await initPipelineProject({ cwd: dir });

    expect(readFileSync(join(dir, ".pipeline", "pipeline.yaml"), "utf-8")).toBe(
      "custom: true\n"
    );
    expect(existsSync(join(dir, ".pipeline", "profiles.yaml"))).toBe(false);
    expect(existsSync(join(dir, ".pipeline", "runners.yaml"))).toBe(false);
  });

  it("forces generated command files by default so stale adapters are refreshed", async () => {
    const commandPath = join(
      home,
      ".config",
      "opencode",
      "commands",
      "moka-execute.md"
    );
    mkdirSync(dirname(commandPath), { recursive: true });
    writeFileSync(commandPath, "manual stale command\n");

    await initPipelineProject({ cwd: dir });

    expect(readFileSync(commandPath, "utf-8")).not.toBe(
      "manual stale command\n"
    );
  });

  it("writes into the per-machine host dirs, not the repo", async () => {
    const result = await initPipelineProject({ cwd: dir });

    expect(
      existsSync(
        join(home, ".config", "opencode", "commands", "moka-execute.md")
      )
    ).toBe(true);
    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(
      true
    );
    expect(existsSync(join(dir, ".opencode"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(formatPipelineInitResult(result)).toContain("Moka host adapters");
  });

  it("formats --check as a verify, not an install", async () => {
    await initPipelineProject({ cwd: dir });

    const result = await initPipelineProject({ check: true, cwd: dir });
    const output = formatPipelineInitResult(result, { check: true });

    expect(output).toContain("Verified Moka host adapters are current:");
    expect(output).toContain("adapters verified; no changes written");
    expect(output).not.toContain("Initialized");
  });
});
