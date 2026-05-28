import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPipelineConfig,
  PipelineConfigError,
  type PipelineConfigParts,
  parsePipelineConfigParts,
} from "../src/config.js";

const VALID_RUNNERS_YAML = `
version: 1
runners:
  codex:
    type: codex
    command: codex
    model: gpt-5-runner
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json, jsonl, json_schema]
`;

const VALID_PROFILES_YAML = `
version: 1
rules:
  test-first:
    path: rules/test-first.md
skills:
  repo-research:
    path: .agents/skills/repo-research/SKILL.md
mcp_servers:
  docs:
    command: npx
    args: ["-y", "@example/docs-mcp"]
profiles:
  orchestrator:
    runner: codex
    model: gpt-5-orchestrator
    instructions:
      path: .pipeline/prompts/orchestrator.md
    rules: [test-first]
    skills: [repo-research]
    mcp_servers: [docs]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**"]
    network:
      mode: inherit
  researcher:
    model: gpt-5-agent
    runner: codex
    description: Research the requested change.
    instructions:
      path: .pipeline/prompts/researcher.md
    rules: [test-first]
    skills: [repo-research]
    mcp_servers: [docs]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/research.schema.json
      repair:
        enabled: true
        max_attempts: 1
  test-writer:
    runner: codex
    instructions:
      inline: Write failing tests.
    tools: [read, edit, write, bash]
`;

const VALID_PIPELINE_YAML = `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
  hooks: [announce-complete]
workflows:
  default:
    description: Default workflow.
    nodes:
      - id: research
        kind: agent
        profile: researcher
        retries:
          max_attempts: 3
          backoff_ms: 100
          multiplier: 2
          retry_on: [timeout, exit_nonzero]
        timeout_ms: 5000
      - id: red
        kind: agent
        profile: test-writer
        needs: [research]
hooks:
  announce-complete:
    event: workflow.complete
    kind: command
    command: ["echo", "{{workflow.id}} complete"]
    required: false
    timeout_ms: 30000
`;

const VALID_PARTS: PipelineConfigParts = {
  pipeline: VALID_PIPELINE_YAML,
  profiles: VALID_PROFILES_YAML,
  runners: VALID_RUNNERS_YAML,
};

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeProject(
  parts: PipelineConfigParts = VALID_PARTS,
  writeReferencedFiles = true
): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-config-"));
  tempDirs.push(dir);
  writeProjectFile(dir, ".pipeline/pipeline.yaml", parts.pipeline);
  writeProjectFile(dir, ".pipeline/profiles.yaml", parts.profiles);
  writeProjectFile(dir, ".pipeline/runners.yaml", parts.runners);
  if (writeReferencedFiles) {
    writeProjectFile(dir, "rules/test-first.md", "# Test first\n");
    writeProjectFile(
      dir,
      ".agents/skills/repo-research/SKILL.md",
      "# Repo research\n"
    );
    writeProjectFile(
      dir,
      ".pipeline/prompts/orchestrator.md",
      "Orchestrate this workflow.\n"
    );
    writeProjectFile(
      dir,
      ".pipeline/prompts/researcher.md",
      "Research this repository.\n"
    );
    writeProjectFile(
      dir,
      ".pipeline/schemas/research.schema.json",
      JSON.stringify({ type: "object" })
    );
  }
  return dir;
}

