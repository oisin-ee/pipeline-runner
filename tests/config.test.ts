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
  DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST,
  loadPipelineConfig,
  PipelineConfigError,
  type PipelineConfigParts,
  parsePipelineConfigParts,
  validatePipelineConfig,
  workflowSchema,
} from "../src/config";
import { PACKAGE_DEFAULT_PIPELINE_YAML } from "../src/config/defaults";
import { lintPipelineConfig } from "../src/config/lint";
import { loadPackagePipelineConfig } from "../src/config/load";
import { configSchema } from "../src/config/schemas";
import { validatePipelineConfig as validatePipelineConfigModule } from "../src/config/validate";

const MIN_ITEMS_MESSAGE_RE = /at least|>=1|too small/i;
const LINE_RE = /\r?\n/;

const VALID_RUNNERS_YAML = `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
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
    runner: opencode
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
    runner: opencode
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
    runner: opencode
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

const VALID_PIPELINE_WITHOUT_ORCHESTRATOR_YAML = VALID_PIPELINE_YAML.replace(
  "orchestrator:\n  profile: orchestrator\n",
  ""
);

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

const DEFAULT_PACKAGE_SKILLS = [
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

function writeDefaultPackageSkills(root: string): void {
  for (const skill of DEFAULT_PACKAGE_SKILLS) {
    writeProjectFile(
      root,
      `.agents/skills/${skill}/SKILL.md`,
      `---\nname: ${skill}\ndescription: Mock ${skill} skill.\n---\n`
    );
  }
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
      planner_profile: "moka-schedule-planner",
      node_catalog: "execute",
    },
    "quick-schedule": {
      baseline: "quick",
      planner_profile: "moka-schedule-planner",
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

const EXPECTED_CONFIG_MODULES = [
  { exportValue: PACKAGE_DEFAULT_PIPELINE_YAML, name: "defaults" },
  { exportValue: configSchema, name: "schemas" },
  { exportValue: loadPackagePipelineConfig, name: "load" },
  { exportValue: validatePipelineConfigModule, name: "validate" },
  { exportValue: lintPipelineConfig, name: "lint" },
] as const;

describe("config module boundaries", () => {
  it("keeps the split config implementation in focused source modules", () => {
    for (const { name } of EXPECTED_CONFIG_MODULES) {
      expect(
        existsSync(join(process.cwd(), "src", "config", `${name}.ts`))
      ).toBe(true);
    }
  });

  it("makes each focused config module importable for cohesive reuse", () => {
    for (const { exportValue } of EXPECTED_CONFIG_MODULES) {
      expect(exportValue).toBeDefined();
    }
  });

  it("preserves the existing public config barrel exports", () => {
    expect(loadPipelineConfig).toBeTypeOf("function");
    expect(parsePipelineConfigParts).toBeTypeOf("function");
    expect(validatePipelineConfig).toBeTypeOf("function");
    expect(workflowSchema).toBeTypeOf("object");
    expect(PipelineConfigError).toBeTypeOf("function");
    expect(DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST).toBeTypeOf("object");
  });
});

describe("loadPipelineConfig", () => {
  it("loads package-owned defaults when the repo has no pipeline files", () => {
    const project = mkdtempSync(join(tmpdir(), "pipeline-config-defaults-"));
    tempDirs.push(project);
    writeDefaultPackageSkills(project);

    const config = loadPipelineConfig(project);

    expect(existsSync(join(project, ".pipeline"))).toBe(false);
    expect(config.default_workflow).toBe("inspect");
    expect(config.entrypoints).toMatchObject(
      expectedPackageScheduledEntrypoints()
    );
    expect(config.entrypoints.pipe).toBeUndefined();
    expect(config.entrypoints.epic).toBeUndefined();
    expect(config.runners.opencode.type).toBe("opencode");
    expect(
      Object.entries(config.profiles)
        .filter(([id]) => id.startsWith("moka-"))
        .map(([id, profile]) => [id, profile.runner])
    ).toEqual([
      ["moka-orchestrator", "opencode"],
      ["moka-researcher", "opencode"],
      ["moka-ticket-scoper", "opencode"],
      ["moka-inspector", "opencode"],
      ["moka-schedule-planner", "opencode"],
      ["moka-test-writer", "opencode"],
      ["moka-code-writer", "opencode"],
      ["moka-acceptance-reviewer", "opencode"],
      ["moka-thermo-nuclear-reviewer", "opencode"],
      ["moka-verifier", "opencode"],
      ["moka-learner", "opencode"],
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
    expect(config.profiles["moka-code-writer"].scheduling_roles).toEqual([
      "implementation",
    ]);
    expect(config.profiles["moka-test-writer"].scheduling_roles).toEqual([
      "implementation",
    ]);
    expect(config.profiles["moka-test-writer"].output).toMatchObject({
      format: "json_schema",
      schema_path: ".pipeline/schemas/implementation.schema.json",
      repair: {
        enabled: true,
        max_attempts: 1,
      },
    });
    expect(config.profiles["moka-test-writer"].instructions.inline).toContain(
      "Only edit files matching test paths"
    );
    expect(config.profiles["moka-researcher"].timeout_ms).toBe(900_000);
    expect(config.profiles["moka-schedule-planner"].timeout_ms).toBe(300_000);
    expect(config.profiles["moka-researcher"].instructions.inline).toContain(
      "do not perform open-ended repository exploration"
    );
    expect(config.profiles["moka-verifier"].scheduling_roles).toEqual([
      "coverage",
    ]);
    const acceptanceInstructions =
      config.profiles["moka-acceptance-reviewer"].instructions.inline ?? "";
    expect(acceptanceInstructions).toContain("Return only valid JSON");
    expect(acceptanceInstructions).toContain('"acceptance"');
    const verifierInstructions =
      config.profiles["moka-verifier"].instructions.inline ?? "";
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
    // Dependency/toolchain bootstrap is repo-owned and required: the default
    // first setup step runs the repo's declared bootstrap (.moka/bootstrap.sh or
    // a "moka:setup" script) and fails loudly otherwise — moka never guesses it.
    // moka's own runtime provisioning (init + install-commands) stays.
    const setup = config.runner_command.environment.setup;
    expect(setup).toHaveLength(3);
    expect(setup[0].command).toBe("sh");
    expect(setup[0].args[0]).toBe("-c");
    expect(setup[0].args[1]).toContain(".moka/bootstrap.sh");
    expect(setup[0].args[1]).toContain("moka:setup");
    expect(setup[0].required).toBe(true);
    expect(setup[1]).toEqual({
      args: ["init"],
      command: "moka",
      required: true,
    });
    expect(setup[2]).toEqual({
      args: ["install-commands"],
      command: "moka",
      required: true,
    });
  });

  it("parses a complete valid custom config from explicit config parts", () => {
    const project = makeProject();

    const config = parseProjectParts(project);

    expect(config.version).toBe(1);
    expect(config.default_workflow).toBe("default");
    expect(config.runners.opencode.type).toBe("opencode");
    expect(config.orchestrator?.profile).toBe("orchestrator");
    expect(config.profiles.orchestrator.model).toBe("gpt-5-orchestrator");
    expect(config.profiles.researcher.runner).toBe("opencode");
    expect(config.profiles.researcher.output?.repair).toEqual({
      enabled: true,
      max_attempts: 1,
    });
    expect(config.runner_command.git.committer).toEqual({
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

  it("declares a ticket scoper profile with binding scope instructions", () => {
    const project = mkdtempSync(join(tmpdir(), "pipeline-config-defaults-"));
    tempDirs.push(project);
    writeDefaultPackageSkills(project);

    const profile = loadPipelineConfig(project).profiles["moka-ticket-scoper"];

    expect(profile.skills).toContain("scope");
    expect(profile.output).toMatchObject({
      format: "json_schema",
      schema_path: ".pipeline/schemas/ticket-plan.schema.json",
    });
    expect(profile.instructions.inline).toContain("scope skill contract");
    expect(profile.instructions.inline).toContain(
      "Do not emit partial tickets"
    );
  });

  it("parses a minimal custom pipeline config without an orchestrator", () => {
    const project = makeProject({
      ...VALID_PARTS,
      pipeline: VALID_PIPELINE_WITHOUT_ORCHESTRATOR_YAML,
    });

    const config = parseProjectParts(project, {
      pipeline: VALID_PIPELINE_WITHOUT_ORCHESTRATOR_YAML,
    });

    expect(config.default_workflow).toBe("default");
    expect(config.workflows.default.nodes.map((node) => node.id)).toEqual([
      "research",
      "red",
    ]);
  });

  it("accepts a configured runner command git committer", () => {
    const config = parseParts({
      pipeline: `${VALID_PIPELINE_YAML}\nrunner_command:\n  git:\n    committer:\n      name: pipeline-bot\n      email: pipeline-bot@example.com\n`,
    });

    expect(config.runner_command.git.committer).toEqual({
      email: "pipeline-bot@example.com",
      name: "pipeline-bot",
    });
  });

  it("accepts canonical models and optional host-specific model overrides", () => {
    const config = parseParts({
      profiles: VALID_PROFILES_YAML.replace(
        "    model: gpt-5-agent\n    runner: opencode",
        "    model: gpt-5-agent\n    host_models:\n      opencode: openai/gpt-5.3\n    runner: opencode"
      ),
      runners: VALID_RUNNERS_YAML.replace(
        "    model: gpt-5-runner",
        "    model: gpt-5-runner\n    host_models:\n      opencode: openai/gpt-5.3"
      ),
    });

    expect(config.runners.opencode.host_models?.opencode).toBe(
      "openai/gpt-5.3"
    );
    expect(config.profiles.researcher.host_models?.opencode).toBe(
      "openai/gpt-5.3"
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
    writeDefaultPackageSkills(project);

    const config = loadPipelineConfig(project);

    expect(config.default_workflow).toBe("inspect");
    expect(config.profiles["moka-researcher"]).toBeDefined();
  });

  it("loads package-owned defaults when legacy repo-local config.toml exists", () => {
    const project = mkdtempSync(join(tmpdir(), "pipeline-config-legacy-"));
    tempDirs.push(project);
    writeProjectFile(project, ".pipeline/config.toml", "[phases]\n");
    writeDefaultPackageSkills(project);

    const config = loadPipelineConfig(project);

    expect(config.default_workflow).toBe("inspect");
    expect(config.profiles["moka-researcher"]).toBeDefined();
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
          "runner: opencode",
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

  it("warns when a configured entrypoint shadows the builtin ticket command", () => {
    const project = makeProject();
    const config = parseProjectParts(project, {
      pipeline: `
