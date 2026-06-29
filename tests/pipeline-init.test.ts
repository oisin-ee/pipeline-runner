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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture hook the execa mock invokes on every shelled-out call. Tests set
// `onCall` to observe the `npx skills add` invocation (e.g. to assert global
// skills were already cleaned before the additive install ran).
const execaSpy = vi.hoisted<{
  onCall: ((file: string, args: readonly string[]) => void) | undefined;
}>(() => ({ onCall: undefined }));

// Mock execa so the default `installDefaultSkills` path (which shells out to
// `npx skills add`) never hits the network. installCommands does not use execa;
// installRules does but is always replaced by `noopRulesInstaller` here.
vi.mock("execa", () => ({
  execa: vi.fn((file: string, args: readonly string[] = []) => {
    execaSpy.onCall?.(file, args);
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
  }),
}));

import { execa } from "execa";
import { loadPipelineConfig } from "../src/config";
import { resolveHarnessTarget } from "../src/install-commands/shared";
import { installHooks } from "../src/install-hooks";
import type { PipelineRulesInstaller } from "../src/pipeline-init";
import {
  formatPipelineInitResult,
  initPipelineProject,
} from "../src/pipeline-init";

// Mock only installHooks so the default hook-install path is exercised offline
// (the real one clones oisin-ee/agent). Tests that inject their own
// hookInstaller bypass this entirely.
vi.mock("../src/install-hooks", () => {
  const result: {
    items: Array<{ action: "update"; host: "claude-code"; path: string }>;
    source: "oisin-ee/agent";
  } = {
    items: [
      { action: "update", host: "claude-code", path: ".claude/settings.json" },
    ],
    source: "oisin-ee/agent",
  };
  return { installHooks: vi.fn(() => Promise.resolve(result)) };
});

const DEFAULT_INIT_SKILLS = [
  "critique",
  "doubt",
  "execute",
  "fix",
  "inspect",
  "library-first-development",
  "migrate",
  "optimize",
  "quick",
  "research",
  "schedule-graph-shaping",
  "scope",
  "secure",
  "spec",
  "test",
  "trace",
  "verify",
];

async function installMockSkills(cwd: string): Promise<void> {
  await Promise.resolve();
  for (const skill of DEFAULT_INIT_SKILLS) {
    const path = join(cwd, ".agents", "skills", skill, "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `---\nname: ${skill}\ndescription: Mock ${skill} skill.\n---\n\n# ${skill}\n`
    );
  }
}

async function installMockHooks(_cwd: string): Promise<{ files: string[] }> {
  await Promise.resolve();
  const path = resolveHarnessTarget(".claude/hooks/check.sh");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\necho hook\n");
  return { files: [".claude/hooks/check.sh"] };
}

// No-op rules installer: avoids hitting the network in unit tests.
// Global instruction files are covered by the dedicated install-rules test.
const noopRulesInstaller: PipelineRulesInstaller = async (_cwd) => ({
  items: [],
});

function bootstrappedHostFilesExist(home: string): boolean {
  return [
    join(home, ".config", "opencode", "commands", "moka-execute.md"),
    join(home, ".config", "opencode", "opencode.json"),
  ].every((absolutePath) => existsSync(absolutePath));
}

