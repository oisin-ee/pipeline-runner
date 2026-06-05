import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  loadPipelineConfig,
  PipelineConfigError,
  type PipelineConfigParts,
  parsePipelineConfigParts,
} from "../src/config.js";

const MIN_ITEMS_MESSAGE_RE = /at least|>=1|too small/i;
const STUB_OR_DEFAULT_RE = /stub|default/i;
const LINE_RE = /\r?\n/;

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
mcp_gateway:
  provider: toolhive
  mode: local
  url_env: PIPELINE_MCP_GATEWAY_URL
  token_env: MEMORY_MCP_BASIC_AUTH
profiles:
  orchestrator:
    runner: codex
    model: gpt-5-orchestrator
    instructions:
      path: .pipeline/prompts/orchestrator.md
    rules: [test-first]
    skills: [repo-research]
    mcp_servers: [pipeline-gateway]
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
    mcp_servers: [pipeline-gateway]
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
  functions:
    announce-complete:
      kind: command
      command: ["echo", "complete"]
      trusted: true
      timeout_ms: 30000
  on:
    workflow.complete:
      - id: announce-complete
        function: announce-complete
        failure: ignore
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

  it("rejects direct MCP server registry entries in profiles config", () => {
    const profiles = VALID_PROFILES_YAML.replace(
      "profiles:",
      `mcp_servers:
  docs:
    command: npx
    args: ["-y", "@example/docs-mcp"]
profiles:`
    );

    const error = captureConfigError(() => parseParts({ profiles }));

    expect(error.message).toContain("mcp_servers.docs");
  });

  it("rejects mcp-json MCP server refs", () => {
    const profiles = VALID_PROFILES_YAML.replace(
      "profiles:",
      `mcp_servers:
  docs:
    ref:
      path: .mcp.json
      id: serena
profiles:`
    );
    const project = makeProject({ ...VALID_PARTS, profiles });
    writeProjectFile(project, ".mcp.json", JSON.stringify({ mcpServers: {} }));

    const error = captureConfigError(() => loadPipelineConfig(project));

    expect(error.message).toContain("mcp_servers.docs");
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
      "mcp_servers: [pipeline-gateway]\n    tools: [read, list, grep, glob, bash]\n    filesystem:",
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
  functions:
    announce-complete:
      kind: command
      command: ["echo", "done"]
      env:
        passthrough: [PATH]
        set: { PIPELINE_HOOK: "1" }
      output_limit_bytes: 1024
      trusted: true
  on:
    workflow.complete:
      - id: announce-complete
        function: announce-complete
        failure: ignore
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: research
        kind: agent
        profile: researcher
        task_context:
          id: PIPE-41.7
          title: Propagate node-level task context
          description: Carry child ticket context into this node.
          acceptance_criteria:
            - id: "1"
              text: Agent prompts include node-specific context.
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

    expect(config.entrypoints.quick).toMatchObject({ workflow: "default" });
    expect(config.task_context?.type).toBe("markdown");
    expect(config.workflows.default.nodes[0]).toMatchObject({
      task_context: {
        id: "PIPE-41.7",
        title: "Propagate node-level task context",
        description: "Carry child ticket context into this node.",
        acceptance_criteria: [
          { id: "1", text: "Agent prompts include node-specific context." },
        ],
      },
    });
    expect(
      config.workflows.default.nodes[0].gates?.map((gate) => gate.kind)
    ).toEqual(["verdict", "acceptance", "changed_files"]);
  });

  it("rejects obsolete schedule planner_strategy config", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: `
version: 1
default_workflow: default
schedules:
  epic-schedule:
    baseline: epic
    planner_strategy: agent_graph
    planner_profile: researcher
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
    expect(error.message).toContain("planner_strategy");
    expect(error.message).toContain("Unrecognized key");
  });

  it("accepts schedule policies without planner_strategy", () => {
    const config = parseParts({
      pipeline: `
version: 1
default_workflow: default
schedules:
  pipe-schedule:
    baseline: pipe
    planner_profile: researcher
  epic-schedule:
    baseline: epic
    planner_profile: researcher
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: research
        kind: agent
        profile: researcher
`,
    });

    expect(config.schedules["epic-schedule"]).toMatchObject({
      baseline: "epic",
      planner_profile: "researcher",
    });
  });

  it("accepts drain-merge as a workflow builtin but not as a builtin gate", () => {
    const config = parseParts({
      pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: merge
        kind: builtin
        builtin: drain-merge
`,
    });

    expect(config.workflows.default.nodes[0]).toMatchObject({
      builtin: "drain-merge",
      kind: "builtin",
    });

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
      - id: verify
        kind: agent
        profile: researcher
        gates:
          - kind: builtin
            builtin: drain-merge