version: 1
default_workflow: default
entrypoints:
  ticket:
    workflow: default
    description: Ticket entrypoint
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

    expect(lintPipelineConfig(config, project)).toContainEqual({
      ruleId: "entrypoint-shadowed",
      message:
        "entrypoint 'ticket' is shadowed by the builtin subcommand; invoke via 'moka run --entrypoint ticket ...'",
    });
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

  it("rejects workflow nodes", () => {
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
        workflow: subflow
  subflow:
    nodes:
      - id: research
        kind: agent
        profile: researcher
`,
      })
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Invalid discriminator value");
  });

  it("accepts deeply nested parallel nodes without colliding with group child references", () => {
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
          - id: child-command
            kind: command
            command: [echo, child]
          - id: nested
            kind: parallel
            nodes:
              - id: nested-command
                kind: command
                command: [echo, nested]
              - id: nested-agent
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
      "child-command",
      "nested",
    ]);
    expect(fanout.nodes[1]).toMatchObject({
      kind: "parallel",
      nodes: [
        expect.objectContaining({ id: "nested-command", kind: "command" }),
        expect.objectContaining({ id: "nested-agent", kind: "agent" }),
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

  it("rejects workflow node syntax without a workflow field", () => {
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
    expect(error.message).toContain("Invalid discriminator value");
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

  it("rejects a missing rule file but tolerates an install-managed skill body", () => {
    const project = makeProject();
    rmSync(join(project, "rules/test-first.md"));
    rmSync(join(project, ".agents/skills/repo-research/SKILL.md"));

    const error = captureConfigError(() => parseProjectParts(project));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("rules.test-first.path");
    // Skill bodies are install-managed, so a missing one is not a config defect.
    expect(error.message).not.toContain("skills.repo-research.path");
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
    )
      .split(LINE_RE)
      .filter((line) => line.trim() !== "skills: [execute, quick, inspect]")
      .join("\n");
    const profilesConfig = parse(profilesYaml) as {
      profiles?: Record<string, any>;
    };

    expect(profilesConfig.profiles?.["moka-epic-router"]).toBeUndefined();
    expect(
      profilesConfig.profiles?.["moka-thermo-nuclear-reviewer"]
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
    )
      .split(LINE_RE)
      .filter((line) => line.trim() !== "skills: [execute, quick, inspect]")
      .join("\n");
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
    expect(parsed.profiles["moka-opencode-researcher"]).toMatchObject({
      runner: "opencode",
      instructions: { path: ".pipeline/prompts/researcher.md" },
    });
    expect(parsed.profiles["moka-opencode-code-writer"]).toMatchObject({
      runner: "opencode",
      scheduling_roles: ["implementation"],
      instructions: { path: ".pipeline/prompts/code-writer.md" },
    });
    expect(parsed.profiles["moka-opencode-test-writer"]).toMatchObject({
      runner: "opencode",
      output: {
        format: "json_schema",
        repair: { enabled: true, max_attempts: 1 },
        schema_path: ".pipeline/schemas/implementation.schema.json",
      },
      scheduling_roles: ["implementation"],
      instructions: { path: ".pipeline/prompts/test-writer.md" },
    });
    expect(parsed.profiles["moka-opencode-verifier"]).toMatchObject({
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

    const profile = profilesConfig.profiles?.["moka-thermo-nuclear-reviewer"];
    expect(
      profile,
      "profiles.moka-thermo-nuclear-reviewer should exist in .pipeline/profiles.yaml"
    ).toBeDefined();
    expect(profile).toMatchObject({
      runner: "opencode",
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

  it("wires the install-managed critique skill into the reviewer profile", () => {
    // Skill bodies are install-managed (installed from the skills source into
    // host dirs by `moka init`), not bundled in the package, so the contract is
    // the config wiring: the reviewer grants the critique skill and the skill is
    // declared in the registry.
    const config = loadPackagePipelineConfig(process.cwd());

    expect(config.skills.critique).toBeDefined();
    expect(config.profiles["moka-thermo-nuclear-reviewer"]?.skills).toContain(
      "critique"
    );
  });
});

const MAX_CONTEXT_PCT_RE = /max_context_pct/i;
const UNKNOWN_CATEGORY_RE = /unknown node category 'green'/i;

describe("token_budget", () => {
  it("applies documented defaults when the block is omitted", () => {
    const config = parseParts({});
    expect(config.token_budget).toEqual({
      default_context_window: 200_000,
      fan_out_width: { by_category: {}, default: 4 },
      max_context_pct: 50,
      model_context_windows: {},
    });
  });

  it("parses an explicit token_budget block", () => {
    const config = parseParts({
      pipeline: `${VALID_PIPELINE_YAML}
token_budget:
  default_context_window: 400000
  max_context_pct: 40
  model_context_windows:
    openai/gpt-5.5: 400000
  fan_out_width:
    default: 3
`,
    });
    expect(config.token_budget.default_context_window).toBe(400_000);
    expect(config.token_budget.max_context_pct).toBe(40);
    expect(config.token_budget.model_context_windows).toEqual({
      "openai/gpt-5.5": 400_000,
    });
    expect(config.token_budget.fan_out_width.default).toBe(3);
  });

  it("rejects max_context_pct above 100", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: `${VALID_PIPELINE_YAML}\ntoken_budget:\n  max_context_pct: 150\n`,
      })
    );
    expect(error.message).toMatch(MAX_CONTEXT_PCT_RE);
  });

  it("rejects a non-positive context window", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: `${VALID_PIPELINE_YAML}\ntoken_budget:\n  default_context_window: -1\n`,
      })
    );
    expect(error).toBeInstanceOf(PipelineConfigError);
  });

  it("rejects a fan-out cap for an unknown node category", () => {
    const error = captureConfigError(() =>
      parseParts({
        pipeline: `${VALID_PIPELINE_YAML}\ntoken_budget:\n  fan_out_width:\n    by_category:\n      green: 2\n`,
      })
    );
    expect(error.message).toMatch(UNKNOWN_CATEGORY_RE);
  });
});
