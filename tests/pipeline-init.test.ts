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
import { loadPipelineConfig } from "../src/config";
import {
  type HarnessScope,
  resolveHarnessTarget,
} from "../src/install-commands/shared";
import {
  formatPipelineInitResult,
  initPipelineProject,
  refreshAgentHarnesses,
} from "../src/pipeline-init";

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

async function installMockHooks(
  cwd: string,
  scope: HarnessScope
): Promise<{ files: string[] }> {
  await Promise.resolve();
  const path = resolveHarnessTarget(scope, cwd, ".claude/hooks/check.sh");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\necho hook\n");
  return { files: [".claude/hooks/check.sh"] };
}

interface GitCall {
  args: string[];
  command: string;
}

function createGitRecorder(
  options: { cachedDiffExitCode?: number; stagedFiles?: string[] } = {}
) {
  const calls: GitCall[] = [];
  const run = (command: string, args: string[]) => {
    calls.push({ args, command });
    if (args.join(" ") === "diff --cached --quiet") {
      return Promise.resolve({
        exitCode: options.cachedDiffExitCode ?? 1,
        stderr: "",
        stdout: "",
      });
    }
    if (args.join(" ") === "diff --cached --name-only") {
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: (options.stagedFiles ?? []).join("\n"),
      });
    }
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: "true\n" });
  };
  return { calls, run };
}

function bootstrappedHostFilesExist(root: string): boolean {
  return [
    ".agents/skills/research/SKILL.md",
    ".opencode/commands/moka-execute.md",
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

  // Repo-local (project) scope keeps generated files under `dir`, which the
  // filesystem assertions below depend on. Global-scope behaviour is covered
  // in the dedicated describe block further down (with redirected host dirs).
  const init = (options: Parameters<typeof initPipelineProject>[0] = {}) =>
    initPipelineProject({
      cwd: dir,
      hookInstaller: installMockHooks,
      scope: "project",
      skillInstaller: installMockSkills,
      ...options,
    });

  it("bootstraps skills and generated host resources without repo-local pipeline config", async () => {
    const result = await init();

    expect(result.files).toContain(".opencode/commands/moka-execute.md");
    expect(result.files).toContain(".opencode/commands/moka-quick.md");
    expect(result.files).toContain(".opencode/opencode.json");
    expect(result.files).toContain(".claude/hooks/check.sh");
    expect(existsSync(join(dir, ".pipeline"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(bootstrappedHostFilesExist(dir)).toBe(true);
    expect(existsSync(join(dir, ".claude/hooks/check.sh"))).toBe(true);
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

  it("reports project scope as repo-local", async () => {
    const result = await init({ scope: "project" });

    expect(result.scope).toBe("project");
    expect(formatPipelineInitResult(result)).toContain("repo-local");
  });

  it("does not write generated host resources when skill installation fails", async () => {
    await expect(
      initPipelineProject({
        cwd: dir,
        hookInstaller: installMockHooks,
        skillInstaller: () => Promise.reject(new Error("skills missing")),
      })
    ).rejects.toThrow("skills missing");

    expect(existsSync(join(dir, ".pipeline"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(dir, ".opencode/opencode.json"))).toBe(false);
    expect(existsSync(join(dir, ".claude/hooks/check.sh"))).toBe(false);
  });

  it("does not report initialized when hook installation fails", async () => {
    await expect(
      initPipelineProject({
        cwd: dir,
        hookInstaller: () => Promise.reject(new Error("hooks missing")),
        scope: "project",
        skillInstaller: installMockSkills,
      })
    ).rejects.toThrow("hooks missing");
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

  it("refreshes harnesses, stages only owned resources, and commits with the default message", async () => {
    const git = createGitRecorder();

    const result = await refreshAgentHarnesses({
      commandRunner: git.run,
      cwd: dir,
      hookInstaller: installMockHooks,
      scope: "project",
      skillInstaller: installMockSkills,
    });

    expect(result.committed).toBe(true);
    expect(result.commitMessage).toBe("chore: update agent harnesses");
    expect(git.calls).toContainEqual({
      command: "git",
      args: ["commit", "--no-verify", "-m", "chore: update agent harnesses"],
    });
    const addCall = git.calls.find((call) => call.args[0] === "add");
    expect(addCall?.args).toContain(".opencode");
    expect(addCall?.args).toContain(".claude/commands");
    expect(addCall?.args).toContain(".claude/hooks");
    expect(addCall?.args).toContain(".agents/skills");
    expect(addCall?.args).not.toContain(".codex/skills");
    expect(addCall?.args).not.toContain(".");
  });

  it("forwards custom commit messages when refreshing project-scope harnesses", async () => {
    const git = createGitRecorder();

    const result = await refreshAgentHarnesses({
      commandRunner: git.run,
      commitMessage: "chore: refresh moka harnesses",
      cwd: dir,
      hookInstaller: installMockHooks,
      scope: "project",
      skillInstaller: installMockSkills,
    });

    expect(result.scope).toBe("project");
    expect(result.commitMessage).toBe("chore: refresh moka harnesses");
    expect(git.calls).toContainEqual({
      command: "git",
      args: ["commit", "--no-verify", "-m", "chore: refresh moka harnesses"],
    });
  });

  it("skips the commit when refreshed owned resources are already current", async () => {
    const git = createGitRecorder({ cachedDiffExitCode: 0 });

    const result = await refreshAgentHarnesses({
      commandRunner: git.run,
      cwd: dir,
      hookInstaller: installMockHooks,
      scope: "project",
      skillInstaller: installMockSkills,
    });

    expect(result.committed).toBe(false);
    expect(git.calls.some((call) => call.args[0] === "commit")).toBe(false);
  });

  it("refuses to commit when unrelated files are already staged", async () => {
    const git = createGitRecorder({
      stagedFiles: [".opencode/opencode.json", "src/app.ts"],
    });

    await expect(
      refreshAgentHarnesses({
        commandRunner: git.run,
        cwd: dir,
        hookInstaller: installMockHooks,
        scope: "project",
        skillInstaller: installMockSkills,
      })
    ).rejects.toThrow(
      "Refusing to commit because unrelated files are already staged."
    );

    expect(git.calls.some((call) => call.args[0] === "commit")).toBe(false);
  });
});

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
    ]) {
      savedEnv[key] = process.env[key];
    }
    // Redirect the per-machine host dirs into the temp home so the global
    // install never touches the real ~/.claude, ~/.codex, ~/.config/opencode.
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    process.env.CODEX_HOME = join(home, ".codex");
    process.env.OPENCODE_CONFIG_DIR = join(home, ".config", "opencode");
  });

  afterEach(() => {
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

  it("defaults to global scope and writes into the per-machine host dirs", async () => {
    const result = await initPipelineProject({
      cwd: dir,
      hookInstaller: installMockHooks,
      skillInstaller: installMockSkills,
    });

    expect(result.scope).toBe("global");
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

  it("refreshes the global harness without staging or committing", async () => {
    const git = createGitRecorder();

    const result = await refreshAgentHarnesses({
      commandRunner: git.run,
      cwd: dir,
      hookInstaller: installMockHooks,
      skillInstaller: installMockSkills,
    });

    expect(result.scope).toBe("global");
    expect(result.committed).toBe(false);
    expect(git.calls).toEqual([]);
  });
});
