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
import { loadPipelineConfig } from "../src/config.js";
import {
  DEFAULT_INSTALL_MANIFEST,
  DEFAULT_MCP_INSTALLS,
  DEFAULT_SKILL_INSTALLS,
  installDefaultMcpsWithCli,
  PipelineMcpInstallError,
  type PipelineMcpInstaller,
} from "../src/mcp/bootstrap.js";
import {
  defaultPipelineScaffoldFiles,
  initPipelineProject,
  installDefaultSkillsWithCli,
  PipelineInitError,
  type PipelineSkillInstaller,
} from "../src/pipeline-init.js";

const mockExeca = vi.mocked(execa);
const ORIGINAL_MEMORY_MCP_BASIC_AUTH = process.env.MEMORY_MCP_BASIC_AUTH;
const BANNED_DEFAULTS_RE =
  /atlassian|jira|linear|confluence|compass|sentry|deepwiki/i;
const GITHUB_WRITE_MCP_RE = /api\.githubcopilot\.com\/mcp\/(?!readonly)/;

beforeEach(() => {
  mockExeca.mockReset();
  mockExeca.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" } as any);
});

afterEach(() => {
  if (ORIGINAL_MEMORY_MCP_BASIC_AUTH === undefined) {
    delete process.env.MEMORY_MCP_BASIC_AUTH;
  } else {
    process.env.MEMORY_MCP_BASIC_AUTH = ORIGINAL_MEMORY_MCP_BASIC_AUTH;
  }
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
      mcpInstaller: fakeMcpInstaller,
      skillInstaller: fakeSkillInstaller,
      ...options,
    });

  it("creates the required config files when no config exists", async () => {
    const result = await init();

    expect(result.files).toContain(".pipeline/pipeline.yaml");
    expect(result.files).toContain(".pipeline/profiles.yaml");
    expect(result.files).toContain(".pipeline/runners.yaml");
    expect(result.files).toContain(".mcp.json");
    expect(existsSync(join(dir, ".pipeline", "pipeline.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".pipeline", "profiles.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".pipeline", "runners.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    expect(existsSync(join(dir, ".agents/skills/research/SKILL.md"))).toBe(
      true
    );
    const config = loadPipelineConfig(dir);
    expect(config.default_workflow).toBe("default");
    expect(config.entrypoints.epic).toMatchObject({
      schedule: "epic-schedule",
    });
    expect(config.schedules["epic-schedule"]).toMatchObject({
      baseline: "epic",
      planner_profile: "pipeline-schedule-planner",
    });
    expect(config.schedules["pipe-schedule"]).toMatchObject({
      baseline: "pipe",
      planner_profile: "pipeline-schedule-planner",
    });
    expect(config.workflows["epic-drain"].nodes.map((node) => node.id)).toEqual(
      ["research", "plan", "implement", "merge", "review"]
    );
    expect(config.workflows.infra.nodes.map((node) => node.id)).toEqual([
      "research",
      "red",
      "green",
      "acceptance",
      "verify",
      "learn",
    ]);
    expect(config.profiles["pipeline-epic-router"]).toMatchObject({
      output: {
        format: "json_schema",
        schema_path: ".pipeline/schemas/epic-plan.schema.json",
      },
    });
    expect(config.profiles["pipeline-thermo-nuclear-reviewer"]).toMatchObject({
      instructions: {
        path: ".agents/skills/critique/SKILL.md",
      },
      skills: ["critique"],
      output: {
        format: "json_schema",
        schema_path: ".pipeline/schemas/review.schema.json",
      },
    });
    expect(config.skills["schedule-graph-shaping"]).toMatchObject({
      path: ".pipeline/skills/schedule-graph-shaping/SKILL.md",
    });
    expect(config.profiles["pipeline-schedule-planner"].skills).toEqual([
      "schedule-graph-shaping",
    ]);
    expect(config.runners.codex.model).toBe("gpt-5.5");
    expect(config.mcp_servers.serena).toMatchObject({
      args: ["--python", "3.12", "mcpm", "run", "oisin-pipeline-serena"],
      command: "uvx",
    });
    expect(config.mcp_servers.context7).toMatchObject({
      args: ["--python", "3.12", "mcpm", "run", "oisin-pipeline-context7"],
      command: "uvx",
    });
  });

  it("scaffolds prompt files, schema files, and host resource inputs", async () => {
    await init();

    for (const path of [
      ".pipeline/prompts/researcher.md",
      ".pipeline/prompts/test-writer.md",
      ".pipeline/prompts/epic-router.md",
      ".pipeline/prompts/acceptance-reviewer.md",
      ".pipeline/prompts/code-writer.md",
      ".pipeline/prompts/verifier.md",
      ".pipeline/prompts/learner.md",
      ".pipeline/schemas/research.schema.json",
      ".pipeline/schemas/epic-plan.schema.json",
      ".pipeline/schemas/acceptance.schema.json",
      ".pipeline/schemas/review.schema.json",
      ".pipeline/schemas/verify.schema.json",
      ".pipeline/schemas/learn.schema.json",
      ".pipeline/skills/schedule-graph-shaping/SKILL.md",
      ".pipeline/host-resources/codex.md",
      ".pipeline/host-resources/opencode.md",
    ]) {
      expect(existsSync(join(dir, path))).toBe(true);
    }
    expect(
      readFileSync(join(dir, ".pipeline/prompts/orchestrator.md"), "utf8")
    ).toContain(
      "Only gates declared in `.pipeline/pipeline.yaml` are blocking"
    );
    expect(
      readFileSync(join(dir, ".pipeline/prompts/code-writer.md"), "utf8")
    ).toContain(
      "Include typecheck evidence only when a typecheck command exists"
    );
    expect(
      readFileSync(join(dir, ".pipeline/prompts/researcher.md"), "utf8")
    ).toContain(
      "Call `qdrant-find` before local inspection when the qdrant MCP server is available."
    );
    expect(
      readFileSync(join(dir, ".pipeline/prompts/researcher.md"), "utf8")
    ).toContain("collection_name equal to the repository directory basename");
    expect(
      readFileSync(join(dir, ".pipeline/prompts/learner.md"), "utf8")
    ).toContain(
      "Call `qdrant-store` with collection_name equal to the repository directory basename"
    );
    expect(
      readFileSync(join(dir, ".pipeline/prompts/schedule-planner.md"), "utf8")
    ).toContain("constrained agent graph");
    expect(
      readFileSync(join(dir, ".pipeline/prompts/schedule-planner.md"), "utf8")
    ).toContain("Assign each work unit to explicit generated agent nodes");
    expect(
      readFileSync(join(dir, ".pipeline/prompts/schedule-planner.md"), "utf8")
    ).toContain("Generate exactly one workflow named `root`");
    expect(
      readFileSync(join(dir, ".pipeline/prompts/schedule-planner.md"), "utf8")
    ).toContain("Do not use `kind: workflow`");
    expect(
      readFileSync(join(dir, ".pipeline/prompts/schedule-planner.md"), "utf8")
    ).toContain("task_context.id");
    expect(
      readFileSync(join(dir, ".pipeline/prompts/schedule-planner.md"), "utf8")
    ).toContain("scheduler hydrates them");
    expect(
      readFileSync(join(dir, ".pipeline/prompts/schedule-planner.md"), "utf8")
    ).toContain("Shape the graph by intent, not by ticket count.");
    expect(
      readFileSync(join(dir, ".pipeline/prompts/schedule-planner.md"), "utf8")
    ).toContain("Return exactly one YAML document and nothing else");
    expect(
      readFileSync(join(dir, ".pipeline/prompts/schedule-planner.md"), "utf8")
    ).toContain("Do not use compact inline mappings");
    expect(
      readFileSync(
        join(dir, ".pipeline/skills/schedule-graph-shaping/SKILL.md"),
        "utf8"
      )
    ).toContain("Use RED nodes for test strategy, not ticket counting.");
    expect(
      readFileSync(join(dir, ".pipeline/profiles.yaml"), "utf8")
    ).not.toContain("skills: [research, scope]");
  });

  it("tells verifier agents not to replace deterministic gates and treats configured gates as authoritative", () => {
    const verifierPrompt =
      defaultPipelineScaffoldFiles()[".pipeline/prompts/verifier.md"];

    expect(verifierPrompt).toContain(
      "Do not invent ad hoc replacements for deterministic gates"
    );
    expect(verifierPrompt).toContain(
      "Do not run built-in deterministic gates manually"
    );
    expect(verifierPrompt).toContain(
      "Treat configured gates declared in `.pipeline/pipeline.yaml` as authoritative."
    );
  });

  it("tells verifier agents not to run semgrep or duplication directly unless debugging those tools", () => {
    const verifierPrompt =
      defaultPipelineScaffoldFiles()[".pipeline/prompts/verifier.md"];

    expect(verifierPrompt).toContain(
      "Verifier agents must not run semgrep or duplication directly unless the task specifically asks them to debug those tools."
    );
  });

  it("expresses the default phases as workflow nodes", async () => {
    await init();

    const config = loadPipelineConfig(dir);
    expect(config.workflows.default.nodes.map((node) => node.id)).toEqual([
      "research",
      "red",
      "green",
      "acceptance",
      "verify",
      "learn",
    ]);
    expect(
      config.workflows.default.nodes.every((node) => node.kind === "agent")
    ).toBe(true);
    expect(config.workflows.default.nodes[1].gates?.[0]).toMatchObject({
      id: "red-test-file-policy",
      kind: "changed_files",
    });
    expect(
      config.workflows.default.nodes[3].gates?.map((gate) => gate.id)
    ).toEqual(["acceptance-coverage", "acceptance-verdict"]);
    expect(
      config.workflows.default.nodes[4].gates?.map((gate) => gate.id)
    ).toEqual([
      "verify-typecheck",
      "verify-tests",
      "verify-semgrep",
      "verify-duplication",
      "verify-verdict",
    ]);
  });

  it("installs and points default skills at project skill paths", async () => {
    await init();

    const config = loadPipelineConfig(dir);
    expect(config.skills.research.path).toBe(
      ".agents/skills/research/SKILL.md"
    );
    expect(config.profiles["pipeline-researcher"].skills).toContain("research");
    expect(
      readFileSync(join(dir, ".agents/skills/research/SKILL.md"), "utf8")
    ).toContain("name: research");
  });

  it("keeps banned generated MCP defaults out of the scaffold", async () => {
    await init();

    const generated = [
      readFileSync(join(dir, ".pipeline/profiles.yaml"), "utf8"),
      readFileSync(join(dir, ".mcp.json"), "utf8"),
    ].join("\n");
    expect(generated).not.toMatch(BANNED_DEFAULTS_RE);
    expect(generated).not.toMatch(GITHUB_WRITE_MCP_RE);
    expect(generated).toContain("oisin-pipeline-github-readonly");
  });

  it("registers default MCP servers through MCPM", async () => {
    const registered: string[] = [];

    await initPipelineProject({
      cwd: dir,
      mcpInstaller: (specs) => {
        registered.push(
          ...specs.map((spec) => `${spec.name}:${spec.url ?? ""}`)
        );
        return Promise.resolve(undefined);
      },
      skillInstaller: fakeSkillInstaller,
    });

    expect(registered).toEqual(
      DEFAULT_MCP_INSTALLS.map((spec) => `${spec.name}:${spec.url ?? ""}`)
    );
    expect(registered).toContain(
      "oisin-pipeline-qdrant:https://memory-mcp.momokaya.ee/mcp/"
    );
  });

  it("loads default installs from the package manifest", () => {
    const manifest = JSON.parse(
      readFileSync("defaults/install-manifest.json", "utf8")
    ) as {
      mcps: unknown[];
      skills: unknown[];
      version: number;
    };

    expect(DEFAULT_INSTALL_MANIFEST.version).toBe(1);
    expect(DEFAULT_SKILL_INSTALLS).toEqual(manifest.skills);
    expect(DEFAULT_MCP_INSTALLS).toEqual(manifest.mcps);
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

  it("declares the single memory basic auth source in the default MCP manifest", () => {
    const manifest = JSON.parse(
      readFileSync("defaults/install-manifest.json", "utf8")
    ) as {
      mcps: Array<{
        headers?: {
          Authorization?: {
            sources?: Array<{ env?: string; prefix?: string }>;
          };
        };
        name?: string;
        transport?: string;
        url?: string;
      }>;
    };
    const manifestQdrant = manifest.mcps.find(
      (spec) => spec.name === "oisin-pipeline-qdrant"
    );
    const defaultQdrant = DEFAULT_MCP_INSTALLS.find(
      (spec) => spec.name === "oisin-pipeline-qdrant"
    );

    expect(defaultQdrant).toEqual(manifestQdrant);
    expect(manifestQdrant).toMatchObject({
      name: "oisin-pipeline-qdrant",
      optionalRegistration: true,
      transport: "remote",
      url: "https://memory-mcp.momokaya.ee/mcp/",
    });
    expect(manifestQdrant?.headers?.Authorization?.sources).toEqual([
      { env: "MEMORY_MCP_BASIC_AUTH", prefix: "Basic " },
    ]);
  });

  it("redacts the resolved memory basic auth header from direct MCPM registration failures", async () => {
    process.env.MEMORY_MCP_BASIC_AUTH = "memory-basic-payload";
    mockExeca.mockImplementation(((_command: string, args?: string[]) => {
      if (args?.includes("oisin-pipeline-qdrant")) {
        return Promise.reject({
          shortMessage:
            "Command failed: uvx --python 3.12 mcpm new oisin-pipeline-qdrant --headers Authorization=Basic memory-basic-payload",
          stderr: "remote rejected token memory-basic-payload",
          stdout: "Basic memory-basic-payload",
        });
      }
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
    }) as any);

    let thrown: unknown;
    try {
      await installDefaultMcpsWithCli(DEFAULT_MCP_INSTALLS, dir);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PipelineMcpInstallError);
    const message = String((thrown as Error).message);
    expect(message).toContain(
      "Failed to register MCP server oisin-pipeline-qdrant with MCPM."
    );
    expect(message).toContain("Authorization=[REDACTED]");
    expect(message).not.toContain("memory-basic-payload");
    expect(message).not.toContain("Authorization=Basic memory-basic-payload");
  });

  it("skips optional Qdrant registration when memory credentials are missing", async () => {
    delete process.env.MEMORY_MCP_BASIC_AUTH;

    const result = await installDefaultMcpsWithCli(DEFAULT_MCP_INSTALLS, dir);

    expect(
      mockExeca.mock.calls.some(
        ([_command, args]) =>
          Array.isArray(args) && args.includes("oisin-pipeline-qdrant")
      )
    ).toBe(false);
    expect(result.skipped).toEqual([
      {
        missingEnv: ["MEMORY_MCP_BASIC_AUTH"],
        name: "oisin-pipeline-qdrant",
        reason: "missing Authorization credentials",
      },
    ]);
    expect(
      mockExeca.mock.calls.some(
        ([_command, args]) =>
          Array.isArray(args) && args.includes("oisin-pipeline-backlog")
      )
    ).toBe(true);
  });

  it("does not write scaffold files when MCP registration fails", async () => {
    await expect(
      initPipelineProject({
        cwd: dir,
        mcpInstaller: () => Promise.reject(new Error("mcpm missing")),
        skillInstaller: fakeSkillInstaller,
      })
    ).rejects.toThrow("mcpm missing");

    expect(existsSync(join(dir, ".pipeline", "pipeline.yaml"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(dir, ".agents", "skills"))).toBe(false);
  });

  it("does not write scaffold files when skill installation fails", async () => {
    await expect(
      initPipelineProject({
        cwd: dir,
        mcpInstaller: fakeMcpInstaller,
        skillInstaller: () => Promise.reject(new Error("skills missing")),
      })
    ).rejects.toThrow("skills missing");

    expect(existsSync(join(dir, ".pipeline", "pipeline.yaml"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });

  it("refuses to overwrite existing scaffold files without --overwrite", async () => {
    await init();
    writeFileSync(join(dir, ".pipeline", "pipeline.yaml"), "custom: true\n");

    await expect(init()).rejects.toThrow(PipelineInitError);
  });

  it("allows identical scaffold files when completing a partial init", async () => {
    mkdirSync(join(dir, ".pipeline"), { recursive: true });
    writeFileSync(
      join(dir, ".pipeline", "pipeline.yaml"),
      defaultPipelineScaffoldFiles()[".pipeline/pipeline.yaml"]
    );

    await init();

    expect(existsSync(join(dir, ".pipeline", "profiles.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".pipeline", "runners.yaml"))).toBe(true);
  });

  it("overwrites existing scaffold files when requested", async () => {
    await init();
    writeFileSync(join(dir, ".pipeline", "pipeline.yaml"), "custom: true\n");

    await init({ overwrite: true });

    expect(readFileSync(join(dir, ".pipeline", "pipeline.yaml"), "utf8")).toBe(
      defaultPipelineScaffoldFiles()[".pipeline/pipeline.yaml"]
    );
  });

  it("keeps the scaffold manifest complete", () => {
    const files = Object.keys(defaultPipelineScaffoldFiles()).sort();

    expect(files.some((path) => path.startsWith(".agents/skills/"))).toBe(
      false
    );
    expect(files).toEqual([
      ".mcp.json",
      ".pipeline/host-resources/codex.md",
      ".pipeline/host-resources/opencode.md",
      ".pipeline/pipeline.yaml",
      ".pipeline/profiles.yaml",
      ".pipeline/prompts/acceptance-reviewer.md",
      ".pipeline/prompts/code-writer.md",
      ".pipeline/prompts/epic-router.md",
      ".pipeline/prompts/inspector.md",
      ".pipeline/prompts/learner.md",
      ".pipeline/prompts/orchestrator.md",
      ".pipeline/prompts/researcher.md",
      ".pipeline/prompts/schedule-planner.md",
      ".pipeline/prompts/test-writer.md",
      ".pipeline/prompts/verifier.md",
      ".pipeline/rules/test-first.md",
      ".pipeline/rules/verification.md",
      ".pipeline/runners.yaml",
      ".pipeline/schemas/acceptance.schema.json",
      ".pipeline/schemas/epic-plan.schema.json",
      ".pipeline/schemas/learn.schema.json",
      ".pipeline/schemas/research.schema.json",
      ".pipeline/schemas/review.schema.json",
      ".pipeline/schemas/verify.schema.json",
      ".pipeline/skills/schedule-graph-shaping/SKILL.md",
    ]);
  });
});

const fakeMcpInstaller: PipelineMcpInstaller = () => Promise.resolve(undefined);

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