describe("initPipelineProject (global scope)", () => {
  let dir: string;
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pipeline-init-repo-"));
    home = mkdtempSync(join(tmpdir(), "pipeline-init-home-"));
    for (const key of [
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "OPENCODE_CONFIG_DIR",
      "HOME",
      "XDG_STATE_HOME",
    ]) {
      savedEnv[key] = process.env[key];
    }
    // Redirect the per-machine host dirs into the temp home so the global
    // install never touches the real ~/.claude, ~/.codex, ~/.config/opencode.
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    process.env.CODEX_HOME = join(home, ".codex");
    process.env.OPENCODE_CONFIG_DIR = join(home, ".config", "opencode");
    // The skills CLI resolves its shared master store (`~/.agents/skills`) and
    // lock from the home dir / XDG_STATE_HOME, so `cleanGlobalSkills` does too.
    // Redirect both into the temp home so the clean step never touches the real
    // ~/.agents during tests.
    process.env.HOME = home;
    delete process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    execaSpy.onCall = undefined;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("bootstraps skills and generated host resources without repo-local pipeline config", async () => {
    const result = await initPipelineProject({
      cwd: dir,
      hookInstaller: installMockHooks,
      rulesInstaller: noopRulesInstaller,
      skillInstaller: installMockSkills,
    });

    expect(result.files).toContain(".opencode/commands/moka-execute.md");
    expect(result.files).toContain(".opencode/commands/moka-quick.md");
    expect(result.files).toContain(".opencode/opencode.json");
    expect(result.files).toContain(".claude/hooks/check.sh");
    expect(existsSync(join(dir, ".pipeline"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(bootstrappedHostFilesExist(home)).toBe(true);
    expect(existsSync(join(home, ".claude/hooks/check.sh"))).toBe(true);
    const opencode = JSON.parse(
      readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8")
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
    const result = await initPipelineProject({
      cwd: dir,
      hookInstaller: installMockHooks,
      rulesInstaller: noopRulesInstaller,
      skillInstaller: installMockSkills,
    });
    const output = formatPipelineInitResult(result);

    expect(output).toContain("Initialized package-owned pipeline support:");
    expect(output).toContain("per-machine");
    expect(output).toContain("generated .opencode/opencode.json");
    expect(output).toContain(
      "no repo-local pipeline config files were created"
    );
  });

  it("does not write generated host resources when skill installation fails", async () => {
    await expect(
      initPipelineProject({
        cwd: dir,
        hookInstaller: installMockHooks,
        rulesInstaller: noopRulesInstaller,
        skillInstaller: () => Promise.reject(new Error("skills missing")),
      })
    ).rejects.toThrow("skills missing");

    expect(existsSync(join(dir, ".pipeline"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(home, ".config/opencode/opencode.json"))).toBe(
      false
    );
    expect(existsSync(join(home, ".claude/hooks/check.sh"))).toBe(false);
  });

  it("does not report initialized when hook installation fails", async () => {
    await expect(
      initPipelineProject({
        cwd: dir,
        hookInstaller: () => Promise.reject(new Error("hooks missing")),
        skillInstaller: installMockSkills,
      })
    ).rejects.toThrow("hooks missing");
  });

  it("does not modify existing repo-local pipeline files", async () => {
    mkdirSync(join(dir, ".pipeline"), { recursive: true });
    writeFileSync(join(dir, ".pipeline", "pipeline.yaml"), "custom: true\n");

    await initPipelineProject({
      cwd: dir,
      hookInstaller: installMockHooks,
      rulesInstaller: noopRulesInstaller,
      skillInstaller: installMockSkills,
    });

    expect(readFileSync(join(dir, ".pipeline", "pipeline.yaml"), "utf8")).toBe(
      "custom: true\n"
    );
    expect(existsSync(join(dir, ".pipeline", "profiles.yaml"))).toBe(false);
    expect(existsSync(join(dir, ".pipeline", "runners.yaml"))).toBe(false);
  });

  it("forces the hook install by default so stale harness files are refreshed", async () => {
    vi.clearAllMocks();

    // Default hookInstaller path (no hookInstaller injected). A bare `moka init`
    // owns and refreshes the per-machine harness.
    await initPipelineProject({
      cwd: dir,
      rulesInstaller: noopRulesInstaller,
      skillInstaller: installMockSkills,
    });

    expect(installHooks).toHaveBeenCalledWith({
      check: undefined,
      dryRun: undefined,
      force: true,
    });
  });

  it("forces generated command files by default so stale harness files are refreshed", async () => {
    const commandPath = join(
      home,
      ".config",
      "opencode",
      "commands",
      "moka-execute.md"
    );
    mkdirSync(dirname(commandPath), { recursive: true });
    writeFileSync(commandPath, "manual stale command\n");

    await initPipelineProject({
      cwd: dir,
      hookInstaller: installMockHooks,
      rulesInstaller: noopRulesInstaller,
      skillInstaller: installMockSkills,
    });

    expect(readFileSync(commandPath, "utf8")).not.toBe(
      "manual stale command\n"
    );
  });

  it("forwards --force to the hook install so a version-skewed settings.json is refreshed", async () => {
    vi.clearAllMocks();

    // The runner DAG runs `moka init --force` so the image's pre-baked
    // ~/.claude/settings.json is refreshed instead of failing the "manually
    // edited" guard during pod setup.
    await initPipelineProject({
      cwd: dir,
      force: true,
      rulesInstaller: noopRulesInstaller,
      skillInstaller: installMockSkills,
    });

    expect(installHooks).toHaveBeenCalledWith({
      check: undefined,
      dryRun: undefined,
      force: true,
    });
  });

  it("skips the network skill install when verifying with --check", async () => {
    // Populate the harness first so the real installCommands --check pass finds
    // current files instead of throwing "missing".
    await initPipelineProject({
      cwd: dir,
      hookInstaller: installMockHooks,
      rulesInstaller: noopRulesInstaller,
      skillInstaller: installMockSkills,
    });

    const skillInstaller = vi.fn(() => Promise.resolve());
    await initPipelineProject({
      check: true,
      cwd: dir,
      hookInstaller: installMockHooks,
      rulesInstaller: noopRulesInstaller,
      skillInstaller,
    });

    expect(skillInstaller).not.toHaveBeenCalled();
  });

  it("formats --check as a verify, not an install", async () => {
    await initPipelineProject({
      cwd: dir,
      hookInstaller: installMockHooks,
      rulesInstaller: noopRulesInstaller,
      skillInstaller: installMockSkills,
    });

    const result = await initPipelineProject({
      check: true,
      cwd: dir,
      hookInstaller: installMockHooks,
      rulesInstaller: noopRulesInstaller,
      skillInstaller: installMockSkills,
    });
    const output = formatPipelineInitResult(result, { check: true });

    expect(output).toContain(
      "Verified package-owned pipeline support is current:"
    );
    expect(output).toContain("harness verified; no changes written");
    expect(output).not.toContain("Initialized");
  });

  it("writes into the per-machine host dirs, not the repo", async () => {
    const result = await initPipelineProject({
      cwd: dir,
      hookInstaller: installMockHooks,
      rulesInstaller: noopRulesInstaller,
      skillInstaller: installMockSkills,
    });

    // Generated host files land in the redirected global dirs, not the repo.
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
    expect(formatPipelineInitResult(result)).toContain("per-machine");
  });

  it("clean-replaces global skills: wipes stale installs before the additive add", async () => {
    // Pre-seed a since-renamed/removed skill in every global location the skills
    // CLI manages for the three agents: each agent's symlink farm, the shared
    // master store (~/.agents/skills), and the lock file. A prior `moka init`
    // would have left these behind; the additive `npx skills add` never prunes.
    const staleName = "stale-renamed-skill";
    const staleSkillDirs = [
      join(home, ".claude", "skills", staleName),
      join(home, ".codex", "skills", staleName),
      join(home, ".config", "opencode", "skills", staleName),
      join(home, ".agents", "skills", staleName),
    ];
    for (const skillDir of staleSkillDirs) {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${staleName}\n---\n`
      );
    }
    const lockPath = join(home, ".agents", ".skill-lock.json");
    writeFileSync(
      lockPath,
      JSON.stringify({ skills: { [staleName]: {} }, version: 3 })
    );
    const staleTargets = [...staleSkillDirs, lockPath];

    // Capture filesystem state at the moment `npx skills add` runs to prove the
    // clean happens BEFORE the additive install, not after.
    let staleGoneWhenAddRan: boolean | undefined;
    execaSpy.onCall = (file, args) => {
      if (file === "npx" && args.includes("add")) {
        staleGoneWhenAddRan = staleTargets.every(
          (target) => !existsSync(target)
        );
      }
    };

    // No skillInstaller injected → the real installDefaultSkills (clean + add)
    // runs; execa is mocked so `npx skills add` never hits the network.
    await initPipelineProject({
      cwd: dir,
      hookInstaller: installMockHooks,
      rulesInstaller: noopRulesInstaller,
    });

    expect(vi.mocked(execa)).toHaveBeenCalled();
    expect(staleGoneWhenAddRan).toBe(true);
    for (const target of staleTargets) {
      expect(existsSync(target)).toBe(false);
    }
  });
});
