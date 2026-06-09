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
import Ajv from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  loadPipelineConfig,
  PipelineConfigError,
  type PipelineConfigParts,
  parsePipelineConfigParts,
} from "../src/config";

const MIN_ITEMS_MESSAGE_RE = /at least|>=1|too small/i;
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
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
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

function profilesWithGatewayBackends(backendsYaml: string): string {
  return VALID_PROFILES_YAML.replace(
    "  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION",
    `  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION\n${backendsYaml}`
  );
}

function parseProjectParts(
  projectRoot: string,
  parts: Partial<PipelineConfigParts> = {}
) {
  return parsePipelineConfigParts({ ...VALID_PARTS, ...parts }, projectRoot);
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

function expectedPackageScheduledEntrypoints(): Record<string, unknown> {
  return {
    execute: { schedule: "execute-schedule" },
    quick: { schedule: "quick-schedule" },
    inspect: { workflow: "inspect" },
  };
}

function expectedPackageSchedules(): Record<string, Record<string, string>> {
  return {
    "execute-schedule": {
      baseline: "execute",
      planner_profile: "pipeline-schedule-planner",
      node_catalog: "execute",
    },
    "quick-schedule": {
      baseline: "quick",
      planner_profile: "pipeline-schedule-planner",
      node_catalog: "quick",
    },
  };
}

function expectedSchedulerCommands(): Record<string, Record<string, string>> {
  return {
    execute: {
      catalog: "execute",
      schedule: "execute-schedule",
    },
    quick: {
      catalog: "quick",
      schedule: "quick-schedule",
    },
  };
}

function expectedExecuteRequiredCategories(): string[] {
  return [
    "intake",
    "research",
    "red",
    "green",
    "mechanical",
    "acceptance",
    "verification",
    "learn",
  ];
}

describe("loadPipelineConfig", () => {
  it("loads package-owned defaults when the repo has no pipeline files", () => {
    const project = mkdtempSync(join(tmpdir(), "pipeline-config-defaults-"));
    tempDirs.push(project);

    const config = loadPipelineConfig(project);

    expect(existsSync(join(project, ".pipeline"))).toBe(false);
    expect(config.default_workflow).toBe("inspect");
    expect(config.entrypoints).toMatchObject(
      expectedPackageScheduledEntrypoints()
    );
    expect(config.entrypoints.pipe).toBeUndefined();
    expect(config.entrypoints.epic).toBeUndefined();
    expect(config.runners.codex.type).toBe("codex");
    expect(config.runners.opencode.type).toBe("opencode");
    expect(
      Object.entries(config.profiles)
        .filter(([id]) => id === "orchestrator" || id.startsWith("pipeline-"))
        .map(([id, profile]) => [id, profile.runner])
    ).toEqual([
      ["orchestrator", "opencode"],
      ["pipeline-researcher", "opencode"],
      ["pipeline-inspector", "opencode"],
      ["pipeline-schedule-planner", "opencode"],
      ["pipeline-test-writer", "opencode"],
      ["pipeline-code-writer", "opencode"],
      ["pipeline-acceptance-reviewer", "opencode"],
      ["pipeline-thermo-nuclear-reviewer", "opencode"],
      ["pipeline-verifier", "opencode"],
      ["pipeline-learner", "opencode"],
    ]);
    expect(config.schedules["execute-schedule"]).toMatchObject(
      expectedPackageSchedules()["execute-schedule"]
    );
    expect(config.schedules["quick-schedule"]).toMatchObject(
      expectedPackageSchedules()["quick-schedule"]
    );
    expect(config.scheduler.commands).toMatchObject(
      expectedSchedulerCommands()
    );
    expect(
      (config.scheduler.node_catalogs.execute as any).required_categories
    ).toEqual(expectedExecuteRequiredCategories());
    expect(
      config.scheduler.node_catalogs.execute.nodes["red-tests"].models
    ).toEqual(expect.any(Array));
    expect(config.workflows.inspect.nodes.map((node) => node.id)).toEqual([
      "inspect",
    ]);
    expect(config.profiles["pipeline-code-writer"].scheduling_roles).toEqual([
      "implementation",
    ]);
    expect(config.profiles["pipeline-test-writer"].scheduling_roles).toEqual([
      "implementation",
    ]);
    expect(config.profiles["pipeline-test-writer"].output).toMatchObject({
      format: "json_schema",
      schema_path: ".pipeline/schemas/implementation.schema.json",
      repair: {
        enabled: true,
        max_attempts: 1,
      },
    });
    expect(
      config.profiles["pipeline-test-writer"].instructions.inline
    ).toContain("Only edit files matching test paths");
    expect(config.profiles["pipeline-researcher"].timeout_ms).toBe(900_000);
    expect(
      config.profiles["pipeline-researcher"].instructions.inline
    ).toContain("do not perform open-ended repository exploration");
    expect(config.profiles["pipeline-verifier"].scheduling_roles).toEqual([
      "coverage",
    ]);
    const acceptanceInstructions =
      config.profiles["pipeline-acceptance-reviewer"].instructions.inline ?? "";
    expect(acceptanceInstructions).toContain("Return only valid JSON");
    expect(acceptanceInstructions).toContain('"acceptance"');
    const verifierInstructions =
      config.profiles["pipeline-verifier"].instructions.inline ?? "";
    expect(verifierInstructions).toContain("Return only valid JSON");
    expect(verifierInstructions).toContain('"verdict"');
    expect(config.hooks.on["workflow.start"]).toEqual([
      expect.objectContaining({ function: "generated-defaults-audit" }),
    ]);
    const generatedDefaultsAudit =
      config.hooks.functions["generated-defaults-audit"];
    expect(generatedDefaultsAudit.kind).toBe("command");
    if (generatedDefaultsAudit.kind !== "command") {
      throw new Error("expected generated defaults audit command hook");
    }
    expect(generatedDefaultsAudit.command.join(" ")).toContain(
      "PIPELINE_HOOK_RESULT"
    );
  });

  it("parses a complete valid custom config from explicit config parts", () => {
    const project = makeProject();

    const config = parseProjectParts(project);

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
    expect(config.runner_job.git.committer).toEqual({
      email: "git@oisin.ee",
      name: "oisin-bot",
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

  it("accepts a configured runner job git committer", () => {
    const config = parseParts({
      pipeline: `${VALID_PIPELINE_YAML}\nrunner_job:\n  git:\n    committer:\n      name: pipeline-bot\n      email: pipeline-bot@example.com\n`,
    });

    expect(config.runner_job.git.committer).toEqual({
      email: "pipeline-bot@example.com",
      name: "pipeline-bot",
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

    const error = captureConfigError(() =>
      parseProjectParts(project, { profiles })
    );

    expect(error.message).toContain("mcp_servers.docs");
  });

  it("loads package-owned defaults when repo-local config files are incomplete", () => {
    const project = mkdtempSync(join(tmpdir(), "pipeline-config-missing-"));
    tempDirs.push(project);
    writeProjectFile(project, ".pipeline/pipeline.yaml", VALID_PIPELINE_YAML);

    const config = loadPipelineConfig(project);

    expect(config.default_workflow).toBe("inspect");
    expect(config.profiles["pipeline-researcher"]).toBeDefined();
  });

  it("loads package-owned defaults when legacy repo-local config.toml exists", () => {
    const project = mkdtempSync(join(tmpdir(), "pipeline-config-legacy-"));
    tempDirs.push(project);
    writeProjectFile(project, ".pipeline/config.toml", "[phases]\n");

    const config = loadPipelineConfig(project);

    expect(config.default_workflow).toBe("inspect");
    expect(config.profiles["pipeline-researcher"]).toBeDefined();
  });

  it("rejects malformed explicit custom YAML with a parse error", () => {
    const error = captureConfigError(() =>
      parseParts({ pipeline: "version: 1\nworkflows: [" })
    );

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
  execute-schedule:
    baseline: execute
    planner_profile: researcher
  quick-schedule:
    baseline: quick
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

    expect(config.schedules["quick-schedule"]).toMatchObject({
      baseline: "quick",
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
    baseline: execute
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

  it("accepts a strict repo-aware MCP gateway backend contract", () => {
    const config = parseParts({
      profiles: profilesWithGatewayBackends(`  backends:
    context7:
      locality: shared-remote
      required: true
      tool_prefixes: [context7]
    backlog:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      tool_prefixes: [backlog]
    fallow:
      locality: repo-local
      workspace_path_source: cwd
      required: false
      tool_prefixes: [fallow]`),
    });

    expect(config.mcp_gateway?.backends).toMatchObject({
      context7: {
        locality: "shared-remote",
        required: true,
        tool_prefixes: ["context7"],
      },
      backlog: {
        locality: "repo-local",
        workspace_path_source: "PIPELINE_TARGET_PATH",
        tool_prefixes: ["backlog"],
      },
      fallow: {
        locality: "repo-local",
        workspace_path_source: "cwd",
        required: false,
        tool_prefixes: ["fallow"],
      },
    });
    expect(config.mcp_servers).toEqual({});
    expect(config.profiles.orchestrator.mcp_servers).toEqual([
      "pipeline-gateway",
    ]);
  });

  it("rejects unknown gateway backend keys", () => {
    const error = captureConfigError(() =>
      parseParts({
        profiles: profilesWithGatewayBackends(`  backends:
    serena:
      locality: repo-local
      workspace_path_source: cwd
      tool_prefixes: [serena]
      clone_url: https://github.com/example/repo.git`),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Unrecognized key");
    expect(error.message).toContain("clone_url");
  });

  it("rejects invalid repo-local gateway backend locality", () => {
    const error = captureConfigError(() =>
      parseParts({
        profiles: profilesWithGatewayBackends(`  backends:
    serena:
      locality: workspace-clone
      workspace_path_source: cwd
      tool_prefixes: [serena]`),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Invalid option");
    expect(error.message).toContain("repo-local");
    expect(error.message).toContain("shared-remote");
  });

  it("rejects repo-local gateway backends without an active workspace source", () => {
    const error = captureConfigError(() =>
      parseParts({
        profiles: profilesWithGatewayBackends(`  backends:
    serena:
      locality: repo-local
      tool_prefixes: [serena]`),
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain(
      "repo-local gateway backend must declare workspace_path_source"
    );
  });

  it("rejects direct upstream MCP grants when mcp_gateway is configured", () => {
    const profiles = VALID_PROFILES_YAML.replace(
      "mcp_servers: [pipeline-gateway]",
      "mcp_servers: [pipeline-gateway, serena]"
    );

    const error = captureConfigError(() => parseParts({ profiles }));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain(
      "profiles.orchestrator.mcp_servers must only reference pipeline-gateway"
    );
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

    const error = captureConfigError(() => parseProjectParts(project));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("referenced file");
  });

  it("rejects missing rule and skill files", () => {
    const project = makeProject();
    rmSync(join(project, "rules/test-first.md"));
    rmSync(join(project, ".agents/skills/repo-research/SKILL.md"));

    const error = captureConfigError(() => parseProjectParts(project));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("rules.test-first.path");
    expect(error.message).toContain("skills.repo-research.path");
  });
});

describe("execute/quick scheduler integration", () => {
  function readRepoPipelineYaml(): any {
    return parse(
      readFileSync(join(process.cwd(), ".pipeline/pipeline.yaml"), "utf8")
    );
  }

  it("declares scheduled execute/quick entrypoints and removes legacy entrypoints", () => {
    const config = readRepoPipelineYaml();
    const entrypoints = config.entrypoints ?? {};
    const schedules = config.schedules ?? {};

    expect(Object.keys(entrypoints).sort()).toEqual([
      "execute",
      "inspect",
      "quick",
    ]);
    expect(entrypoints.execute).toMatchObject({ schedule: "execute-schedule" });
    expect(entrypoints.quick).toMatchObject({ schedule: "quick-schedule" });
    expect(entrypoints.inspect).toMatchObject({ workflow: "inspect" });
    expect(entrypoints.pipe).toBeUndefined();
    expect(entrypoints.epic).toBeUndefined();
    expect(schedules["execute-schedule"]).toMatchObject(
      expectedPackageSchedules()["execute-schedule"]
    );
    expect(schedules["quick-schedule"]).toMatchObject(
      expectedPackageSchedules()["quick-schedule"]
    );
    expect(config.workflows?.default).toBeUndefined();
    expect(config.workflows?.infra).toBeUndefined();
    expect(config.workflows?.["epic-drain"]).toBeUndefined();
  });

  it("declares configurable scheduler node catalogs with model fallback arrays", () => {
    const config = readRepoPipelineYaml();
    const commands = (config.scheduler?.commands ?? {}) as Record<
      string,
      { schedule: string }
    >;
    const executeCatalog = config.scheduler?.node_catalogs?.execute as any;

    expect(
      Object.entries(commands)
        .map(([id, value]) => [id, value.schedule])
        .sort(([left], [right]) => left.localeCompare(right))
    ).toEqual([
      ["execute", "execute-schedule"],
      ["quick", "quick-schedule"],
    ]);
    expect(commands.execute).toMatchObject(expectedSchedulerCommands().execute);
    expect(commands.quick).toMatchObject(expectedSchedulerCommands().quick);
    expect(executeCatalog.required_categories).toEqual(
      expectedExecuteRequiredCategories()
    );
    for (const nodeId of [
      "red-tests",
      "green-backend",
      "green-frontend",
    ] as const) {
      expect(executeCatalog.nodes[nodeId].models).toEqual(expect.any(Array));
    }
    expect(
      config.scheduler?.node_catalogs?.quick.nodes["green-implementation"]
        .models
    ).toEqual(expect.any(Array));
    expect(
      config.scheduler?.node_catalogs?.execute.nodes["red-tests"].models.length
    ).toBeGreaterThan(1);
    expect(
      config.scheduler?.node_catalogs?.execute.nodes["green-backend"].models
        .length
    ).toBeGreaterThan(1);
  });

  it("prefers non-Kimi first-choice models for progress-critical scheduler nodes", () => {
    const config = readRepoPipelineYaml();
    const quickCatalog = config.scheduler?.node_catalogs?.quick as any;
    const executeCatalog = config.scheduler?.node_catalogs?.execute as any;

    expect(quickCatalog.nodes["green-implementation"].models[0]).not.toBe(
      "kimi-for-coding/k2p6"
    );
    expect(executeCatalog.nodes.research.models[0]).not.toBe(
      "kimi-for-coding/k2p6"
    );
    expect(executeCatalog.nodes["green-frontend"].models[0]).not.toBe(
      "kimi-for-coding/k2p6"
    );
  });

  it("keeps legacy epic-router package assets out of the active profile graph", () => {
    const profilesYaml = readFileSync(
      join(process.cwd(), ".pipeline/profiles.yaml"),
      "utf8"
    );
    const profilesConfig = parse(profilesYaml) as {
      profiles?: Record<string, any>;
    };

    expect(profilesConfig.profiles?.["pipeline-epic-router"]).toBeUndefined();
    expect(
      profilesConfig.profiles?.["pipeline-thermo-nuclear-reviewer"]
    ).toBeDefined();
  });

  it("ignores pipeline run worktrees", () => {
    const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8")
      .split(LINE_RE)
      .map((line) => line.trim());

    expect(gitignore).toContain(".pipeline/runs/");
  });
});

describe("opencode profile integration", () => {
  it("declares the installed critique skill and reviewer profile contract", () => {
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
    expect(parsed.profiles["pipeline-opencode-test-writer"]).toMatchObject({
      runner: "opencode",
      output: {
        format: "json_schema",
        repair: { enabled: true, max_attempts: 1 },
        schema_path: ".pipeline/schemas/implementation.schema.json",
      },
      scheduling_roles: ["implementation"],
      instructions: { path: ".pipeline/prompts/test-writer.md" },
    });
    expect(parsed.profiles["pipeline-opencode-verifier"]).toMatchObject({
      runner: "opencode",
      scheduling_roles: ["coverage"],
      instructions: { path: ".pipeline/prompts/verifier.md" },
    });
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
