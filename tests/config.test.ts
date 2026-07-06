import Ajv from "ajv";
import * as Schema from "effect/Schema";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import {
  DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST,
  loadPipelineConfig,
  PipelineConfigError,
  parsePipelineConfigParts,
  validatePipelineConfig,
  workflowSchema,
} from "../src/config";
import type { PipelineConfigParts } from "../src/config";
import { PACKAGE_DEFAULT_PIPELINE_YAML } from "../src/config/defaults";
import { lintPipelineConfig } from "../src/config/lint";
import { loadPackagePipelineConfig } from "../src/config/load";
import { configSchema } from "../src/config/schemas";
import { validatePipelineConfig as validatePipelineConfigModule } from "../src/config/validate";
import { parseWithSchema, struct } from "../src/schema-boundary";

const MIN_ITEMS_MESSAGE_RE = /at least|>=1|too small/iu;
const LINE_RE = /\r?\n/u;
const repoEntrypointSchema = struct({
  schedule: Schema.optional(Schema.String),
  workflow: Schema.optional(Schema.String),
});
const repoNodeSchema = struct({
  models: Schema.mutable(Schema.Array(Schema.String)),
});
const repoNodeCatalogSchema = struct({
  nodes: Schema.Record(Schema.String, repoNodeSchema),
  required_categories: Schema.mutable(Schema.Array(Schema.String)),
});
const repoPipelineYamlSchema = struct({
  entrypoints: struct({
    epic: Schema.optional(repoEntrypointSchema),
    execute: repoEntrypointSchema,
    inspect: repoEntrypointSchema,
    pipe: Schema.optional(repoEntrypointSchema),
    quick: repoEntrypointSchema,
  }),
  scheduler: struct({
    commands: struct({
      execute: struct({
        catalog: Schema.String,
        schedule: Schema.String,
      }),
      quick: struct({ catalog: Schema.String, schedule: Schema.String }),
    }),
    node_catalogs: struct({
      execute: repoNodeCatalogSchema,
      quick: repoNodeCatalogSchema,
    }),
  }),
  schedules: struct({
    "execute-schedule": Schema.Record(Schema.String, Schema.Unknown),
    "quick-schedule": Schema.Record(Schema.String, Schema.Unknown),
  }),
  workflows: Schema.optional(
    struct({
      default: Schema.optional(Schema.Unknown),
      "epic-drain": Schema.optional(Schema.Unknown),
      infra: Schema.optional(Schema.Unknown),
    }),
  ),
});
const profileYamlSchema = struct({
  filesystem: Schema.optional(
    struct({
      allow: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
      deny: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
      mode: Schema.optional(Schema.String),
    }),
  ),
  instructions: Schema.optional(struct({ path: Schema.optional(Schema.String) })),
  mcp_servers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  network: Schema.optional(struct({ mode: Schema.optional(Schema.String) })),
  output: Schema.optional(
    struct({
      format: Schema.optional(Schema.String),
      repair: Schema.optional(
        struct({
          enabled: Schema.optional(Schema.Boolean),
          max_attempts: Schema.optional(Schema.Number),
        }),
      ),
      schema_path: Schema.optional(Schema.String),
    }),
  ),
  runner: Schema.optional(Schema.String),
  skills: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
});
const profilesYamlSchema = struct({
  profiles: Schema.optional(Schema.Record(Schema.String, profileYamlSchema)),
  skills: Schema.optional(
    Schema.Record(
      Schema.String,
      struct({
        path: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const jsonSchemaValue = Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Schema.Unknown)]);
const unknownJsonString = Schema.fromJsonString(Schema.Unknown);

class ConfigTestError extends Schema.TaggedErrorClass<ConfigTestError>()("ConfigTestError", {
  message: Schema.String,
}) {}

const parseRepoPipelineYaml = (source: string) => parseWithSchema(repoPipelineYamlSchema, parse(source));

const parseProfilesYaml = (source: string) => parseWithSchema(profilesYamlSchema, parse(source));

const parseJsonWithSchema = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, source: string): S["Type"] =>
  parseWithSchema(Schema.fromJsonString(schema), source);

const parseJsonSchemaValue = (source: string) => parseJsonWithSchema(jsonSchemaValue, source);

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
  "",
);

const VALID_PARTS: PipelineConfigParts = {
  pipeline: VALID_PIPELINE_YAML,
  profiles: VALID_PROFILES_YAML,
  runners: VALID_RUNNERS_YAML,
};

let dirnamePath: (path: string) => string;
let joinPath: (...paths: string[]) => string;
let tempDirs: string[] = [];

beforeAll(async () => {
  const { dirname, join } = await import("node:path");
  dirnamePath = dirname;
  joinPath = join;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map(removePath));
  tempDirs = [];
});

const readText = async (path: string): Promise<string> => {
  const { readFile } = await import("node:fs/promises");
  return await readFile(path, "utf-8");
};

const writeText = async (path: string, content: string): Promise<void> => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content, "utf-8");
};

const makeDir = async (path: string): Promise<void> => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
};

const removePath = async (path: string): Promise<void> => {
  const { rm } = await import("node:fs/promises");
  await rm(path, { force: true, recursive: true });
};