function writeProjectFile(root: string, path: string, content: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function parseParts(parts: Partial<PipelineConfigParts>) {
  return parsePipelineConfigParts({ ...VALID_PARTS, ...parts });
}

function captureConfigError(action: () => unknown): PipelineConfigError {
  try {
    action();
  } catch (err) {
    if (err instanceof PipelineConfigError) {
      return err;
    }
    throw err;
  }
  throw new Error("Expected PipelineConfigError");
}

describe("loadPipelineConfig", () => {
  it("loads a complete valid config from the three required config files", () => {
    const project = makeProject();

    const config = loadPipelineConfig(project);

    expect(config.version).toBe(1);
    expect(config.default_workflow).toBe("default");
    expect(config.runners.codex.type).toBe("codex");
    expect(config.orchestrator.profile).toBe("orchestrator");
    expect(config.profiles.orchestrator.model).toBe("gpt-5-orchestrator");
    expect(config.profiles.researcher.runner).toBe("codex");
    expect(config.profiles.researcher.output?.repair).toEqual({
      enabled: true,
      max_attempts: 1,
    });
    expect(config.workflows.default.nodes.map((node) => node.id)).toEqual([
      "research",
      "red",
    ]);
    expect(config.workflows.default.nodes[0]).toMatchObject({
      retries: {
        backoff_ms: 100,
        max_attempts: 3,
        multiplier: 2,
        retry_on: ["timeout", "exit_nonzero"],
      },
      timeout_ms: 5000,
    });
  });

  it("accepts canonical models and optional host-specific model overrides", () => {
    const config = parseParts({
      profiles: VALID_PROFILES_YAML.replace(
        "    model: gpt-5-agent\n    runner: codex",
        "    model: gpt-5-agent\n    host_models:\n      opencode: openai/gpt-5.3-codex\n    runner: codex"
      ),
      runners: VALID_RUNNERS_YAML.replace(
        "    model: gpt-5-runner",
        "    model: gpt-5-runner\n    host_models:\n      opencode: openai/gpt-5.3-codex"
      ),
    });

    expect(config.runners.codex.host_models?.opencode).toBe(
      "openai/gpt-5.3-codex"
    );
    expect(config.profiles.researcher.host_models?.opencode).toBe(
      "openai/gpt-5.3-codex"
    );
  });

  it("accepts remote HTTP MCP server definitions", () => {
    const config = parseParts({
      profiles: VALID_PROFILES_YAML.replace(
        `mcp_servers:
  docs:
    command: npx
    args: ["-y", "@example/docs-mcp"]`,
        `mcp_servers:
  docs:
    url: https://memory-mcp.momokaya.ee/mcp/
    headers:
      X-Memory-Region: eu
  secure-memory:
    url: https://memory-mcp.momokaya.ee/mcp/
    bearer_token_env_var: MEMORY_MCP_TOKEN`
      ).replace("mcp_servers: [docs]", "mcp_servers: [secure-memory]"),
    });

    expect(config.mcp_servers.docs.url).toBe(
      "https://memory-mcp.momokaya.ee/mcp/"
    );
    expect(config.mcp_servers.docs.headers).toEqual({
      "X-Memory-Region": "eu",
    });
    expect(config.mcp_servers["secure-memory"].bearer_token_env_var).toBe(
      "MEMORY_MCP_TOKEN"
    );
  });

  it("resolves MCP server definitions from mcp-json config files", () => {
    const profiles = VALID_PROFILES_YAML.replace(
      `mcp_servers:
  docs:
    command: npx
    args: ["-y", "@example/docs-mcp"]`,
      `mcp_servers:
  docs:
    ref:
      path: .mcp.json
      id: serena`
    );
    const project = makeProject({ ...VALID_PARTS, profiles });
    writeProjectFile(
      project,
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          serena: {
            command: "uvx",
            args: [
              "--from",
              "git+https://github.com/oraios/serena",
              "serena",
              "start-mcp-server",
            ],
            env: {
              SERENA_TEST: "1",
            },
          },
        },
      })
    );

    const config = loadPipelineConfig(project);

    expect(config.mcp_servers.docs).toEqual({
      command: "uvx",
      args: [
        "--from",
        "git+https://github.com/oraios/serena",
        "serena",
        "start-mcp-server",
      ],
      env: {
        SERENA_TEST: "1",
      },
    });
    expect(config.profiles.researcher.mcp_servers).toEqual(["docs"]);
  });

  it("rejects MCP refs that point at missing mcp-json server ids", () => {
    const profiles = VALID_PROFILES_YAML.replace(
      `mcp_servers:
  docs:
    command: npx
    args: ["-y", "@example/docs-mcp"]`,
      `mcp_servers:
  docs:
    ref:
      path: .mcp.json
      id: missing`
    );
    const project = makeProject({ ...VALID_PARTS, profiles });
    writeProjectFile(
      project,
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          serena: {
            command: "uvx",
          },
        },
      })
    );

    const error = captureConfigError(() => loadPipelineConfig(project));

    expect(error.message).toContain(
      "MCP config '.mcp.json' does not declare server 'missing'"
    );
  });

  it("rejects invalid imported mcp-json server definitions", () => {
    const profiles = VALID_PROFILES_YAML.replace(
      `mcp_servers:
  docs:
    command: npx
    args: ["-y", "@example/docs-mcp"]`,
      `mcp_servers:
  docs:
    ref:
      path: .mcp.json`
    );
    const project = makeProject({ ...VALID_PARTS, profiles });
    writeProjectFile(
      project,
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          docs: {
            command: "uvx",
            url: "https://memory-mcp.momokaya.ee/mcp/",
          },
        },
      })
    );

    const error = captureConfigError(() => loadPipelineConfig(project));

    expect(error.message).toContain("exactly one of command or url");
  });

  it("rejects invalid MCP server transport field combinations", () => {
    const cases = [
      {
        message: "exactly one of command or url",
        server: `
    command: npx
    url: https://memory-mcp.momokaya.ee/mcp/`,
      },
      {
        message: "args are only valid for command MCP servers",
        server: `
    url: https://memory-mcp.momokaya.ee/mcp/
    args: ["bad"]`,
      },
      {
        message: "env is only valid for command MCP servers",
        server: `
    url: https://memory-mcp.momokaya.ee/mcp/
    env: { BAD: value }`,
      },
      {
        message: "headers are only valid for url MCP servers",
        server: `
    command: npx
    headers: { X-Test: value }`,
      },
      {
        message: "bearer_token_env_var is only valid for url MCP servers",
        server: `
    command: npx
    bearer_token_env_var: MEMORY_MCP_TOKEN`,
      },
      {
        message:
          "headers.Authorization cannot be combined with bearer_token_env_var",
        server: `
    url: https://memory-mcp.momokaya.ee/mcp/
    bearer_token_env_var: MEMORY_MCP_TOKEN
    headers:
      Authorization: Bearer token`,
      },
    ];

    for (const item of cases) {
      const error = captureConfigError(() =>
        parseParts({
          profiles: VALID_PROFILES_YAML.replace(
            `  docs:
    command: npx
    args: ["-y", "@example/docs-mcp"]`,
            `  docs:${item.server}`
          ),
        })
      );

      expect(error.message).toContain(item.message);
    }
  });

  it("rejects missing required config files", () => {
    const project = mkdtempSync(join(tmpdir(), "pipeline-config-missing-"));
    tempDirs.push(project);
    writeProjectFile(project, ".pipeline/pipeline.yaml", VALID_PIPELINE_YAML);

    const error = captureConfigError(() => loadPipelineConfig(project));

    expect(error.code).toBe("PIPELINE_CONFIG_MISSING");
    expect(error.message).toContain("Missing required pipeline config files");
    expect(error.message).toContain(".pipeline/profiles.yaml");
    expect(error.message).toContain(".pipeline/runners.yaml");
    expect(error.issues.length).toBe(2);
  });

  it("rejects legacy .pipeline/config.toml when YAML is missing", () => {
    const project = mkdtempSync(join(tmpdir(), "pipeline-config-legacy-"));
    tempDirs.push(project);
    writeProjectFile(project, ".pipeline/config.toml", "[phases]\n");

    const error = captureConfigError(() => loadPipelineConfig(project));

    expect(error.code).toBe("PIPELINE_CONFIG_LEGACY_UNSUPPORTED");
    expect(error.message).toContain("not supported");
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it("rejects malformed YAML with a parse error", () => {
    const project = makeProject(
      { ...VALID_PARTS, pipeline: "version: 1\nworkflows: [" },
      false
    );

    const error = captureConfigError(() => loadPipelineConfig(project));

    expect(error.code).toBe("PIPELINE_CONFIG_PARSE_ERROR");
    expect(error.message).toContain("Failed to parse");
    expect(error.issues.length).toBeGreaterThan(0);
  });
});

