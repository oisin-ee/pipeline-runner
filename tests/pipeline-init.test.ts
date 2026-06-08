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

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { loadPipelineConfig } from "../src/config";
import {
  DEFAULT_INSTALL_MANIFEST,
  DEFAULT_SKILL_INSTALLS,
} from "../src/mcp/bootstrap";
import {
  formatPipelineInitResult,
  initPipelineProject,
  installDefaultSkillsWithCli,
  type PipelineSkillInstaller,
} from "../src/pipeline-init";

const mockExeca = vi.mocked(execa);

beforeEach(() => {
  mockExeca.mockReset();
});

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
      skillInstaller: fakeSkillInstaller,
      ...options,
    });

  it("bootstraps skills and generated host resources without repo-local pipeline config", async () => {
    const result = await init();

    expect(result.files).toContain(".agents/skills/pipe/SKILL.md");
    expect(result.files).toContain(".opencode/commands/pipe.md");
    expect(result.files).toContain(".codex/config.toml");
    expect(result.files).toContain(".opencode/opencode.json");
    expect(existsSync(join(dir, ".pipeline"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(dir, ".agents/skills/research/SKILL.md"))).toBe(
      true
    );
    expect(existsSync(join(dir, ".agents/skills/pipe/SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".opencode/commands/pipe.md"))).toBe(true);
    expect(existsSync(join(dir, ".codex/config.toml"))).toBe(true);
    expect(existsSync(join(dir, ".opencode/opencode.json"))).toBe(true);
    expect(readFileSync(join(dir, ".codex/config.toml"), "utf8")).toContain(
      "[mcp_servers.pipeline-gateway]"
    );
    const opencode = JSON.parse(
      readFileSync(join(dir, ".opencode/opencode.json"), "utf8")
    );
    expect(opencode.mcp["pipeline-gateway"]).toMatchObject({
      type: "remote",
      url: "http://127.0.0.1:4483/mcp",
    });

    const config = loadPipelineConfig(dir);
    expect(config.default_workflow).toBe("default");
    expect(config.entrypoints.pipe).toMatchObject({
      schedule: "pipe-schedule",
    });
    expect(config.entrypoints.epic).toMatchObject({
      schedule: "epic-schedule",
    });
    expect(config.profiles["pipeline-researcher"].mcp_servers).toEqual([
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
    expect(output).toContain("generated .codex/config.toml");
    expect(output).toContain("generated .opencode/opencode.json");
    expect(output).toContain(
      "no repo-local pipeline config files were created"
    );
  });

  it("loads default installs from the package manifest", () => {
    const manifest = JSON.parse(
      readFileSync("defaults/install-manifest.json", "utf8")
    ) as {
      skills: unknown[];
      version: number;
    };

    expect(DEFAULT_INSTALL_MANIFEST.version).toBe(1);
    expect(DEFAULT_SKILL_INSTALLS).toEqual(manifest.skills);
    expect("mcps" in manifest).toBe(false);
  });

  it("installs default skills with the skills CLI", async () => {
    await installDefaultSkillsWithCli(
      [{ source: "oisincoveney/skills", args: ["--agent", "codex"] }],
      dir
    );

    expect(mockExeca).toHaveBeenCalledWith(
      "npx",
      ["--yes", "skills", "add", "oisincoveney/skills", "--agent", "codex"],
      expect.objectContaining({ cwd: dir })
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
    expect(existsSync(join(dir, ".codex/config.toml"))).toBe(false);
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

const DEFAULT_TEST_SKILLS = [
  "critique",
  "diagnose",
  "doubt",
  "execute",
  "fix",
  "grill",
  "improve",
  "library-first-development",
  "migrate",
  "optimize",
  "quality-gate",
  "research",
  "scope",
  "secure",
  "spec",
  "test",
  "trace",
  "verify",
];

const fakeSkillInstaller: PipelineSkillInstaller = (_specs, cwd) => {
  for (const skill of DEFAULT_TEST_SKILLS) {
    const path = join(cwd, ".agents", "skills", skill, "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${skill}\n---\n\n# ${skill}\n`);
  }
  return Promise.resolve();
};