const pathExists = async (path: string): Promise<boolean> => {
  const { access } = await import("node:fs/promises");
  return await access(path).then(
    () => true,
    () => false,
  );
};

const makeTempDir = async (prefix: string): Promise<string> => {
  const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ]);
  return await mkdtemp(join(tmpdir(), prefix));
};

const encodeJson = (value: unknown): string => Schema.encodeUnknownSync(unknownJsonString)(value);

const ensureParentDirectory = async (path: string): Promise<void> => {
  await makeDir(dirnamePath(path));
};

const writeProjectFile = async (root: string, path: string, content: string): Promise<void> => {
  const fullPath = joinPath(root, path);
  await ensureParentDirectory(fullPath);
  await writeText(fullPath, content);
};

const writeProjectJson = async (root: string, path: string, value: unknown): Promise<void> => {
  await writeProjectFile(root, path, encodeJson(value));
};

const makeProject = async (parts: PipelineConfigParts = VALID_PARTS, writeReferencedFiles = true): Promise<string> => {
  const dir = await makeTempDir("pipeline-config-");
  tempDirs.push(dir);
  await Promise.all([
    writeProjectFile(dir, ".pipeline/pipeline.yaml", parts.pipeline),
    writeProjectFile(dir, ".pipeline/profiles.yaml", parts.profiles),
    writeProjectFile(dir, ".pipeline/runners.yaml", parts.runners),
  ]);
  if (writeReferencedFiles) {
    await Promise.all([
      writeProjectFile(dir, "rules/test-first.md", "# Test first\n"),
      writeProjectFile(dir, ".agents/skills/repo-research/SKILL.md", "# Repo research\n"),
      writeProjectFile(dir, ".pipeline/prompts/orchestrator.md", "Orchestrate this workflow.\n"),
      writeProjectFile(dir, ".pipeline/prompts/researcher.md", "Research this repository.\n"),
      writeProjectJson(dir, ".pipeline/schemas/research.schema.json", {
        type: "object",
      }),
    ]);
  }
  return dir;
};

const parseParts = (parts: Partial<PipelineConfigParts>) => parsePipelineConfigParts({ ...VALID_PARTS, ...parts });

const profilesWithGatewayBackends = (backendsYaml: string): string =>
  VALID_PROFILES_YAML.replace(
    "  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION",
    `  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION\n${backendsYaml}`,
  );

const parseProjectParts = (projectRoot: string, parts: Partial<PipelineConfigParts> = {}) =>
  parsePipelineConfigParts({ ...VALID_PARTS, ...parts }, projectRoot);

const unknownErrorMessage = (error: unknown): string => String(error);

const captureConfigError = async (action: () => unknown): Promise<PipelineConfigError> => {
  const result = await Promise.resolve()
    .then(action)
    .then(
      () => new ConfigTestError({ message: "Expected PipelineConfigError" }),
      (error: unknown) =>
        error instanceof PipelineConfigError ? error : new ConfigTestError({ message: unknownErrorMessage(error) }),
    );
  if (result instanceof PipelineConfigError) {
    return result;
  }
  throw result;
};

const captureGatewayBackendConfigError = async (backendsYaml: string): Promise<PipelineConfigError> =>
  await captureConfigError(() =>
    parseParts({
      profiles: profilesWithGatewayBackends(backendsYaml),
    }),
  );

const defaultWorkflowPipeline = (nodesYaml: string, extraWorkflowsYaml = ""): string =>
  `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
${nodesYaml}${extraWorkflowsYaml}
`;

const activePackageProfilesYaml = async (): Promise<string> =>
  (await readText(joinPath(process.cwd(), ".pipeline/profiles.yaml")))
    .split(LINE_RE)
    .filter((line) => line.trim() !== "skills: [execute, quick, inspect]")
    .join("\n");

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

const writeDefaultPackageSkills = async (root: string): Promise<void> => {
  await Promise.all(
    DEFAULT_PACKAGE_SKILLS.map(
      async (skill) =>
        await writeProjectFile(
          root,
          `.agents/skills/${skill}/SKILL.md`,
          `---\nname: ${skill}\ndescription: Mock ${skill} skill.\n---\n`,
        ),
    ),
  );
};

const makePackageDefaultProject = async (input: {
  config?: { content: string; path: string };
  prefix: string;
}): Promise<string> => {
  const project = await makeTempDir(input.prefix);
  tempDirs.push(project);
  if (input.config) {
    await writeProjectFile(project, input.config.path, input.config.content);
  } else {
    await writeProjectFile(project, ".pipeline/pipeline.yaml", VALID_PIPELINE_YAML);
  }
  await writeDefaultPackageSkills(project);
  return project;
};

const loadPackageDefaults = (project: string) => loadPipelineConfig(project);

const expectedPackageScheduledEntrypoints = (): Record<string, unknown> => ({
  execute: { schedule: "execute-schedule" },
  inspect: { workflow: "inspect" },
  quick: { schedule: "quick-schedule" },
});

const expectedPackageSchedules = (): Record<string, Record<string, string>> => ({
  "execute-schedule": {
    baseline: "execute",
    node_catalog: "execute",
    planner_profile: "moka-schedule-planner",
  },
  "quick-schedule": {
    baseline: "quick",
    node_catalog: "quick",
    planner_profile: "moka-schedule-planner",
  },
});