describe("parsePipelineConfigParts", () => {
  it("rejects unknown top-level keys in the pipeline file", () => {
    const error = captureConfigError(() =>
      parseParts({ pipeline: `${VALID_PIPELINE_YAML}\nprofiles: {}\n` })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Unrecognized key");
  });

  it("rejects missing runner references", () => {
    const error = captureConfigError(() =>
      parseParts({
        profiles: VALID_PROFILES_YAML.replace(
          "runner: codex",
          "runner: missing-runner"
        ),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("missing runner 'missing-runner'");
  });

  it("requires a configured orchestrator profile", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace(
          "profile: orchestrator",
          "profile: missing-orchestrator"
        ),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("orchestrator.profile");
  });

  it("validates orchestrator references and runner capabilities", () => {
    const profiles = VALID_PROFILES_YAML.replace(
      "mcp_servers: [docs]\n    tools: [read, list, grep, glob, bash]\n    filesystem:",
      "mcp_servers: [missing]\n    tools: [read, write]\n    filesystem:"
    );
    const runners = VALID_RUNNERS_YAML.replace(
      "tools: [read, list, grep, glob, bash, edit, write]",
      "tools: [read]"
    );

    const error = captureConfigError(() => parseParts({ profiles, runners }));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("profiles.orchestrator.mcp_servers");
    expect(error.message).toContain("missing MCP server 'missing'");
    expect(error.message).toContain("profiles.orchestrator.tools");
    expect(error.message).toContain("does not support tool 'write'");
  });

  it("rejects missing profile references in workflow nodes", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace(
          "profile: test-writer",
          "profile: missing-profile"
        ),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("missing profile 'missing-profile'");
  });

  it("accepts entrypoints, task-context resolver config, and generic gate kinds", () => {
    const config = parseParts({
      pipeline: `
version: 1
default_workflow: default
task_context:
  type: markdown
  glob: backlog/tasks/*.md
entrypoints:
  quick:
    workflow: default
    description: Quick pipeline
hooks:
  announce-complete:
    event: workflow.complete
    kind: command
    command: ["echo", "done"]
    env:
      passthrough: [PATH]
      set: { PIPELINE_HOOK: "1" }
    output_limit_bytes: 1024
    payload: stdin
    trusted: true
orchestrator:
  profile: orchestrator
  hooks: [announce-complete]
workflows:
  default:
    nodes:
      - id: research
        kind: agent
        profile: researcher
        gates:
          - id: verdict-pass
            kind: verdict
            target: stdout
          - id: ac-pass
            kind: acceptance
            target: stdout
          - id: files
            kind: changed_files
            changed_files:
              require_any: ["tests/**/*.test.ts"]
              deny: ["src/**/*.ts"]
`,
    });

    expect(config.entrypoints.quick.workflow).toBe("default");
    expect(config.task_context?.type).toBe("markdown");
    expect(
      config.workflows.default.nodes[0].gates?.map((gate) => gate.kind)
    ).toEqual(["verdict", "acceptance", "changed_files"]);
  });

  it("rejects entrypoints pointing at missing workflows", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: `
version: 1
default_workflow: default
entrypoints:
  bad:
    workflow: missing
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: research
        kind: agent
        profile: researcher
`,
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain(
      "entrypoint 'bad' references missing workflow"
    );
  });

  it("rejects invalid gate shapes by kind", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: research
        kind: agent
        profile: researcher
        gates:
          - kind: changed_files
`,
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("changed_files");
  });

  it("rejects missing rule, skill, and MCP server references", () => {
    const profiles = VALID_PROFILES_YAML.replace(
      "rules: [test-first]",
      "rules: [missing]"
    )
      .replace("skills: [repo-research]", "skills: [missing]")
      .replace("mcp_servers: [docs]", "mcp_servers: [missing]");

    const error = captureConfigError(() => parseParts({ profiles }));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("missing rule 'missing'");
  });

  it("rejects duplicate workflow node ids", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace("id: red", "id: research"),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("duplicate node id 'research'");
  });

  it("rejects invalid needs references", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace(
          "needs: [research]",
          "needs: [missing-node]"
        ),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("missing dependency 'missing-node'");
  });

  it("rejects unsupported node kinds", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace("kind: agent", "kind: phase"),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Invalid discriminator value");
  });

  it("rejects invalid workflow node field combinations", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace(
          "profile: researcher",
          "profile: researcher\n        command: [echo, bad]"
        ),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Unrecognized key");
  });

  it("rejects unsupported hook events", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace(
          "event: workflow.complete",
          "event: workflow.done"
        ),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Invalid option");
  });

  it("rejects tool grants outside runner capabilities", () => {
    const error = captureConfigError(() =>
      parseParts({
        runners: VALID_RUNNERS_YAML.replace(
          "tools: [read, list, grep, glob, bash, edit, write]",
          "tools: [read]"
        ),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("does not support tool 'list'");
  });

  it("rejects filesystem, network, and output grants outside runner capabilities", () => {
    const runners = VALID_RUNNERS_YAML.replace(
      "filesystem: [read-only, workspace-write]",
      "filesystem: [workspace-write]"
    )
      .replace("network: [inherit]", "network: [disabled]")
      .replace(
        "output_formats: [text, json, jsonl, json_schema]",
        "output_formats: [text]"
      );

    const error = captureConfigError(() => parseParts({ runners }));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain(
      "does not support filesystem mode 'read-only'"
    );
  });

  it("rejects missing output repair runner references", () => {
    const profiles = VALID_PROFILES_YAML.replace(
      "max_attempts: 1",
      "max_attempts: 1\n        runner: missing-repair-runner"
    );

    const error = captureConfigError(() => parseParts({ profiles }));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("missing repair runner");
  });

  it("rejects missing instruction and schema files", () => {
    const project = makeProject(VALID_PARTS, false);

    const error = captureConfigError(() => loadPipelineConfig(project));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("referenced file");
  });

  it("rejects missing rule and skill files", () => {
    const project = makeProject();
    rmSync(join(project, "rules/test-first.md"));
    rmSync(join(project, ".agents/skills/repo-research/SKILL.md"));

    const error = captureConfigError(() => loadPipelineConfig(project));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("rules.test-first.path");
    expect(error.message).toContain("skills.repo-research.path");
  });
});
