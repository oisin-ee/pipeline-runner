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
  DEFAULT_SKILL_INSTALLS,
} from "../src/mcp/bootstrap.js";
import {
  defaultPipelineScaffoldFiles,
  initPipelineProject,
  installDefaultSkillsWithCli,
  type PipelineSkillInstaller,
} from "../src/pipeline-init.js";
import {
  standardOutputSchemaJson,
  standardOutputSchemaNames,
  standardOutputSchemaPath,
} from "../src/standard-output-schemas.js";

const mockExeca = vi.mocked(execa);
const ORIGINAL_PIPELINE_MCP_GATEWAY_AUTHORIZATION =
  process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
const BANNED_DEFAULTS_RE =
  /atlassian|jira|linear|confluence|compass|sentry|deepwiki/i;
const GITHUB_WRITE_MCP_RE = /api\.githubcopilot\.com\/mcp\/(?!readonly)/;

beforeEach(() => {
  mockExeca.mockReset();
  mockExeca.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" } as any);
});

afterEach(() => {
  if (ORIGINAL_PIPELINE_MCP_GATEWAY_AUTHORIZATION === undefined) {
    delete process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
  } else {
    process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION =
      ORIGINAL_PIPELINE_MCP_GATEWAY_AUTHORIZATION;
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
      skillInstaller: fakeSkillInstaller,
      ...options,
    });

  it("does not create repo-local pipeline config when no config exists", async () => {
    const result = await init();

    expect(result.files).toEqual([]);
    expect(result.files).not.toContain(".mcp.json");
    expect(existsSync(join(dir, ".pipeline"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
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
    expect(
      config.profiles["pipeline-epic-router"].instructions.inline
    ).toContain("Route epic sub-tickets");
    expect(
      config.profiles["pipeline-thermo-nuclear-reviewer"].instructions.inline
    ).toContain("final code quality review");
    expect(config.skills).toEqual({});
    expect(
      config.profiles["pipeline-schedule-planner"].instructions.inline
    ).toContain("Generate exactly one workflow");
    expect(config.runners.codex.model).toBe("gpt-5.5");
    expect(config.mcp_gateway).toMatchObject({
      default_profile: "default",
      mode: "local",
      provider: "toolhive",
      authorization_env: "PIPELINE_MCP_GATEWAY_AUTHORIZATION",
      url_env: "PIPELINE_MCP_GATEWAY_URL",
    });
    expect(Object.keys(config.mcp_gateway?.backends ?? {}).sort()).toEqual([
      "backlog",
      "context7",
      "fallow",
      "qdrant",
      "serena",
      "uidotsh",
    ]);
    expect(config.mcp_servers).toEqual({});
    expect(config.profiles["pipeline-researcher"].mcp_servers).toEqual([
      "pipeline-gateway",
    ]);
    expect(config.profiles["pipeline-code-writer"].output).toMatchObject({
      format: "json_schema",
      schema_path: ".pipeline/schemas/implementation.schema.json",
      repair: {
        enabled: true,
        max_attempts: 1,
      },
    });
    expect(config.profiles["pipeline-test-writer"].output).toMatchObject({
      format: "json_schema",
      schema_path: ".pipeline/schemas/implementation.schema.json",
      repair: {
        enabled: true,
        max_attempts: 1,
      },
    });
  });

  it("keeps prompt files, schema files, and host resource inputs package-owned", async () => {
    await init();
    const files = defaultPipelineScaffoldFiles();

    for (const path of [
      ".pipeline/prompts/researcher.md",
      ".pipeline/prompts/test-writer.md",
      ".pipeline/prompts/epic-router.md",
      ".pipeline/prompts/acceptance-reviewer.md",
      ".pipeline/prompts/code-writer.md",
      ".pipeline/prompts/verifier.md",
      ".pipeline/prompts/learner.md",
      ".pipeline/schemas/research.schema.json",
      ".pipeline/schemas/implementation.schema.json",
      ".pipeline/schemas/epic-plan.schema.json",
      ".pipeline/schemas/acceptance.schema.json",
      ".pipeline/schemas/review.schema.json",
      ".pipeline/schemas/verify.schema.json",
      ".pipeline/schemas/learn.schema.json",
      ".pipeline/skills/schedule-graph-shaping/SKILL.md",
      ".pipeline/host-resources/codex.md",
      ".pipeline/host-resources/opencode.md",
    ]) {
      expect(files[path]).toBeTruthy();
      expect(existsSync(join(dir, path))).toBe(false);
    }
    expect(files[".pipeline/prompts/orchestrator.md"]).toContain(
      "Only package-configured gates are blocking"
    );
    expect(files[".pipeline/prompts/code-writer.md"]).toContain(
      "Every `changes[]` entry must include `summary`, `why`, and `files`."
    );
    expect(files[".pipeline/prompts/code-writer.md"]).toContain(
      "Do not wrap the JSON in Markdown fences"
    );
    expect(files[".pipeline/prompts/researcher.md"]).toContain(
      "Call `qdrant-find` before local inspection when the qdrant MCP server is available."
    );
    expect(files[".pipeline/prompts/researcher.md"]).toContain(
      "collection_name equal to the repository directory basename"
    );
    expect(files[".pipeline/prompts/learner.md"]).toContain(
      "Call `qdrant-store` with collection_name equal to the repository directory basename"
    );
    expect(files[".pipeline/prompts/schedule-planner.md"]).toContain(
      "constrained agent graph"
    );
    expect(files[".pipeline/prompts/schedule-planner.md"]).toContain(
      "Assign each work unit to explicit generated agent nodes"
    );
    expect(files[".pipeline/prompts/schedule-planner.md"]).toContain(
      "Generate exactly one workflow named `root`"
    );
    expect(files[".pipeline/prompts/schedule-planner.md"]).toContain(
      "Do not use `kind: workflow`"
    );
    expect(files[".pipeline/prompts/schedule-planner.md"]).toContain(
      "task_context.id"
    );
    expect(files[".pipeline/prompts/schedule-planner.md"]).toContain(
      "scheduler hydrates them"
    );
    expect(files[".pipeline/prompts/schedule-planner.md"]).toContain(
      "Shape the graph by intent, not by ticket count."
    );
    expect(files[".pipeline/prompts/schedule-planner.md"]).toContain(
      "Return exactly one YAML document and nothing else"
    );
    expect(files[".pipeline/prompts/schedule-planner.md"]).toContain(
      "Do not use compact inline mappings"
    );
    expect(files[".pipeline/skills/schedule-graph-shaping/SKILL.md"]).toContain(
      "Use RED nodes for test strategy, not ticket counting."
    );
    expect(files[".pipeline/profiles.yaml"]).not.toContain(
      "skills: [research, scope]"
    );
  });

  it("generates standard output schema files from the package registry", () => {
    const files = defaultPipelineScaffoldFiles();

    for (const name of standardOutputSchemaNames) {
      expect(files[standardOutputSchemaPath(name)]).toBe(
        `${standardOutputSchemaJson(name)}\n`
      );
    }
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
      "Treat package-configured gates as authoritative."
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

  it("installs default skills without making them repo-local config", async () => {
    await init();

    const config = loadPipelineConfig(dir);
    expect(config.skills).toEqual({});
    expect(config.profiles["pipeline-researcher"].skills).toBeUndefined();
    expect(
      readFileSync(join(dir, ".agents/skills/research/SKILL.md"), "utf8")
    ).toContain("name: research");
  });

  it("keeps banned generated MCP defaults out of package defaults", async () => {
    await init();

    const generated = defaultPipelineScaffoldFiles()[".pipeline/profiles.yaml"];
    expect(generated).not.toMatch(BANNED_DEFAULTS_RE);
    expect(generated).not.toMatch(GITHUB_WRITE_MCP_RE);
    expect(generated).toContain("mcp_gateway:");
    expect(generated).toContain("backends:");
    expect(generated).toContain("workspace_path_source: PIPELINE_TARGET_PATH");
    expect(generated).toContain("mcp_servers: [pipeline-gateway]");
    expect(generated).not.toContain("path: .mcp.json");
    expect(generated).not.toContain("uvx");
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

  it("does not write scaffold files when skill installation fails", async () => {
    await expect(
      initPipelineProject({
        cwd: dir,
        skillInstaller: () => Promise.reject(new Error("skills missing")),
      })
    ).rejects.toThrow("skills missing");

    expect(existsSync(join(dir, ".pipeline", "pipeline.yaml"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });

  it("does not overwrite existing repo files without --overwrite", async () => {
    await init();
    mkdirSync(join(dir, ".pipeline"), { recursive: true });
    writeFileSync(join(dir, ".pipeline", "pipeline.yaml"), "custom: true\n");

    await init();
    expect(readFileSync(join(dir, ".pipeline", "pipeline.yaml"), "utf8")).toBe(
      "custom: true\n"
    );
  });

  it("does not complete partial repo-local scaffold files", async () => {
    mkdirSync(join(dir, ".pipeline"), { recursive: true });
    writeFileSync(
      join(dir, ".pipeline", "pipeline.yaml"),
      defaultPipelineScaffoldFiles()[".pipeline/pipeline.yaml"]
    );

    await init();

    expect(existsSync(join(dir, ".pipeline", "profiles.yaml"))).toBe(false);
    expect(existsSync(join(dir, ".pipeline", "runners.yaml"))).toBe(false);
  });

  it("does not overwrite existing repo files when requested", async () => {
    await init();
    mkdirSync(join(dir, ".pipeline"), { recursive: true });
    writeFileSync(join(dir, ".pipeline", "pipeline.yaml"), "custom: true\n");

    await init({ overwrite: true });

    expect(readFileSync(join(dir, ".pipeline", "pipeline.yaml"), "utf8")).toBe(
      "custom: true\n"
    );
  });

  it("keeps the scaffold manifest complete", () => {
    const files = Object.keys(defaultPipelineScaffoldFiles()).sort();

    expect(files.some((path) => path.startsWith(".agents/skills/"))).toBe(
      false
    );
    expect(files).toEqual([
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
      ".pipeline/schemas/implementation.schema.json",
      ".pipeline/schemas/learn.schema.json",
      ".pipeline/schemas/research.schema.json",
      ".pipeline/schemas/review.schema.json",
      ".pipeline/schemas/verify.schema.json",
      ".pipeline/skills/schedule-graph-shaping/SKILL.md",
    ]);
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