`,
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain(
      "workflows.default.nodes.0.gates.0.builtin"
    );
    expect(error.message).toContain("Invalid option");
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

  it("rejects scheduled entrypoints pointing at missing schedule policies", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: `
version: 1
default_workflow: default
entrypoints:
  bad:
    schedule: missing-schedule
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
      "entrypoint 'bad' references missing schedule"
    );
  });

  it("rejects schedules pointing at missing planner profiles", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: `
version: 1
default_workflow: default
schedules:
  bad-schedule:
    baseline: pipe
    planner_profile: missing-planner
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
      "schedule 'bad-schedule' references missing planner profile"
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
      .replace("mcp_servers: [pipeline-gateway]", "mcp_servers: [missing]");

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

  it("accepts workflow nodes that reference declared workflows", () => {
    const config = parseParts({
      pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: child
        kind: workflow
        workflow: subflow
  subflow:
    nodes:
      - id: research
        kind: agent
        profile: researcher
`,
    });

    expect(config.workflows.default.nodes[0]).toMatchObject({
      id: "child",
      kind: "workflow",
      workflow: "subflow",
    });
  });

  it("accepts worktree_root on workflow nodes and preserves it", () => {
    const config = parseParts({
      pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: child
        kind: workflow
        workflow: subflow
        worktree_root: .pipeline/worktrees/\${runId}/\${nodeId}
  subflow:
    nodes:
      - id: research
        kind: agent
        profile: researcher
`,
    });

    expect(config.workflows.default.nodes[0]).toMatchObject({
      id: "child",
      kind: "workflow",
      workflow: "subflow",
      worktree_root: `.pipeline/worktrees/$${"{runId}"}/$${"{nodeId}"}`,
    });
  });

  it("accepts deeply nested parallel and workflow nodes without colliding with group child references", () => {
    const config = parseParts({
      pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: before
        kind: agent
        profile: researcher
      - id: grouped
        kind: group
        nodes: [before]
      - id: fanout
        kind: parallel
        needs: [grouped]
        nodes:
          - id: child-workflow
            kind: workflow
            workflow: subflow
          - id: nested
            kind: parallel
            nodes:
              - id: nested-command
                kind: command
                command: [echo, nested]
              - id: nested-workflow
                kind: workflow
                workflow: subflow
  subflow:
    nodes:
      - id: research
        kind: agent
        profile: researcher
`,
    });

    const grouped = config.workflows.default.nodes.find(
      (node) => node.id === "grouped"
    );
    const fanout = config.workflows.default.nodes.find(
      (node) => node.id === "fanout"
    ) as unknown as {
      kind: string;
      nodes: Array<{ id: string; kind: string; nodes?: unknown[] }>;
    };

    expect(grouped).toMatchObject({
      kind: "group",
      nodes: ["before"],
    });
    expect(fanout.kind).toBe("parallel");
    expect(fanout.nodes.map((node) => node.id)).toEqual([
      "child-workflow",
      "nested",
    ]);
    expect(fanout.nodes[1]).toMatchObject({
      kind: "parallel",
      nodes: [
        expect.objectContaining({ id: "nested-command", kind: "command" }),
        expect.objectContaining({ id: "nested-workflow", kind: "workflow" }),
      ],
    });
  });

  it("rejects parallel nodes with no children", () => {
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
      - id: empty-fanout
        kind: parallel
        nodes: []
`,
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(MIN_ITEMS_MESSAGE_RE),
          path: "workflows.default.nodes.0.nodes",
        }),
      ])
    );
  });

  it("rejects workflow nodes without a workflow field", () => {
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
      - id: child
        kind: workflow
`,
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("workflow");
  });

  it("rejects workflow nodes that reference missing workflows", () => {
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
      - id: child
        kind: workflow
        workflow: missing
`,
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain(
      "node 'child' references missing workflow 'missing'"
    );
  });

  it("rejects unsupported hook events", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace(
          "workflow.complete:",
          "workflow.done:"
        ),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("unsupported hook event 'workflow.done'");
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

describe("epic entrypoint integration", () => {
  function readRepoPipelineYaml(): any {
    return parse(
      readFileSync(join(process.cwd(), ".pipeline/pipeline.yaml"), "utf8")
    );
  }

  it("declares scheduled pipe/epic entrypoints and keeps the epic-drain workflow available", () => {
    const config = readRepoPipelineYaml();

    expect(config.entrypoints?.epic).toEqual({
      schedule: "epic-schedule",
      description:
        "Route an epic's tickets into specialist tracks, run them in parallel, then thermo-nuclear review.",
    });
    expect(config.entrypoints?.pipe).toMatchObject({
      schedule: "pipe-schedule",
    });
    expect(config.schedules?.["pipe-schedule"]).toMatchObject({
      baseline: "pipe",
      planner_profile: "pipeline-schedule-planner",
    });
    expect(config.schedules?.["epic-schedule"]).toMatchObject({
      baseline: "epic",
      planner_profile: "pipeline-schedule-planner",
    });

    const workflow = config.workflows?.["epic-drain"];
    expect(workflow, "workflows.epic-drain should exist").toBeDefined();
    expect(workflow.description).toBe(
      "Research, route, parallel-implement tracks in isolated worktrees, integrate, thermo-nuclear review."
    );
    expect(workflow.nodes.map((node: { id: string }) => node.id)).toEqual([
      "research",
      "plan",
      "implement",
      "merge",
      "review",
    ]);
    expect(workflow.nodes[0]).toMatchObject({
      id: "research",
      kind: "agent",
      profile: "pipeline-researcher",
    });
    expect(workflow.nodes[1]).toMatchObject({
      id: "plan",
      kind: "agent",
      profile: "pipeline-epic-router",
      needs: ["research"],
    });

    const implement = workflow.nodes[2];
    expect(implement).toMatchObject({
      id: "implement",
      kind: "parallel",
      needs: ["plan"],
    });
    expect(implement.nodes.map((node: { id: string }) => node.id)).toEqual([
      "test",
      "frontend",
      "backend",
      "k8s",
    ]);
    const expectedChildWorkflows = {
      test: "default",
      frontend: "default",
      backend: "default",
      k8s: "infra",
    };
    for (const [track, childWorkflow] of Object.entries(
      expectedChildWorkflows
    )) {
      expect(
        implement.nodes.find((node: { id: string }) => node.id === track)
      ).toMatchObject({
        id: track,
        kind: "workflow",
        workflow: childWorkflow,
        worktree_root: `.pipeline/runs/\${runId}/${track}`,
      });
    }
    expect(config.workflows?.test).toBeUndefined();
    expect(config.workflows?.frontend).toBeUndefined();
    expect(config.workflows?.backend).toBeUndefined();
    expect(config.workflows?.k8s).toBeUndefined();

    expect(workflow.nodes[3]).toMatchObject({
      id: "merge",
      kind: "builtin",
      builtin: "drain-merge",
      needs: ["implement"],
    });
    expect(workflow.nodes[4]).toMatchObject({
      id: "review",
      kind: "agent",
      profile: "pipeline-thermo-nuclear-reviewer",
      needs: ["merge"],
    });
    expect(workflow.nodes[4].gates).toEqual([
      { id: "review-verdict", kind: "verdict", target: "stdout" },
    ]);
  });

  it("declares infra as a default-shaped stub workflow", () => {
    const config = readRepoPipelineYaml();
    const infra = config.workflows?.infra;
    const defaultWorkflow = config.workflows?.default;

    expect(infra, "workflows.infra should exist").toBeDefined();
    expect(infra.description).toEqual(
      expect.stringMatching(STUB_OR_DEFAULT_RE)
    );
    expect(infra.nodes.map((node: { id: string }) => node.id)).toEqual(
      defaultWorkflow.nodes.map((node: { id: string }) => node.id)
    );
    expect(infra.nodes.map((node: { kind: string }) => node.kind)).toEqual(
      defaultWorkflow.nodes.map((node: { kind: string }) => node.kind)
    );
  });

  it("declares OpenCode as a first-class pipeline runner with schedulable profile variants", () => {
    const profilesYaml = readFileSync(
      join(process.cwd(), ".pipeline/profiles.yaml"),
      "utf8"
    );
    const runnersYaml = readFileSync(
      join(process.cwd(), ".pipeline/runners.yaml"),
      "utf8"
    );
    const parsed = parsePipelineConfigParts({
      pipeline: readFileSync(
        join(process.cwd(), ".pipeline/pipeline.yaml"),
        "utf8"
      ),
      profiles: profilesYaml,
      runners: runnersYaml,
    });

    expect(parsed.runners.opencode.capabilities.skills).toBe(true);
    expect(parsed.runners.opencode.capabilities.rules).toBe(true);
    expect(parsed.runners.opencode.capabilities.mcp_servers).toBe(true);
    expect(parsed.profiles["pipeline-opencode-researcher"]).toMatchObject({
      runner: "opencode",
      instructions: { path: ".pipeline/prompts/researcher.md" },
    });
    expect(parsed.profiles["pipeline-opencode-code-writer"]).toMatchObject({
      runner: "opencode",
      scheduling_roles: ["implementation"],
      instructions: { path: ".pipeline/prompts/code-writer.md" },
    });
    expect(parsed.profiles["pipeline-opencode-verifier"]).toMatchObject({
      runner: "opencode",
      scheduling_roles: ["coverage"],
      instructions: { path: ".pipeline/prompts/verifier.md" },
    });
  });

  it("ignores epic run worktrees", () => {
    const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8")
      .split(LINE_RE)
      .map((line) => line.trim());

    expect(gitignore).toContain(".pipeline/runs/");
  });
});

describe("epic-router asset bundle", () => {
  it("declares the pipeline-epic-router profile with the read-only routing contract", () => {
    const profilesYaml = readFileSync(
      join(process.cwd(), ".pipeline/profiles.yaml"),
      "utf8"
    );
    const profilesConfig = parse(profilesYaml) as {
      profiles?: Record<string, any>;
    };
    const profile = profilesConfig.profiles?.["pipeline-epic-router"];

    expect(
      profile,
      "profiles.pipeline-epic-router should exist in .pipeline/profiles.yaml"
    ).toBeDefined();
    expect(profile).toMatchObject({
      runner: "codex",
      instructions: { path: ".pipeline/prompts/epic-router.md" },
      filesystem: {
        mode: "read-only",
        allow: ["**/*"],
        deny: ["node_modules/**", "dist/**", ".git/**"],
      },
      network: { mode: "inherit" },
      output: {
        format: "json_schema",
        schema_path: ".pipeline/schemas/epic-plan.schema.json",
        repair: {
          enabled: true,
          max_attempts: 1,
        },
      },
    });
    expect(profile.mcp_servers).toEqual(["pipeline-gateway"]);
    expect(profile.tools).toEqual(["read", "list", "grep", "glob", "bash"]);
  });

  it("validates the epic plan schema contract for fixed tracks and ticket ids", () => {
    const schema = JSON.parse(
      readFileSync(
        join(process.cwd(), ".pipeline/schemas/epic-plan.schema.json"),
        "utf8"
      )
    );
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    const goodPlan = {
      test: [
        {
          id: "PIPE-31.9",
          title: "Config: epic-router asset bundle",
          rationale: "The work is primarily test and config contract coverage.",
        },
      ],
      frontend: [],
      backend: [{ id: "PIPE-31.2" }],
      k8s: [],
      rationale: "Routes each sub-ticket into one fixed epic-drain track.",
    };

    expect(validate(goodPlan), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({
        test: [],
        frontend: [],
        backend: [],
        rationale: "Missing the fixed k8s track.",
      }),
      "plans must include every fixed epic-drain track key"
    ).toBe(false);
    expect(
      validate({
        test: [{ title: "Missing required id" }],
        frontend: [],
        backend: [],
        k8s: [],
      }),
      "tickets must include an id"
    ).toBe(false);
  });

  it("documents the epic routing prompt contract", () => {
    const prompt = readFileSync(
      join(process.cwd(), ".pipeline/prompts/epic-router.md"),
      "utf8"
    );

    expect(prompt).toContain("Backlog MCP");
    expect(prompt).toContain("exactly one");
    expect(prompt).toContain("test, frontend, backend, k8s");
    expect(prompt).toContain(".pipeline/schemas/epic-plan.schema.json");
    expect(prompt).toContain("Do not modify any files");
  });
});

describe("final review asset bundle", () => {
  it("declares the installed critique skill and reviewer profile contract", () => {
    const profilesYaml = readFileSync(
      join(process.cwd(), ".pipeline/profiles.yaml"),
      "utf8"
    );
    const profilesConfig = parse(profilesYaml) as {
      skills?: Record<string, { path?: string }>;
      profiles?: Record<string, any>;
    };

    expect(profilesConfig.skills?.critique).toEqual({
      path: ".agents/skills/critique/SKILL.md",
    });

    const profile =
      profilesConfig.profiles?.["pipeline-thermo-nuclear-reviewer"];
    expect(
      profile,
      "profiles.pipeline-thermo-nuclear-reviewer should exist in .pipeline/profiles.yaml"
    ).toBeDefined();
    expect(profile).toMatchObject({
      runner: "codex",
      instructions: {
        path: ".agents/skills/critique/SKILL.md",
      },
      skills: ["critique"],
      mcp_servers: ["pipeline-gateway"],
      filesystem: {
        mode: "read-only",
        allow: ["**/*"],
        deny: ["node_modules/**", "dist/**", ".git/**"],
      },
      network: { mode: "inherit" },
      output: {
        format: "json_schema",
        schema_path: ".pipeline/schemas/review.schema.json",
        repair: {
          enabled: true,
          max_attempts: 1,
        },
      },
    });
    expect(profile.tools).toEqual(["read", "list", "grep", "glob", "bash"]);
  });

  it("validates the final review output schema contract", () => {
    const schema = JSON.parse(
      readFileSync(
        join(process.cwd(), ".pipeline/schemas/review.schema.json"),
        "utf8"
      )
    );
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    expect(
      validate({
        verdict: "PASS",
        summary: "No blocking issues found.",
        findings: [
          {
            severity: "warn",
            message: "Documented non-blocking issue.",
            file: "src/index.ts",
            line: 42,
            rule: "scope-discipline",
          },
        ],
      }),
      JSON.stringify(validate.errors)
    ).toBe(true);
    expect(validate({ verdict: "FAIL", findings: [] })).toBe(true);
    expect(validate({ findings: [] }), "verdict is required").toBe(false);
    expect(
      validate({ verdict: "MAYBE", findings: [] }),
      "verdict must be PASS or FAIL"
    ).toBe(false);
    expect(validate({ verdict: "FAIL" }), "findings is required").toBe(false);
    expect(
      validate({ verdict: "FAIL", findings: [{}] }),
      "findings require severity and message"
    ).toBe(false);
    expect(
      validate({
        verdict: "FAIL",
        findings: [{ severity: "critical", message: "bad", line: 0 }],
      }),
      "finding line numbers are 1-based"
    ).toBe(false);
  });

  it("uses the installed critique skill as the reviewer instructions", () => {
    const skill = readFileSync(
      join(process.cwd(), ".agents/skills/critique/SKILL.md"),
      "utf8"
    );

    expect(skill).toContain("name: critique");
    expect(skill).toContain("Code Review");
  });
});