const expectedSchedulerCommands = (): Record<string, Record<string, string>> => ({
  execute: {
    catalog: "execute",
    schedule: "execute-schedule",
  },
  quick: {
    catalog: "quick",
    schedule: "quick-schedule",
  },
});

const expectedExecuteRequiredCategories = (): string[] => [
  "intake",
  "research",
  "red",
  "green",
  "mechanical",
  "acceptance",
  "verification",
  "learn",
];

const EXPECTED_CONFIG_MODULES = [
  { exportValue: PACKAGE_DEFAULT_PIPELINE_YAML, name: "defaults" },
  { exportValue: configSchema, name: "schemas" },
  { exportValue: loadPackagePipelineConfig, name: "load" },
  { exportValue: validatePipelineConfigModule, name: "validate" },
  { exportValue: lintPipelineConfig, name: "lint" },
];

describe("config module boundaries", () => {
  it("keeps the split config implementation in focused source modules", async () => {
    const ownerFiles = await Promise.all(
      EXPECTED_CONFIG_MODULES.map(async ({ name }) => ({
        exists: await pathExists(joinPath(process.cwd(), "src", "config", `${name}.ts`)),
        name,
      })),
    );

    expect(ownerFiles.filter((file) => !file.exists)).toEqual([]);
  });

  it("makes each focused config module importable for cohesive reuse", () => {
    expect(EXPECTED_CONFIG_MODULES.map(({ exportValue }) => typeof exportValue)).toEqual([
      "string",
      "object",
      "function",
      "function",
      "function",
    ]);
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
  it("loads package-owned defaults when the repo has no pipeline files", async () => {
    const project = await makeTempDir("pipeline-config-defaults-");
    tempDirs.push(project);
    await writeDefaultPackageSkills(project);

    const config = loadPipelineConfig(project);

    expect(await pathExists(joinPath(project, ".pipeline"))).toBe(false);
    expect(config.default_workflow).toBe("inspect");
    expect(config.entrypoints).toMatchObject(expectedPackageScheduledEntrypoints());
    expect(config.entrypoints.pipe).toBeUndefined();
    expect(config.entrypoints.epic).toBeUndefined();
    expect(config.runners.opencode.type).toBe("opencode");
    const mokaProfileIds = [
      "moka-orchestrator",
      "moka-researcher",
      "moka-ticket-scoper",
      "moka-inspector",
      "moka-schedule-planner",
      "moka-test-writer",
      "moka-code-writer",
      "moka-acceptance-reviewer",
      "moka-thermo-nuclear-reviewer",
      "moka-verifier",
      "moka-learner",
    ];

    expect(mokaProfileIds.map((id) => [id, config.profiles[id].runner])).toEqual([
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
    expect(config.schedules["execute-schedule"]).toMatchObject(expectedPackageSchedules()["execute-schedule"]);
    expect(config.schedules["quick-schedule"]).toMatchObject(expectedPackageSchedules()["quick-schedule"]);
    expect(config.scheduler.commands).toMatchObject(expectedSchedulerCommands());
    expect(config.scheduler.node_catalogs.execute.required_categories).toEqual(expectedExecuteRequiredCategories());
    expect(config.scheduler.node_catalogs.execute.nodes["red-tests"].models).toEqual(expect.any(Array));
    expect(config.workflows.inspect.nodes.map((node) => node.id)).toEqual(["inspect"]);
    expect(config.profiles["moka-code-writer"].scheduling_roles).toEqual(["implementation"]);
    expect(config.profiles["moka-test-writer"].scheduling_roles).toEqual(["implementation"]);
    expect(config.profiles["moka-test-writer"].output).toMatchObject({
      format: "json_schema",
      repair: {
        enabled: true,
        max_attempts: 1,
      },
      schema_path: ".pipeline/schemas/implementation.schema.json",
    });
    expect(config.profiles["moka-test-writer"].instructions.inline).toContain("Only edit files matching test paths");
    expect(config.profiles["moka-test-writer"].instructions.inline).toContain(
      "This scheduled node is already dispatched by Moka",
    );
    expect(config.profiles["moka-test-writer"].instructions.inline).toContain(
      "Do not invoke `moka run`, `moka submit`, `$dispatch`, `$scope`, `$execute`, or any nested Moka/workflow supervisor",
    );
    expect(config.profiles["moka-code-writer"].instructions.inline).toContain(
      "This scheduled node is already dispatched by Moka",
    );
    expect(config.profiles["moka-code-writer"].instructions.inline).toContain(
      "Do not invoke `moka run`, `moka submit`, `$dispatch`, `$scope`, `$execute`, or any nested Moka/workflow supervisor",
    );
    expect(config.profiles["moka-researcher"].timeout_ms).toBe(900_000);
    expect(config.profiles["moka-schedule-planner"].timeout_ms).toBe(300_000);
    expect(config.profiles["moka-test-writer"].timeout_ms).toBe(1_800_000);
    expect(config.profiles["moka-code-writer"].timeout_ms).toBe(1_800_000);
    expect(config.profiles["moka-researcher"].instructions.inline).toContain(
      "do not perform open-ended repository exploration",
    );
    expect(config.profiles["moka-verifier"].scheduling_roles).toEqual(["coverage"]);
    const acceptanceInstructions = config.profiles["moka-acceptance-reviewer"].instructions.inline ?? "";
    expect(acceptanceInstructions).toContain("Return only valid JSON");
    expect(acceptanceInstructions).toContain('"acceptance"');
    const verifierInstructions = config.profiles["moka-verifier"].instructions.inline ?? "";
    expect(verifierInstructions).toContain("Return only valid JSON");
    expect(verifierInstructions).toContain('"verdict"');
    expect(config.hooks.on["workflow.start"]).toEqual([
      expect.objectContaining({ function: "generated-defaults-audit" }),
    ]);
    const generatedDefaultsAudit = config.hooks.functions["generated-defaults-audit"];
    expect(generatedDefaultsAudit.kind).toBe("command");
    if (generatedDefaultsAudit.kind !== "command") {
      throw new ConfigTestError({
        message: "expected generated defaults audit command hook",
      });
    }
    expect(generatedDefaultsAudit.command.join(" ")).toContain("PIPELINE_HOOK_RESULT");
    // Dependency/toolchain bootstrap is repo-owned and required: the default
    // first setup step runs the repo's declared bootstrap (.moka/bootstrap.sh or
    // a "moka:setup" script) and fails loudly otherwise — moka never guesses it.
    // moka's own runtime provisioning is a single `moka init --force` step.
    const { setup } = config.runner_command.environment;
    expect(setup).toHaveLength(2);
    expect(setup[0].command).toBe("sh");
    expect(setup[0].args[0]).toBe("-c");
    expect(setup[0].args[1]).toContain(".moka/bootstrap.sh");
    expect(setup[0].args[1]).toContain("moka:setup");
    expect(setup[0].required).toBe(true);
    expect(setup[1]).toEqual({
      args: ["init", "--force"],
      command: "moka",
      required: true,
    });
  });

  it("parses a complete valid custom config from explicit config parts", async () => {
    const project = await makeProject();

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
    expect(config.workflows.default.nodes.map((node) => node.id)).toEqual(["research", "red"]);
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

  it("declares a ticket scoper profile with binding scope instructions", async () => {
    const project = await makeTempDir("pipeline-config-defaults-");
    tempDirs.push(project);
    await writeDefaultPackageSkills(project);

    const profile = loadPipelineConfig(project).profiles["moka-ticket-scoper"];

    expect(profile.skills).toContain("scope");
    expect(profile.output).toMatchObject({
      format: "json_schema",
      schema_path: ".pipeline/schemas/ticket-plan.schema.json",
    });
    expect(profile.instructions.inline).toContain("scope skill contract");
    expect(profile.instructions.inline).toContain("Do not emit partial tickets");
  });

  it("parses a minimal custom pipeline config without an orchestrator", async () => {
    const project = await makeProject({
      ...VALID_PARTS,
      pipeline: VALID_PIPELINE_WITHOUT_ORCHESTRATOR_YAML,
    });

    const config = parseProjectParts(project, {
      pipeline: VALID_PIPELINE_WITHOUT_ORCHESTRATOR_YAML,
    });

    expect(config.default_workflow).toBe("default");
    expect(config.workflows.default.nodes.map((node) => node.id)).toEqual(["research", "red"]);
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
        "    model: gpt-5-agent\n    host_models:\n      opencode: openai/gpt-5.3\n    runner: opencode",
      ),
      runners: VALID_RUNNERS_YAML.replace(
        "    model: gpt-5-runner",
        "    model: gpt-5-runner\n    host_models:\n      opencode: openai/gpt-5.3",
      ),
    });

    expect(config.runners.opencode.host_models?.opencode).toBe("openai/gpt-5.3");
    expect(config.profiles.researcher.host_models?.opencode).toBe("openai/gpt-5.3");
  });

  it("rejects direct MCP server registry entries in profiles config", async () => {
    const profiles = VALID_PROFILES_YAML.replace(
      "profiles:",
      `mcp_servers:
  docs:
    command: npx
    args: ["-y", "@example/docs-mcp"]
profiles:`,
    );

    const error = await captureConfigError(() => parseParts({ profiles }));

    expect(error.message).toContain("mcp_servers.docs");
  });

  it("rejects mcp-json MCP server refs", async () => {
    const profiles = VALID_PROFILES_YAML.replace(
      "profiles:",
      `mcp_servers:
  docs:
    ref:
      path: .mcp.json
      id: serena
profiles:`,
    );
    const project = await makeProject({ ...VALID_PARTS, profiles });
    await writeProjectJson(project, ".mcp.json", { mcpServers: {} });

    const error = await captureConfigError(() => parseProjectParts(project, { profiles }));

    expect(error.message).toContain("mcp_servers.docs");
  });

  it("loads package-owned defaults when repo-local config files are incomplete", async () => {
    const config = loadPackageDefaults(await makePackageDefaultProject({ prefix: "pipeline-config-missing-" }));

    expect(config.default_workflow).toBe("inspect");
    expect(config.profiles["moka-researcher"]).toBeDefined();
  });

  it("loads package-owned defaults when legacy repo-local config.toml exists", async () => {
    const config = loadPackageDefaults(
      await makePackageDefaultProject({
        config: { content: "[phases]\n", path: ".pipeline/config.toml" },
        prefix: "pipeline-config-legacy-",
      }),
    );

    expect(config.default_workflow).toBe("inspect");
    expect(config.profiles["moka-researcher"]).toBeDefined();
  });

  it("rejects malformed explicit custom YAML with a parse error", async () => {
    const error = await captureConfigError(() => parseParts({ pipeline: "version: 1\nworkflows: [" }));

    expect(error.code).toBe("PIPELINE_CONFIG_PARSE_ERROR");
    expect(error.message).toContain("Failed to parse");
    expect(error.issues.length).toBeGreaterThan(0);
  });
});

describe("parsePipelineConfigParts", () => {
  it("rejects unknown top-level keys in the pipeline file", async () => {
    const error = await captureConfigError(() => parseParts({ pipeline: `${VALID_PIPELINE_YAML}\nprofiles: {}\n` }));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Unrecognized key");
  });

  it("rejects missing runner references", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        profiles: VALID_PROFILES_YAML.replace("runner: opencode", "runner: missing-runner"),
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("missing runner 'missing-runner'");
  });

  it("requires a configured orchestrator profile", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace("profile: orchestrator", "profile: missing-orchestrator"),
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("orchestrator.profile");
  });

  it("validates orchestrator references and runner capabilities", async () => {
    const profiles = VALID_PROFILES_YAML.replace(
      "mcp_servers: [pipeline-gateway]\n    tools: [read, list, grep, glob, bash]\n    filesystem:",
      "mcp_servers: [missing]\n    tools: [read, write]\n    filesystem:",
    );
    const runners = VALID_RUNNERS_YAML.replace("tools: [read, list, grep, glob, bash, edit, write]", "tools: [read]");

    const error = await captureConfigError(() => parseParts({ profiles, runners }));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("profiles.orchestrator.mcp_servers");
    expect(error.message).toContain("missing MCP server 'missing'");
    expect(error.message).toContain("profiles.orchestrator.tools");
    expect(error.message).toContain("does not support tool 'write'");
  });

  it("rejects missing profile references in workflow nodes", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace("profile: test-writer", "profile: missing-profile"),
      }),
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
        acceptance_criteria: [{ id: "1", text: "Agent prompts include node-specific context." }],
        description: "Carry child ticket context into this node.",
        id: "PIPE-41.7",
        title: "Propagate node-level task context",
      },
    });
    expect(config.workflows.default.nodes[0].gates?.map((gate) => gate.kind)).toEqual([
      "verdict",
      "acceptance",
      "changed_files",
    ]);
  });

  it("warns when a configured entrypoint shadows the builtin ticket command", async () => {
    const project = await makeProject();
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
      message:
        "entrypoint 'ticket' is shadowed by the builtin subcommand; invoke via 'moka run --entrypoint ticket ...'",
      ruleId: "entrypoint-shadowed",
    });
  });

  it("rejects obsolete schedule planner_strategy config", async () => {
    const error = await captureConfigError(() =>
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
      }),
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

  it("accepts drain-merge as a workflow builtin but not as a builtin gate", async () => {
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

    const error = await captureConfigError(() =>
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
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("workflows.default.nodes.0.gates.0.builtin");
    expect(error.message).toContain("Invalid option");
  });

  it("rejects entrypoints pointing at missing workflows", async () => {
    const error = await captureConfigError(() =>
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
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("entrypoint 'bad' references missing workflow");
  });

  it("rejects scheduled entrypoints pointing at missing schedule policies", async () => {
    const error = await captureConfigError(() =>
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
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("entrypoint 'bad' references missing schedule");
  });

  it("rejects schedules pointing at missing planner profiles", async () => {
    const error = await captureConfigError(() =>
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
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("schedule 'bad-schedule' references missing planner profile");
  });

  it("rejects invalid gate shapes by kind", async () => {
    const error = await captureConfigError(() =>
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
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("changed_files");
  });

  it("rejects missing rule, skill, and MCP server references", async () => {
    const profiles = VALID_PROFILES_YAML.replace("rules: [test-first]", "rules: [missing]")
      .replace("skills: [repo-research]", "skills: [missing]")
      .replace("mcp_servers: [pipeline-gateway]", "mcp_servers: [missing]");

    const error = await captureConfigError(() => parseParts({ profiles }));

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
      backlog: {
        locality: "repo-local",
        tool_prefixes: ["backlog"],
        workspace_path_source: "PIPELINE_TARGET_PATH",
      },
      context7: {
        locality: "shared-remote",
        required: true,
        tool_prefixes: ["context7"],
      },
      fallow: {
        locality: "repo-local",
        required: false,
        tool_prefixes: ["fallow"],
        workspace_path_source: "cwd",
      },
    });
    expect(config.mcp_servers).toEqual({});
    expect(config.profiles.orchestrator.mcp_servers).toEqual(["pipeline-gateway"]);
  });

  it("rejects unknown gateway backend keys", async () => {
    const error = await captureGatewayBackendConfigError(`  backends:
    serena:
      locality: repo-local
      workspace_path_source: cwd
      tool_prefixes: [serena]
      clone_url: https://github.com/example/repo.git`);

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Unrecognized key");
    expect(error.message).toContain("clone_url");
  });

  it("rejects invalid repo-local gateway backend locality", async () => {
    const error = await captureGatewayBackendConfigError(`  backends:
    serena:
      locality: workspace-clone
      workspace_path_source: cwd
      tool_prefixes: [serena]`);

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Invalid option");
    expect(error.message).toContain("repo-local");
    expect(error.message).toContain("shared-remote");
  });

  it("rejects repo-local gateway backends without an active workspace source", async () => {
    const error = await captureGatewayBackendConfigError(`  backends:
    serena:
      locality: repo-local
      tool_prefixes: [serena]`);

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("repo-local gateway backend must declare workspace_path_source");
  });

  it("rejects direct upstream MCP grants when mcp_gateway is configured", async () => {
    const profiles = VALID_PROFILES_YAML.replace(
      "mcp_servers: [pipeline-gateway]",
      "mcp_servers: [pipeline-gateway, serena]",
    );

    const error = await captureConfigError(() => parseParts({ profiles }));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("profiles.orchestrator.mcp_servers must only reference pipeline-gateway");
  });

  it("rejects duplicate workflow node ids", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace("id: red", "id: research"),
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("duplicate node id 'research'");
  });

  it("rejects invalid needs references", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace("needs: [research]", "needs: [missing-node]"),
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("missing dependency 'missing-node'");
  });

  it("rejects unsupported node kinds", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace("kind: agent", "kind: phase"),
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Invalid discriminator value");
  });

  it("rejects invalid workflow node field combinations", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace(
          "profile: researcher",
          "profile: researcher\n        command: [echo, bad]",
        ),
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Unrecognized key");
  });

  it("rejects workflow nodes", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: defaultWorkflowPipeline(
          `
      - id: child
        kind: workflow
        workflow: subflow
`,
          `  subflow:
    nodes:
      - id: research
        kind: agent
        profile: researcher
`,
        ),
      }),
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

    const grouped = config.workflows.default.nodes.find((node) => node.id === "grouped");
    const fanout = config.workflows.default.nodes.find((node) => node.id === "fanout");

    expect(grouped).toMatchObject({
      kind: "group",
      nodes: ["before"],
    });
    expect(fanout).toMatchObject({ kind: "parallel" });
    if (fanout?.kind !== "parallel") {
      throw new PipelineConfigError("PIPELINE_CONFIG_VALIDATION_ERROR", "expected fanout parallel node");
    }
    expect(fanout.kind).toBe("parallel");
    expect(fanout.nodes.map((node) => node.id)).toEqual(["child-command", "nested"]);
    expect(fanout.nodes[1]).toMatchObject({
      kind: "parallel",
      nodes: [
        expect.objectContaining({ id: "nested-command", kind: "command" }),
        expect.objectContaining({ id: "nested-agent", kind: "agent" }),
      ],
    });
  });

  it("rejects parallel nodes with no children", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: defaultWorkflowPipeline(`
      - id: empty-fanout
        kind: parallel
        nodes: []
`),
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(
      error.issues.some(
        (issue) => issue.path === "workflows.default.nodes.0.nodes" && MIN_ITEMS_MESSAGE_RE.test(issue.message),
      ),
    ).toBe(true);
  });

  it("rejects workflow node syntax without a workflow field", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: defaultWorkflowPipeline(`
      - id: child
        kind: workflow
`),
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("Invalid discriminator value");
  });

  it("rejects unsupported hook events", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: VALID_PIPELINE_YAML.replace("workflow.complete:", "workflow.done:"),
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("unsupported hook event 'workflow.done'");
  });

  it("rejects tool grants outside runner capabilities", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        runners: VALID_RUNNERS_YAML.replace("tools: [read, list, grep, glob, bash, edit, write]", "tools: [read]"),
      }),
    );

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("does not support tool 'list'");
  });

  it("rejects filesystem, network, and output grants outside runner capabilities", async () => {
    const runners = VALID_RUNNERS_YAML.replace(
      "filesystem: [read-only, workspace-write]",
      "filesystem: [workspace-write]",
    )
      .replace("network: [inherit]", "network: [disabled]")
      .replace("output_formats: [text, json, jsonl, json_schema]", "output_formats: [text]");

    const error = await captureConfigError(() => parseParts({ runners }));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("does not support filesystem mode 'read-only'");
  });

  it("rejects missing output repair runner references", async () => {
    const profiles = VALID_PROFILES_YAML.replace(
      "max_attempts: 1",
      "max_attempts: 1\n        runner: missing-repair-runner",
    );

    const error = await captureConfigError(() => parseParts({ profiles }));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("missing repair runner");
  });

  it("rejects missing instruction and schema files", async () => {
    const project = await makeProject(VALID_PARTS, false);

    const error = await captureConfigError(() => parseProjectParts(project));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("referenced file");
  });

  it("rejects a missing rule file but tolerates an install-managed skill body", async () => {
    const project = await makeProject();
    await Promise.all([
      removePath(joinPath(project, "rules/test-first.md")),
      removePath(joinPath(project, ".agents/skills/repo-research/SKILL.md")),
    ]);

    const error = await captureConfigError(() => parseProjectParts(project));

    expect(error.code).toBe("PIPELINE_CONFIG_VALIDATION_ERROR");
    expect(error.message).toContain("rules.test-first.path");
    // Skill bodies are install-managed, so a missing one is not a config defect.
    expect(error.message).not.toContain("skills.repo-research.path");
  });

  describe("PIPE-91.3: legacy durability block deprecation", () => {
    it("emits a structured deprecation diagnostic and parses successfully when durability block is present", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const config = parseParts({
        pipeline: `${VALID_PIPELINE_YAML}\ndurability:\n  enabled: true\n  dir: .pipeline/journal\n`,
      });

      // Deprecation diagnostic must name the removed field and the replacement.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("durability"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("db.url"));
      // The returned config must NOT carry the durability block.
      expect(config).not.toHaveProperty("durability");
      // The rest of the config must be valid.
      expect(config.default_workflow).toBe("default");
    });

    it("parses cleanly and emits no warning when no durability block is present", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      parseParts({ pipeline: VALID_PIPELINE_YAML });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

const readRepoPipelineYaml = async () =>
  parseRepoPipelineYaml(await readText(joinPath(process.cwd(), ".pipeline/pipeline.yaml")));

describe("execute/quick scheduler integration", () => {
  it("declares scheduled execute/quick entrypoints and removes legacy entrypoints", async () => {
    const config = await readRepoPipelineYaml();
    const { entrypoints, schedules } = config;

    expect(entrypoints.execute).toMatchObject({ schedule: "execute-schedule" });
    expect(entrypoints.quick).toMatchObject({ schedule: "quick-schedule" });
    expect(entrypoints.inspect).toMatchObject({ workflow: "inspect" });
    expect(entrypoints.pipe).toBeUndefined();
    expect(entrypoints.epic).toBeUndefined();
    expect(schedules["execute-schedule"]).toMatchObject(expectedPackageSchedules()["execute-schedule"]);
    expect(schedules["quick-schedule"]).toMatchObject(expectedPackageSchedules()["quick-schedule"]);
    expect(config.workflows?.default).toBeUndefined();
    expect(config.workflows?.infra).toBeUndefined();
    expect(config.workflows?.["epic-drain"]).toBeUndefined();
  });

  it("declares configurable scheduler node catalogs with model fallback arrays", async () => {
    const config = await readRepoPipelineYaml();
    const { commands } = config.scheduler;
    const { execute: executeCatalog, quick: quickCatalog } = config.scheduler.node_catalogs;

    expect([
      ["execute", commands.execute.schedule],
      ["quick", commands.quick.schedule],
    ]).toEqual([
      ["execute", "execute-schedule"],
      ["quick", "quick-schedule"],
    ]);
    expect(commands.execute).toMatchObject(expectedSchedulerCommands().execute);
    expect(commands.quick).toMatchObject(expectedSchedulerCommands().quick);
    expect(executeCatalog.required_categories).toEqual(expectedExecuteRequiredCategories());
    expect([
      executeCatalog.nodes["red-tests"].models,
      executeCatalog.nodes["green-backend"].models,
      executeCatalog.nodes["green-frontend"].models,
    ]).toEqual([expect.any(Array), expect.any(Array), expect.any(Array)]);
    expect(quickCatalog.nodes["green-implementation"].models).toEqual(expect.any(Array));
    expect(executeCatalog.nodes["red-tests"].models.length).toBeGreaterThan(1);
    expect(executeCatalog.nodes["green-backend"].models.length).toBeGreaterThan(1);
  });

  it("prefers non-Kimi first-choice models for progress-critical scheduler nodes", async () => {
    const config = await readRepoPipelineYaml();
    const { execute: executeCatalog, quick: quickCatalog } = config.scheduler.node_catalogs;

    expect(quickCatalog.nodes["green-implementation"].models[0]).not.toBe("kimi-for-coding/k2p6");
    expect(executeCatalog.nodes.research.models[0]).not.toBe("kimi-for-coding/k2p6");
    expect(executeCatalog.nodes["green-frontend"].models[0]).not.toBe("kimi-for-coding/k2p6");
  });

  it("keeps legacy epic-router package assets out of the active profile graph", async () => {
    const profilesYaml = await activePackageProfilesYaml();
    const profilesConfig = parseProfilesYaml(profilesYaml);

    expect(profilesConfig.profiles?.["moka-epic-router"]).toBeUndefined();
    expect(profilesConfig.profiles?.["moka-thermo-nuclear-reviewer"]).toBeDefined();
  });

  it("ignores pipeline run worktrees", async () => {
    const gitignore = (await readText(joinPath(process.cwd(), ".gitignore"))).split(LINE_RE).map((line) => line.trim());

    expect(gitignore).toContain(".pipeline/runs/");
  });
});

describe("opencode profile integration", () => {
  it("declares the installed critique skill and reviewer profile contract", async () => {
    const profilesYaml = await activePackageProfilesYaml();
    const runnersYaml = await readText(joinPath(process.cwd(), ".pipeline/runners.yaml"));
    const parsed = parsePipelineConfigParts({
      pipeline: await readText(joinPath(process.cwd(), ".pipeline/pipeline.yaml")),
      profiles: profilesYaml,
      runners: runnersYaml,
    });

    expect(parsed.runners.opencode.capabilities.skills).toBe(true);
    expect(parsed.runners.opencode.capabilities.rules).toBe(true);
    expect(parsed.runners.opencode.capabilities.mcp_servers).toBe(true);
    expect(parsed.profiles["moka-opencode-researcher"]).toMatchObject({
      instructions: { path: ".pipeline/prompts/researcher.md" },
      runner: "opencode",
    });
    expect(parsed.profiles["moka-opencode-code-writer"]).toMatchObject({
      instructions: { path: ".pipeline/prompts/code-writer.md" },
      runner: "opencode",
      scheduling_roles: ["implementation"],
    });
    expect(parsed.profiles["moka-opencode-test-writer"]).toMatchObject({
      instructions: { path: ".pipeline/prompts/test-writer.md" },
      output: {
        format: "json_schema",
        repair: { enabled: true, max_attempts: 1 },
        schema_path: ".pipeline/schemas/implementation.schema.json",
      },
      runner: "opencode",
      scheduling_roles: ["implementation"],
    });
    expect(parsed.profiles["moka-opencode-verifier"]).toMatchObject({
      instructions: { path: ".pipeline/prompts/verifier.md" },
      runner: "opencode",
      scheduling_roles: ["coverage"],
    });
  });
});

describe("final review asset bundle", () => {
  it("declares the installed critique skill and reviewer profile contract", async () => {
    const profilesYaml = await readText(joinPath(process.cwd(), ".pipeline/profiles.yaml"));
    const profilesConfig = parseProfilesYaml(profilesYaml);

    expect(profilesConfig.skills?.critique).toEqual({
      path: ".agents/skills/critique/SKILL.md",
    });

    const profile = profilesConfig.profiles?.["moka-thermo-nuclear-reviewer"];
    expect(profile, "profiles.moka-thermo-nuclear-reviewer should exist in .pipeline/profiles.yaml").toBeDefined();
    expect(profile).toMatchObject({
      filesystem: {
        allow: ["**/*"],
        deny: ["node_modules/**", "dist/**", ".git/**"],
        mode: "read-only",
      },
      instructions: {
        path: ".agents/skills/critique/SKILL.md",
      },
      mcp_servers: ["pipeline-gateway"],
      network: { mode: "inherit" },
      output: {
        format: "json_schema",
        repair: {
          enabled: true,
          max_attempts: 1,
        },
        schema_path: ".pipeline/schemas/review.schema.json",
      },
      runner: "opencode",
      skills: ["critique"],
    });
    expect(profile?.tools).toEqual(["read", "list", "grep", "glob", "bash"]);
  });

  it("validates the final review output schema contract", async () => {
    const schema = parseJsonSchemaValue(
      await readText(joinPath(process.cwd(), ".pipeline/schemas/review.schema.json")),
    );
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    expect(
      validate({
        findings: [
          {
            file: "src/index.ts",
            line: 42,
            message: "Documented non-blocking issue.",
            rule: "scope-discipline",
            severity: "warn",
          },
        ],
        summary: "No blocking issues found.",
        verdict: "PASS",
      }),
      encodeJson(validate.errors),
    ).toBe(true);
    expect(validate({ findings: [], verdict: "FAIL" })).toBe(true);
    expect(validate({ findings: [] }), "verdict is required").toBe(false);
    expect(validate({ findings: [], verdict: "MAYBE" }), "verdict must be PASS or FAIL").toBe(false);
    expect(validate({ verdict: "FAIL" }), "findings is required").toBe(false);
    expect(validate({ findings: [{}], verdict: "FAIL" }), "findings require severity and message").toBe(false);
    expect(
      validate({
        findings: [{ line: 0, message: "bad", severity: "critical" }],
        verdict: "FAIL",
      }),
      "finding line numbers are 1-based",
    ).toBe(false);
  });

  it("wires the install-managed critique skill into the reviewer profile", () => {
    // Skill bodies are installed from the shared agent harness into host dirs,
    // not bundled in the package, so the contract is the config wiring: the
    // reviewer grants the critique skill and the skill is declared in the
    // registry.
    const config = loadPackagePipelineConfig(process.cwd());

    expect(config.skills.critique).toBeDefined();
    expect(config.profiles["moka-thermo-nuclear-reviewer"]?.skills).toContain("critique");
  });
});

const MAX_CONTEXT_PCT_RE = /max_context_pct/iu;
const UNKNOWN_CATEGORY_RE = /unknown node category 'green'/iu;

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

  it("rejects max_context_pct above 100", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: `${VALID_PIPELINE_YAML}\ntoken_budget:\n  max_context_pct: 150\n`,
      }),
    );
    expect(error.message).toMatch(MAX_CONTEXT_PCT_RE);
  });

  it("rejects a non-positive context window", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: `${VALID_PIPELINE_YAML}\ntoken_budget:\n  default_context_window: -1\n`,
      }),
    );
    expect(error).toBeInstanceOf(PipelineConfigError);
  });

  it("rejects a fan-out cap for an unknown node category", async () => {
    const error = await captureConfigError(() =>
      parseParts({
        pipeline: `${VALID_PIPELINE_YAML}\ntoken_budget:\n  fan_out_width:\n    by_category:\n      green: 2\n`,
      }),
    );
    expect(error.message).toMatch(UNKNOWN_CATEGORY_RE);
  });
});
