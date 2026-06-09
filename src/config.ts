import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";
import { resolveFileReference } from "./path-refs";
import { standardOutputSchemaNameFromPath } from "./standard-output-schemas";

export const PIPELINE_CONFIG_PATH = ".pipeline/pipeline.yaml";
export const RUNNERS_CONFIG_PATH = ".pipeline/runners.yaml";
export const PROFILES_CONFIG_PATH = ".pipeline/profiles.yaml";
export const OPENCODE_ECOSYSTEM_MANIFEST_PATH =
  "defaults/opencode-ecosystem.yaml";

const ID_RE = /^[a-z][a-z0-9-]*$/;

const RUNNER_TYPES = ["codex", "opencode", "command"] as const;
const NODE_KINDS = [
  "agent",
  "command",
  "builtin",
  "group",
  "parallel",
  "workflow",
] as const;
const HOOK_EVENTS = [
  "workflow.start",
  "workflow.success",
  "workflow.failure",
  "workflow.complete",
  "node.start",
  "node.success",
  "node.error",
  "node.finish",
  "gate.failure",
] as const;
const TOOL_NAMES = [
  "read",
  "list",
  "grep",
  "glob",
  "bash",
  "edit",
  "write",
  "task",
] as const;
const FILESYSTEM_MODES = ["read-only", "workspace-write"] as const;
const NETWORK_MODES = ["inherit", "disabled"] as const;
const OUTPUT_FORMATS = ["text", "json", "jsonl", "json_schema"] as const;
const GATE_KINDS = [
  "acceptance",
  "artifact",
  "builtin",
  "changed_files",
  "command",
  "json_schema",
  "verdict",
] as const;
const BUILTIN_GATES = [
  "duplication",
  "fallow",
  "lint",
  "semgrep",
  "test",
  "typecheck",
] as const;
const RETRY_REASONS = ["exit_nonzero", "gate_failure", "timeout"] as const;
const SCHEDULE_BASELINES = ["execute", "quick"] as const;
const SCHEDULE_STRATEGIES = ["planner"] as const;
const SCHEDULING_ROLES = ["coverage", "implementation"] as const;
const MCP_GATEWAY_BACKEND_LOCALITIES = [
  "repo-local",
  "repo-scoped-remote",
  "shared-remote",
] as const;
const MCP_GATEWAY_WORKSPACE_PATH_SOURCES = [
  "PIPELINE_TARGET_PATH",
  "cwd",
] as const;
const PIPELINE_GATEWAY_SERVER_ID = "pipeline-gateway";
export const DEFAULT_RUNNER_JOB_GIT_COMMITTER = {
  email: "git@oisin.ee",
  name: "oisin-bot",
} as const;

const PACKAGE_DEFAULT_RUNNERS_YAML = `version: 1
runners:
  codex:
    type: codex
    model: gpt-5.5
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit, disabled]
      output_formats: [text, json, jsonl, json_schema]
  opencode:
    type: opencode
    model: openai/gpt-5.5
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit, disabled]
      output_formats: [text, json, jsonl, json_schema]
  command:
    type: command
    capabilities:
      native_subagents: false
      rules: false
      skills: false
      mcp_servers: false
      tools: [bash]
      filesystem: [read-only, workspace-write]
      network: [inherit, disabled]
      output_formats: [text, json]
`;

const PACKAGE_DEFAULT_PROFILES_YAML = `version: 1
mcp_gateway:
  provider: toolhive
  mode: local
  url: https://pipeline-mcp.momokaya.ee/mcp/
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
  default_profile: default
  backends:
    context7:
      locality: shared-remote
      tool_prefixes: [context7]
    uidotsh:
      locality: shared-remote
      tool_prefixes: [uidotsh]
    qdrant:
      locality: repo-scoped-remote
      tool_prefixes: [qdrant]
    fallow:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      required: false
      tool_prefixes: [fallow]
    serena:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      tool_prefixes: [serena]
    backlog:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      tool_prefixes: [backlog]
skills:
  critique:
    path: .agents/skills/critique/SKILL.md
    source_root: package
  doubt:
    path: .agents/skills/doubt/SKILL.md
    source_root: package
  fix:
    path: .agents/skills/fix/SKILL.md
    source_root: package
  library-first-development:
    path: .agents/skills/library-first-development/SKILL.md
    source_root: package
  migrate:
    path: .agents/skills/migrate/SKILL.md
    source_root: package
  optimize:
    path: .agents/skills/optimize/SKILL.md
    source_root: package
  research:
    path: .agents/skills/research/SKILL.md
    source_root: package
  schedule-graph-shaping:
    path: .pipeline/skills/schedule-graph-shaping/SKILL.md
    source_root: package
  scope:
    path: .agents/skills/scope/SKILL.md
    source_root: package
  secure:
    path: .agents/skills/secure/SKILL.md
    source_root: package
  spec:
    path: .agents/skills/spec/SKILL.md
    source_root: package
  test:
    path: .agents/skills/test/SKILL.md
    source_root: package
  trace:
    path: .agents/skills/trace/SKILL.md
    source_root: package
  verify:
    path: .agents/skills/verify/SKILL.md
    source_root: package
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: "Orchestrate package-owned pipeline config." }
    skills: [scope, doubt]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
  pipeline-researcher:
    runner: opencode
    description: Research the requested task and produce structured findings.
    instructions: { inline: "Inspect first-party source, tests, docs, and task context for the current task only. Produce concise findings with file references and stop; do not perform open-ended repository exploration." }
    timeout_ms: 900000
    skills: [research, spec, scope]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
    output:
      format: json_schema
      schema_path: .pipeline/schemas/research.schema.json
      repair: { enabled: true, max_attempts: 1 }
  pipeline-inspector:
    runner: opencode
    description: Inspect the repository without modifying files.
    instructions: { inline: "Inspect the repository without modifying files." }
    skills: [research]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
  pipeline-schedule-planner:
    runner: opencode
    description: Refine a baseline schedule into a specialized approved-plan artifact.
    instructions: { inline: "Generate exactly one workflow named root as an explicit schedule graph. Return YAML only." }
    skills: [schedule-graph-shaping]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
  pipeline-test-writer:
    runner: opencode
    scheduling_roles: [implementation]
    description: Add focused failing tests for the requested behavior.
    instructions: { inline: "Add focused failing tests for the requested behavior only. Do not change production code. Only edit files matching test paths such as **/*.test.*, **/*.spec.*, **/*_test.*, **/__tests__/**, test/**, or tests/**. Return only valid JSON with top-level changes and verification. Every changes entry must include summary, why, and files. Include risks, followups, and lessons when present. Do not use Markdown fences or prose outside the JSON object." }
    skills: [test]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash, edit, write]
    filesystem: { mode: workspace-write, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
    output:
      format: json_schema
      schema_path: .pipeline/schemas/implementation.schema.json
      repair: { enabled: true, max_attempts: 1 }
  pipeline-code-writer:
    runner: opencode
    scheduling_roles: [implementation]
    description: Implement production code until the failing tests pass.
    instructions: { inline: "Implement the smallest production change that satisfies the failing tests. Return only valid JSON with top-level changes and verification. Every changes entry must include summary, why, and files. Include risks, followups, and lessons when present. Do not use Markdown fences or prose outside the JSON object." }
    skills: [trace, test, fix, library-first-development]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash, edit, write]
    filesystem: { mode: workspace-write, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
    output:
      format: json_schema
      schema_path: .pipeline/schemas/implementation.schema.json
      repair: { enabled: true, max_attempts: 1 }
  pipeline-acceptance-reviewer:
    runner: opencode
    scheduling_roles: [coverage]
    description: Audit the finished change against every acceptance criterion.
    instructions: { inline: 'Audit the completed change against each canonical acceptance criterion independently. Return only valid JSON with top-level "verdict", "evidence", "acceptance", and optional "violations". Each "acceptance" entry must include "id", "verdict", and non-empty "evidence". Do not use Markdown fences or prose outside the JSON object.' }
    skills: [critique, doubt]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
    output:
      format: json_schema
      schema_path: .pipeline/schemas/acceptance.schema.json
      repair: { enabled: true, max_attempts: 1 }
  pipeline-thermo-nuclear-reviewer:
    runner: opencode
    scheduling_roles: [coverage]
    description: Perform the final thermo-nuclear code quality review of the integration branch.
    instructions: { inline: "Perform the final code quality review of the integration branch." }
    skills: [critique]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
    output:
      format: json_schema
      schema_path: .pipeline/schemas/review.schema.json
      repair: { enabled: true, max_attempts: 1 }
  pipeline-verifier:
    runner: opencode
    scheduling_roles: [coverage]
    description: Verify checks, implementation fit, and final evidence.
    instructions: { inline: 'Verify checks, implementation fit, and final evidence. Return only valid JSON with top-level "verdict", "evidence", and optional "violations". Do not use Markdown fences or prose outside the JSON object.' }
    skills: [verify, critique, secure, optimize]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
    output:
      format: json_schema
      schema_path: .pipeline/schemas/verify.schema.json
      repair: { enabled: true, max_attempts: 1 }
  pipeline-learner:
    runner: opencode
    description: Store durable lessons from the completed run.
    instructions: { inline: "Store durable lessons from the completed run when useful." }
    skills: [migrate]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
    output:
      format: json_schema
      schema_path: .pipeline/schemas/learn.schema.json
      repair: { enabled: true, max_attempts: 1 }
`;

const PACKAGE_DEFAULT_PIPELINE_YAML = `version: 1
default_workflow: inspect
entrypoints:
  quick:
    schedule: quick-schedule
    description: Compact planner-generated pipeline for small work
  execute:
    schedule: execute-schedule
    description: Full planner-generated pipeline for repository work
  inspect:
    workflow: inspect
    description: Read-only repository inspection
orchestrator:
  profile: orchestrator
hooks:
  functions:
    generated-defaults-audit:
      kind: command
      command: [node, -e, "const fs=require('node:fs'); fs.writeFileSync(process.env.PIPELINE_HOOK_RESULT, JSON.stringify({status:'pass',summary:'Generated defaults audit passed'}));"]
      trusted: true
      timeout_ms: 5000
      output_limit_bytes: 4096
  on:
    workflow.start:
      - id: generated-defaults-audit
        function: generated-defaults-audit
        failure: fail
scheduler:
  commands:
    quick:
      schedule: quick-schedule
      catalog: quick
    execute:
      schedule: execute-schedule
      catalog: execute
  node_catalogs:
    quick:
      required_categories: [intake, red, green, mechanical, verification]
      nodes:
        backlog-intake:
          category: intake
          profile: pipeline-researcher
          models: [zai-coding-plan/glm-5-turbo, openai/gpt-5.5-fast]
        red-tests:
          category: red
          profile: pipeline-test-writer
          models: [openai/gpt-5.5, zai-coding-plan/glm-5.1, kimi-for-coding/kimi-k2-thinking]
        green-implementation:
          category: green
          profile: pipeline-code-writer
          models: [opencode-go/qwen3.7-max, kimi-for-coding/k2p6, opencode-go/deepseek-v4-pro]
        verification:
          category: verification
          profile: pipeline-verifier
          models: [openai/gpt-5.5, zai-coding-plan/glm-5.1]
    execute:
      required_categories: [intake, research, red, green, mechanical, acceptance, verification, learn]
      nodes:
        backlog-intake:
          category: intake
          profile: pipeline-researcher
          models: [zai-coding-plan/glm-5-turbo, openai/gpt-5.5-fast]
        research:
          category: research
          profile: pipeline-researcher
          models: [openai/gpt-5.5-fast, zai-coding-plan/glm-5.1, kimi-for-coding/k2p6]
        red-tests:
          category: red
          profile: pipeline-test-writer
          models: [openai/gpt-5.5, zai-coding-plan/glm-5.1, kimi-for-coding/kimi-k2-thinking]
        green-backend:
          category: green
          profile: pipeline-code-writer
          models: [opencode-go/qwen3.7-max, kimi-for-coding/k2p6, opencode-go/deepseek-v4-pro]
        green-frontend:
          category: green
          profile: pipeline-code-writer
          models: [opencode-go/qwen3.7-max, kimi-for-coding/k2p6, opencode-go/deepseek-v4-pro]
        acceptance-review:
          category: acceptance
          profile: pipeline-acceptance-reviewer
          models: [openai/gpt-5.5, zai-coding-plan/glm-5.1]
        verification:
          category: verification
          profile: pipeline-verifier
          models: [openai/gpt-5.5, zai-coding-plan/glm-5.1]
        learn:
          category: learn
          profile: pipeline-learner
          models: [zai-coding-plan/glm-5-turbo, openai/gpt-5.5-fast]
schedules:
  quick-schedule:
    baseline: quick
    planner_profile: pipeline-schedule-planner
    node_catalog: quick
  execute-schedule:
    baseline: execute
    planner_profile: pipeline-schedule-planner
    node_catalog: execute
workflows:
  inspect:
    description: Read-only repository inspection workflow.
    nodes:
      - id: inspect
        kind: agent
        profile: pipeline-inspector
`;

const DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST_URL = new URL(
  `../${OPENCODE_ECOSYSTEM_MANIFEST_PATH}`,
  import.meta.url
);
const PACKAGE_ASSET_ROOT = new URL("..", import.meta.url);

const ecosystemStringArraySchema = z.array(z.string().min(1));

const ecosystemRuntimeSchema = z
  .object({
    compatibility_runners: ecosystemStringArraySchema,
    default_runner: z.literal("opencode"),
    default_stack_direct: z.literal(true),
    state_authority: z.literal("pipeline"),
  })
  .strict();

const ecosystemDependencySchema = z
  .object({
    dependency_scope: z.string().min(1),
    id: z.string().min(1),
    package: z.string().min(1),
    role: z.string().min(1),
    source: z.string().url(),
  })
  .strict();

const ecosystemCodeSchema = z
  .object({
    default_stack: z.literal(true),
    id: z.string().min(1),
    name: z.string().min(1),
    package: z.string().min(1).optional(),
    plugin: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("local"),
            source_path: z.string().min(1),
            target_path: z.string().min(1),
          })
          .strict(),
        z
          .object({
            kind: z.literal("npm"),
            package: z.string().min(1),
          })
          .strict(),
      ])
      .optional(),
    role: z.string().min(1),
    source: z.string().url(),
  })
  .strict();

const ecosystemMcpBackendSchema = z
  .object({
    credentials: ecosystemStringArraySchema,
    id: z.string().min(1),
    locality: z.string().min(1),
    name: z.string().min(1).optional(),
    required: z.boolean(),
    role: z.string().min(1),
  })
  .strict();

const ecosystemProfileResourceSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    used_by: ecosystemStringArraySchema,
  })
  .strict();

const ecosystemHostCapabilitiesSchema = z
  .object({
    agents: z.literal(true),
    commands: z.literal(true),
    lsp: z.literal(true),
    mcp_servers: z.literal(true),
    permissions: z.literal(true),
    plugins: z.literal(true),
    project_config: z.literal(true),
    skills: z.literal(true),
    subagents: z.literal(true),
  })
  .strict();

const ecosystemSourceSchema = z
  .object({
    label: z.string().min(1),
    url: z.string().url(),
  })
  .strict();

const openCodeEcosystemManifestSchema = z
  .object({
    ecosystem_code: z.array(ecosystemCodeSchema).min(1),
    generated_by: z.literal("@oisincoveney/pipeline"),
    host_capabilities: ecosystemHostCapabilitiesSchema,
    mcp_backends: z.array(ecosystemMcpBackendSchema).min(1),
    official_dependencies: z.array(ecosystemDependencySchema).min(1),
    prompts: z.array(ecosystemProfileResourceSchema).min(1),
    runtime: ecosystemRuntimeSchema,
    skills: z.array(ecosystemProfileResourceSchema).min(1),
    sources: z.array(ecosystemSourceSchema).min(1),
    version: z.literal(1),
  })
  .strict();

export type OpenCodeEcosystemManifest = z.infer<
  typeof openCodeEcosystemManifestSchema
>;

export function parseOpenCodeEcosystemManifest(
  source: string,
  sourcePath = OPENCODE_ECOSYSTEM_MANIFEST_PATH
): OpenCodeEcosystemManifest {
  return parseYamlAs(source, sourcePath, openCodeEcosystemManifestSchema);
}

function loadDefaultOpenCodeEcosystemManifest(): OpenCodeEcosystemManifest {
  return parseOpenCodeEcosystemManifest(
    readFileSync(DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST_URL, "utf8")
  );
}

export const DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST =
  loadDefaultOpenCodeEcosystemManifest();

export type PipelineConfigErrorCode =
  | "PIPELINE_CONFIG_LEGACY_UNSUPPORTED"
  | "PIPELINE_CONFIG_PARSE_ERROR"
  | "PIPELINE_CONFIG_VALIDATION_ERROR";

export interface PipelineConfigIssue {
  message: string;
  path?: string;
}

export class PipelineConfigError extends Error {
  code: PipelineConfigErrorCode;
  issues: PipelineConfigIssue[];

  constructor(
    code: PipelineConfigErrorCode,
    message: string,
    issues: PipelineConfigIssue[] = []
  ) {
    super(message);
    this.name = "PipelineConfigError";
    this.code = code;
    this.issues = issues;
  }
}

const strictRecord = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.record(z.string(), valueSchema);

const runnerCapabilitiesSchema = z
  .object({
    filesystem: z.array(z.enum(FILESYSTEM_MODES)).optional(),
    mcp_servers: z.boolean().optional(),
    native_subagents: z.boolean().optional(),
    network: z.array(z.enum(NETWORK_MODES)).optional(),
    output_formats: z.array(z.enum(OUTPUT_FORMATS)).optional(),
    rules: z.boolean().optional(),
    skills: z.boolean().optional(),
    tools: z.array(z.enum(TOOL_NAMES)).optional(),
  })
  .strict();

const runnerSchema = z
  .object({
    args: z.array(z.string()).optional(),
    capabilities: runnerCapabilitiesSchema,
    command: z.string().optional(),
    host_models: z.record(z.string(), z.string().min(1)).optional(),
    model: z.string().optional(),
    type: z.enum(RUNNER_TYPES),
  })
  .strict();

const pathRefSchema = z
  .object({
    path: z.string().min(1),
    source_root: z.enum(["package", "project"]).default("project"),
  })
  .strict();

const mcpServerSchema = z
  .object({
    args: z.array(z.string()).optional(),
    bearer_token_env_var: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    url: z
      .string()
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        {
          message: "MCP server url must use http or https",
        }
      )
      .optional(),
  })
  .strict()
  .superRefine((server, ctx) => {
    const hasCommand = Boolean(server.command);
    const hasUrl = Boolean(server.url);
    if (hasCommand === hasUrl) {
      ctx.addIssue({
        code: "custom",
        message: "MCP server must declare exactly one of command or url",
        path: hasCommand ? ["url"] : ["command"],
      });
    }
    if (hasUrl && server.args) {
      ctx.addIssue({
        code: "custom",
        message: "args are only valid for command MCP servers",
        path: ["args"],
      });
    }
    if (hasUrl && server.env) {
      ctx.addIssue({
        code: "custom",
        message: "env is only valid for command MCP servers",
        path: ["env"],
      });
    }
    if (hasCommand && server.headers) {
      ctx.addIssue({
        code: "custom",
        message: "headers are only valid for url MCP servers",
        path: ["headers"],
      });
    }
    if (hasCommand && server.bearer_token_env_var) {
      ctx.addIssue({
        code: "custom",
        message: "bearer_token_env_var is only valid for url MCP servers",
        path: ["bearer_token_env_var"],
      });
    }
    if (
      hasUrl &&
      server.bearer_token_env_var &&
      Object.keys(server.headers ?? {}).some(
        (key) => key.toLowerCase() === "authorization"
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "headers.Authorization cannot be combined with bearer_token_env_var",
        path: ["bearer_token_env_var"],
      });
    }
  });

const mcpGatewayBackendSchema = z
  .object({
    locality: z.enum(MCP_GATEWAY_BACKEND_LOCALITIES),
    required: z.boolean().default(true),
    tool_prefixes: z.array(z.string().min(1)).min(1),
    workspace_path_source: z
      .enum(MCP_GATEWAY_WORKSPACE_PATH_SOURCES)
      .optional(),
  })
  .strict()
  .superRefine((backend, ctx) => {
    if (backend.locality === "repo-local") {
      if (!backend.workspace_path_source) {
        ctx.addIssue({
          code: "custom",
          message:
            "repo-local gateway backend must declare workspace_path_source as PIPELINE_TARGET_PATH or cwd",
          path: ["workspace_path_source"],
        });
      }
      return;
    }
    if (backend.workspace_path_source) {
      ctx.addIssue({
        code: "custom",
        message:
          "workspace_path_source is only valid for repo-local gateway backends",
        path: ["workspace_path_source"],
      });
    }
  });

const mcpGatewaySchema = z
  .object({
    backends: strictRecord(mcpGatewayBackendSchema).default({}),
    default_profile: z.string().min(1).optional(),
    mode: z.enum(["hosted", "local"]),
    provider: z.literal("toolhive"),
    authorization_env: z
      .string()
      .min(1)
      .default("PIPELINE_MCP_GATEWAY_AUTHORIZATION"),
    url: z
      .string()
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        {
          message: "MCP gateway url must use http or https",
        }
      )
      .optional(),
    url_env: z.string().min(1).default("PIPELINE_MCP_GATEWAY_URL"),
  })
  .strict();

const instructionsSchema = z
  .object({
    inline: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .strict();

const filesystemSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    mode: z.enum(FILESYSTEM_MODES),
  })
  .strict();

const networkSchema = z
  .object({
    mode: z.enum(NETWORK_MODES),
  })
  .strict();

const outputRepairSchema = z
  .object({
    enabled: z.boolean().optional(),
    max_attempts: z.number().int().positive().optional(),
    runner: z.string().optional(),
  })
  .strict();

const outputSchema = z
  .object({
    format: z.enum(OUTPUT_FORMATS),
    repair: outputRepairSchema.optional(),
    schema_path: z.string().min(1).optional(),
  })
  .strict();

const artifactSchema = z
  .object({
    path: z.string().min(1),
    required: z.boolean().optional(),
  })
  .strict();

const modelFallbacksSchema = z.array(z.string().min(1)).min(1);

const changedFilesPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    include_untracked: z.boolean().optional(),
    require_any: z.array(z.string()).optional(),
  })
  .strict();

const gateBaseSchema = z.object({
  id: z.string().optional(),
  required: z.boolean().optional(),
});

const jsonSourceGateSchema = gateBaseSchema.extend({
  path: z.string().min(1).optional(),
  target: z.enum(["artifact", "stdout"]).optional(),
});

const gateSchema = z.discriminatedUnion("kind", [
  jsonSourceGateSchema
    .extend({
      acceptance_key: z.string().optional(),
      kind: z.literal("acceptance"),
    })
    .strict(),
  gateBaseSchema
    .extend({
      kind: z.literal("artifact"),
      path: z.string().min(1),
    })
    .strict(),
  gateBaseSchema
    .extend({
      builtin: z.enum(BUILTIN_GATES),
      kind: z.literal("builtin"),
    })
    .strict(),
  gateBaseSchema
    .extend({
      changed_files: changedFilesPolicySchema,
      kind: z.literal("changed_files"),
    })
    .strict(),
  gateBaseSchema
    .extend({
      command: z.array(z.string()),
      expect_exit_code: z.number().int().optional(),
      kind: z.literal("command"),
      timeout_ms: z.number().int().positive().optional(),
    })
    .strict(),
  jsonSourceGateSchema
    .extend({
      kind: z.literal("json_schema"),
      schema_path: z.string().min(1),
    })
    .strict(),
  jsonSourceGateSchema
    .extend({
      equals: z.string().optional(),
      field: z.string().optional(),
      kind: z.literal("verdict"),
    })
    .strict(),
]);

const retriesSchema = z
  .object({
    backoff_ms: z.number().int().nonnegative().optional(),
    max_attempts: z.number().int().positive(),
    multiplier: z.number().positive().optional(),
    retry_on: z.array(z.enum(RETRY_REASONS)).optional(),
  })
  .strict();

const workflowExecutionSchema = z
  .object({
    fail_fast: z.boolean().optional(),
    max_parallel_nodes: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const profileSchema = z
  .object({
    description: z.string().optional(),
    filesystem: filesystemSchema.optional(),
    host_models: z.record(z.string(), z.string().min(1)).optional(),
    instructions: instructionsSchema,
    mcp_servers: z.array(z.string()).optional(),
    model: z.string().optional(),
    network: networkSchema.optional(),
    output: outputSchema.optional(),
    rules: z.array(z.string()).optional(),
    runner: z.string(),
    scheduling_roles: z.array(z.enum(SCHEDULING_ROLES)).optional(),
    skills: z.array(z.string()).optional(),
    timeout_ms: z.number().int().positive().optional(),
    tools: z.array(z.enum(TOOL_NAMES)).optional(),
  })
  .strict();

const orchestratorSchema = z
  .object({
    profile: z.string(),
  })
  .strict();

const hookEnvSchema = z
  .object({
    passthrough: z.array(z.string()).optional(),
    set: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const hookPermissionsSchema = z
  .object({
    filesystem: z.enum(FILESYSTEM_MODES).optional(),
    network: z.enum(NETWORK_MODES).optional(),
  })
  .strict();

const hookReturnsSchema = z
  .object({
    schema: z.string().min(1).optional(),
  })
  .strict();

const moduleHookFunctionSchema = z
  .object({
    kind: z.literal("module"),
    module: z.string().min(1),
    permissions: hookPermissionsSchema.optional(),
    returns: hookReturnsSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const commandHookProtocolSchema = z
  .object({
    input: z.literal("file"),
    result: z.literal("file"),
  })
  .strict();

const commandHookFunctionSchema = z
  .object({
    command: z.array(z.string()).min(1),
    env: hookEnvSchema.optional(),
    kind: z.literal("command"),
    output_limit_bytes: z.number().int().positive().optional(),
    protocol: commandHookProtocolSchema.default({
      input: "file",
      result: "file",
    }),
    returns: hookReturnsSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
    trusted: z.boolean().optional(),
  })
  .strict();

const hookFunctionSchema = z.discriminatedUnion("kind", [
  moduleHookFunctionSchema,
  commandHookFunctionSchema,
]);

const hookBindingWhereSchema = z
  .object({
    gate: z.string().optional(),
    node: z.string().optional(),
    workflow: z.string().optional(),
  })
  .strict();

const hookBindingResultSchema = z
  .object({
    pass_to: z.enum(["downstream"]).optional(),
    publish: z.boolean().optional(),
    save_as: z.string().min(1).optional(),
  })
  .strict();

const hookBindingSchema = z
  .object({
    failure: z.enum(["fail", "ignore"]).default("ignore"),
    function: z.string().min(1),
    id: z.string().min(1),
    result: hookBindingResultSchema.optional(),
    where: hookBindingWhereSchema.optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const hookPolicySchema = z
  .object({
    commands: z.enum(["allow", "trusted-only", "deny"]).optional(),
    modules: z.enum(["allow", "deny"]).optional(),
  })
  .strict();

const hooksConfigSchema = z
  .object({
    functions: strictRecord(hookFunctionSchema).default({}),
    on: strictRecord(z.array(hookBindingSchema)).default({}),
    policy: hookPolicySchema.optional(),
  })
  .strict();

const taskContextResolverSchema = z
  .object({
    type: z.string().min(1),
  })
  .passthrough();

const nodeTaskContextSchema = z
  .object({
    acceptance_criteria: z
      .array(
        z
          .object({
            id: z.string().min(1),
            text: z.string().min(1),
          })
          .strict()
      )
      .optional(),
    description: z.string().optional(),
    id: z.string().min(1).optional(),
    title: z.string().optional(),
  })
  .strict();

const entrypointBaseSchema = z.object({
  description: z.string().optional(),
  task_context: taskContextResolverSchema.optional(),
});

const entrypointSchema = z.union([
  entrypointBaseSchema
    .extend({
      workflow: z.string(),
    })
    .strict(),
  entrypointBaseSchema
    .extend({
      schedule: z.string(),
    })
    .strict(),
]);

const schedulePolicySchema = z
  .object({
    description: z.string().optional(),
    baseline: z.enum(SCHEDULE_BASELINES),
    max_parallel_nodes: z.number().int().positive().optional(),
    node_catalog: z.string().min(1).optional(),
    planner_profile: z.string().optional(),
    strategy: z.enum(SCHEDULE_STRATEGIES).default("planner"),
  })
  .strict();

const schedulerCommandSchema = z
  .object({
    catalog: z.string().min(1),
    schedule: z.string().min(1),
  })
  .strict();

const schedulerNodeTemplateSchema = z
  .object({
    category: z.string().min(1),
    description: z.string().optional(),
    gates: z.array(gateSchema).optional(),
    models: modelFallbacksSchema,
    profile: z.string().min(1),
  })
  .strict();

const schedulerNodeCatalogSchema = z
  .object({
    nodes: strictRecord(schedulerNodeTemplateSchema).default({}),
    required_categories: z.array(z.string().min(1)).default([]),
  })
  .strict();

const schedulerConfigSchema = z
  .object({
    commands: strictRecord(schedulerCommandSchema).default({}),
    node_catalogs: strictRecord(schedulerNodeCatalogSchema).default({}),
  })
  .strict();

const workflowNodeBaseSchema = z.object({
  artifacts: z.array(artifactSchema).optional(),
  gates: z.array(gateSchema).optional(),
  id: z.string(),
  models: modelFallbacksSchema.optional(),
  needs: z.array(z.string()).optional(),
  retries: retriesSchema.optional(),
  task_context: nodeTaskContextSchema.optional(),
  timeout_ms: z.number().int().positive().optional(),
});

type WorkflowNodeBase = z.infer<typeof workflowNodeBaseSchema>;
type AgentWorkflowNode = WorkflowNodeBase & {
  kind: "agent";
  profile: string;
};
type CommandWorkflowNode = WorkflowNodeBase & {
  command: string[];
  kind: "command";
};
type BuiltinWorkflowNode = WorkflowNodeBase & {
  builtin: string;
  kind: "builtin";
};
type GroupWorkflowNode = WorkflowNodeBase & {
  kind: "group";
  nodes: string[];
};
type ParallelWorkflowNode = WorkflowNodeBase & {
  kind: "parallel";
  nodes: WorkflowNode[];
};
type ChildWorkflowNode = WorkflowNodeBase & {
  kind: "workflow";
  workflow: string;
  worktree_root?: string;
};
type WorkflowNode =
  | AgentWorkflowNode
  | CommandWorkflowNode
  | BuiltinWorkflowNode
  | GroupWorkflowNode
  | ParallelWorkflowNode
  | ChildWorkflowNode;

const workflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    workflowNodeBaseSchema
      .extend({
        kind: z.literal("agent"),
        profile: z.string(),
      })
      .strict(),
    workflowNodeBaseSchema
      .extend({
        command: z.array(z.string()),
        kind: z.literal("command"),
      })
      .strict(),
    workflowNodeBaseSchema
      .extend({
        builtin: z.string(),
        kind: z.literal("builtin"),
      })
      .strict(),
    workflowNodeBaseSchema
      .extend({
        kind: z.literal("group"),
        nodes: z.array(z.string()).min(1),
      })
      .strict(),
    workflowNodeBaseSchema
      .extend({
        kind: z.literal("parallel"),
        nodes: z.array(workflowNodeSchema).min(1),
      })
      .strict(),
    workflowNodeBaseSchema
      .extend({
        kind: z.literal("workflow"),
        workflow: z.string(),
        worktree_root: z.string().optional(),
      })
      .strict(),
  ])
);

export const workflowSchema = z
  .object({
    description: z.string().optional(),
    execution: workflowExecutionSchema.optional(),
    nodes: z.array(workflowNodeSchema),
  })
  .strict();

const runnerJobCommandSchema = z
  .object({
    args: z.array(z.string()).default([]),
    command: z.string().min(1),
    required: z.boolean().default(true),
  })
  .strict();

const runnerJobEnvironmentSchema = z
  .object({
    setup: z.array(runnerJobCommandSchema).default([]),
    smoke: z.array(runnerJobCommandSchema).default([]),
  })
  .strict();

const runnerJobGitCommitterSchema = z
  .object({
    email: z.string().email().default(DEFAULT_RUNNER_JOB_GIT_COMMITTER.email),
    name: z.string().min(1).default(DEFAULT_RUNNER_JOB_GIT_COMMITTER.name),
  })
  .strict();

const runnerJobGitSchema = z
  .object({
    committer: runnerJobGitCommitterSchema.default(
      DEFAULT_RUNNER_JOB_GIT_COMMITTER
    ),
  })
  .strict();

const runnerJobConfigSchema = z
  .object({
    environment: runnerJobEnvironmentSchema.default({ setup: [], smoke: [] }),
    git: runnerJobGitSchema.default({
      committer: DEFAULT_RUNNER_JOB_GIT_COMMITTER,
    }),
  })
  .strict();

const runnersFileSchema = z
  .object({
    runners: strictRecord(runnerSchema).default({}),
    version: z.literal(1),
  })
  .strict();

const profilesFileSchema = z
  .object({
    mcp_gateway: mcpGatewaySchema.optional(),
    mcp_servers: strictRecord(z.never()).default({}),
    profiles: strictRecord(profileSchema).default({}),
    rules: strictRecord(pathRefSchema).default({}),
    skills: strictRecord(pathRefSchema).default({}),
    version: z.literal(1),
  })
  .strict();

const pipelineFileSchema = z
  .object({
    default_workflow: z.string(),
    entrypoints: strictRecord(entrypointSchema).default({}),
    hooks: hooksConfigSchema.default({ functions: {}, on: {} }),
    orchestrator: orchestratorSchema,
    runner_job: runnerJobConfigSchema.default({
      environment: { setup: [], smoke: [] },
      git: { committer: DEFAULT_RUNNER_JOB_GIT_COMMITTER },
    }),
    scheduler: schedulerConfigSchema.default({
      commands: {},
      node_catalogs: {},
    }),
    schedules: strictRecord(schedulePolicySchema).default({}),
    task_context: taskContextResolverSchema.optional(),
    workflows: strictRecord(workflowSchema).default({}),
    version: z.literal(1),
  })
  .strict();

const configSchemaBase = z
  .object({
    default_workflow: z.string(),
    entrypoints: strictRecord(entrypointSchema).default({}),
    hooks: hooksConfigSchema.default({ functions: {}, on: {} }),
    mcp_gateway: mcpGatewaySchema.optional(),
    mcp_servers: strictRecord(mcpServerSchema).default({}),
    orchestrator: orchestratorSchema,
    profiles: strictRecord(profileSchema).default({}),
    runner_job: runnerJobConfigSchema.default({
      environment: { setup: [], smoke: [] },
      git: { committer: DEFAULT_RUNNER_JOB_GIT_COMMITTER },
    }),
    rules: strictRecord(pathRefSchema).default({}),
    runners: strictRecord(runnerSchema).default({}),
    scheduler: schedulerConfigSchema.default({
      commands: {},
      node_catalogs: {},
    }),
    schedules: strictRecord(schedulePolicySchema).default({}),
    skills: strictRecord(pathRefSchema).default({}),
    task_context: taskContextResolverSchema.optional(),
    version: z.literal(1),
    workflows: strictRecord(workflowSchema).default({}),
  })
  .strict();

const configSchema = configSchemaBase.superRefine(validateConfigReferences);

type ConfigSchemaInput = z.infer<typeof configSchemaBase>;
interface ConfigReferenceIssue {
  message: string;
  path: (number | string)[];
}
interface RegistryReferenceRule<TRecord> {
  field: string;
  message: (recordId: string, value: string) => string;
  read: (record: TRecord) => string | undefined;
  registry: Record<string, unknown>;
}

function validateConfigReferences(
  config: ConfigSchemaInput,
  ctx: z.RefinementCtx
): void {
  addConfigSchemaIssues(ctx, configReferenceIssues(config));
}

function configReferenceIssues(
  config: ConfigSchemaInput
): ConfigReferenceIssue[] {
  return [
    ...missingRegistryReferenceIssue({
      message: (_field, value) => `default workflow '${value}' is not declared`,
      path: ["default_workflow"],
      registry: config.workflows,
      value: config.default_workflow,
    }),
    ...registryReferenceIssues("entrypoints", config.entrypoints, [
      {
        field: "workflow",
        message: (entrypointId, value) =>
          `entrypoint '${entrypointId}' references missing workflow '${value}'`,
        read: (entrypoint) =>
          "workflow" in entrypoint ? entrypoint.workflow : undefined,
        registry: config.workflows,
      },
      {
        field: "schedule",
        message: (entrypointId, value) =>
          `entrypoint '${entrypointId}' references missing schedule '${value}'`,
        read: (entrypoint) =>
          "schedule" in entrypoint ? entrypoint.schedule : undefined,
        registry: config.schedules,
      },
    ]),
    ...registryReferenceIssues("schedules", config.schedules, [
      {
        field: "planner_profile",
        message: (scheduleId, value) =>
          `schedule '${scheduleId}' references missing planner profile '${value}'`,
        read: (schedule) => schedule.planner_profile,
        registry: config.profiles,
      },
      {
        field: "node_catalog",
        message: (scheduleId, value) =>
          `schedule '${scheduleId}' references missing scheduler node catalog '${value}'`,
        read: (schedule) => schedule.node_catalog,
        registry: config.scheduler.node_catalogs,
      },
    ]),
    ...registryReferenceIssues(
      "scheduler.commands",
      config.scheduler.commands,
      [
        {
          field: "catalog",
          message: (commandId, value) =>
            `scheduler command '${commandId}' references missing node catalog '${value}'`,
          read: (command) => command.catalog,
          registry: config.scheduler.node_catalogs,
        },
        {
          field: "schedule",
          message: (commandId, value) =>
            `scheduler command '${commandId}' references missing schedule '${value}'`,
          read: (command) => command.schedule,
          registry: config.schedules,
        },
      ]
    ),
    ...Object.entries(config.scheduler.node_catalogs).flatMap(
      ([catalogId, catalog]) =>
        registryReferenceIssues(
          `scheduler.node_catalogs.${catalogId}.nodes`,
          catalog.nodes,
          [
            {
              field: "profile",
              message: (nodeId, value) =>
                `scheduler node '${catalogId}.${nodeId}' references missing profile '${value}'`,
              read: (node) => node.profile,
              registry: config.profiles,
            },
          ]
        )
    ),
  ];
}

function registryReferenceIssues<TRecord>(
  registryPath: string,
  records: Record<string, TRecord>,
  rules: RegistryReferenceRule<TRecord>[]
): ConfigReferenceIssue[] {
  return Object.entries(records).flatMap(([recordId, record]) =>
    rules.flatMap((rule) =>
      missingRegistryReferenceIssue({
        message: (_field, value) => rule.message(recordId, value),
        path: [registryPath, recordId, rule.field],
        registry: rule.registry,
        value: rule.read(record),
      })
    )
  );
}

function missingRegistryReferenceIssue({
  message,
  path,
  registry,
  value,
}: {
  message: (field: string, value: string) => string;
  path: (number | string)[];
  registry: Record<string, unknown>;
  value: string | undefined;
}): ConfigReferenceIssue[] {
  return value && !Object.hasOwn(registry, value)
    ? [{ message: message(String(path.at(-1)), value), path }]
    : [];
}

function addConfigSchemaIssues(
  ctx: z.RefinementCtx,
  issues: ConfigReferenceIssue[]
): void {
  for (const issue of issues) {
    addConfigSchemaIssue(ctx, issue.path, issue.message);
  }
}

function addConfigSchemaIssue(
  ctx: z.RefinementCtx,
  path: (number | string)[],
  message: string
): void {
  ctx.addIssue({ code: "custom", path, message });
}

export type PipelineConfig = z.infer<typeof configSchema>;
export type RunnerType = (typeof RUNNER_TYPES)[number];
export type WorkflowNodeKind = (typeof NODE_KINDS)[number];
export type HookEvent = (typeof HOOK_EVENTS)[number];
export type GateKind = (typeof GATE_KINDS)[number];
export type ScheduleBaseline = (typeof SCHEDULE_BASELINES)[number];
export type SchedulingRole = (typeof SCHEDULING_ROLES)[number];
export type McpGatewayBackendLocality =
  (typeof MCP_GATEWAY_BACKEND_LOCALITIES)[number];
export type McpGatewayWorkspacePathSource =
  (typeof MCP_GATEWAY_WORKSPACE_PATH_SOURCES)[number];
type ConfigGateSpec = NonNullable<
  PipelineConfig["workflows"][string]["nodes"][number]["gates"]
>[number];

export interface PipelineConfigParts {
  pipeline: string;
  profiles: string;
  runners: string;
}

export interface PipelineConfigValidationOptions {
  allowMissingLintFileReferences?: boolean;
}

export function loadPipelineConfig(
  projectRoot: string,
  options: PipelineConfigValidationOptions = {}
): PipelineConfig {
  return loadPackagePipelineConfig(projectRoot, options);
}

export function loadPackagePipelineConfig(
  projectRoot: string,
  options: PipelineConfigValidationOptions = {}
): PipelineConfig {
  return parsePipelineConfigParts(
    {
      pipeline: PACKAGE_DEFAULT_PIPELINE_YAML,
      profiles: PACKAGE_DEFAULT_PROFILES_YAML,
      runners: PACKAGE_DEFAULT_RUNNERS_YAML,
    },
    projectRoot,
    {
      pipeline: "@oisincoveney/pipeline/defaults/pipeline.yaml",
      profiles: "@oisincoveney/pipeline/defaults/profiles.yaml",
      runners: "@oisincoveney/pipeline/defaults/runners.yaml",
    },
    options
  );
}

export function parsePipelineConfigYaml(
  source: string,
  sourcePath = PIPELINE_CONFIG_PATH,
  projectRoot?: string
): PipelineConfig {
  return parsePipelineConfigParts(
    {
      pipeline: source,
      profiles: "version: 1\nprofiles: {}\n",
      runners: "version: 1\nrunners: {}\n",
    },
    projectRoot,
    {
      pipeline: sourcePath,
      profiles: PROFILES_CONFIG_PATH,
      runners: RUNNERS_CONFIG_PATH,
    }
  );
}

export function parsePipelineConfigParts(
  sources: PipelineConfigParts,
  projectRoot?: string,
  sourcePaths: PipelineConfigParts = {
    pipeline: PIPELINE_CONFIG_PATH,
    profiles: PROFILES_CONFIG_PATH,
    runners: RUNNERS_CONFIG_PATH,
  },
  options: PipelineConfigValidationOptions = {}
): PipelineConfig {
  const runners = parseYamlAs(
    sources.runners,
    sourcePaths.runners,
    runnersFileSchema
  );
  const profiles = parseYamlAs(
    sources.profiles,
    sourcePaths.profiles,
    profilesFileSchema
  );
  const pipeline = parseYamlAs(
    sources.pipeline,
    sourcePaths.pipeline,
    pipelineFileSchema
  );
  return validatePipelineConfig(
    {
      default_workflow: pipeline.default_workflow,
      entrypoints: pipeline.entrypoints,
      hooks: pipeline.hooks,
      ...(profiles.mcp_gateway ? { mcp_gateway: profiles.mcp_gateway } : {}),
      mcp_servers: profiles.mcp_servers,
      orchestrator: pipeline.orchestrator,
      profiles: profiles.profiles,
      runner_job: pipeline.runner_job,
      rules: profiles.rules,
      runners: runners.runners,
      scheduler: pipeline.scheduler,
      schedules: pipeline.schedules,
      skills: profiles.skills,
      ...(pipeline.task_context ? { task_context: pipeline.task_context } : {}),
      version: 1,
      workflows: pipeline.workflows,
    },
    projectRoot,
    options
  );
}

function parseYamlAs<T extends z.ZodTypeAny>(
  source: string,
  sourcePath: string,
  schema: T
): z.infer<T> {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new PipelineConfigError(
      "PIPELINE_CONFIG_PARSE_ERROR",
      `Failed to parse ${sourcePath}`,
      document.errors.map((err) => ({ message: err.message, path: sourcePath }))
    );
  }

  const parsed = schema.safeParse(document.toJS());
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }))
    );
  }
  return parsed.data;
}

export function validatePipelineConfig(
  rawConfig: PipelineConfig,
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): PipelineConfig {
  const parsed = configSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }))
    );
  }

  const config = parsed.data;
  const issues: PipelineConfigIssue[] = [];

  validateRegistryIds("runners", config.runners, issues);
  validateRegistryIds("profiles", config.profiles, issues);
  validateRegistryIds("rules", config.rules, issues);
  validateRegistryIds("skills", config.skills, issues);
  validateRegistryIds("mcp_servers", config.mcp_servers, issues);
  validateRegistryIds("hooks.functions", config.hooks.functions, issues);
  validateRegistryIds("workflows", config.workflows, issues);
  validateRegistryIds("entrypoints", config.entrypoints, issues);

  const orchestratorProfile = config.profiles[config.orchestrator.profile];
  if (!orchestratorProfile) {
    issues.push({
      path: "orchestrator.profile",
      message: `orchestrator references missing profile '${config.orchestrator.profile}'`,
    });
  }

  for (const [profileId, profile] of Object.entries(config.profiles)) {
    const runner = config.runners[profile.runner];
    if (!runner) {
      issues.push({
        path: `profiles.${profileId}.runner`,
        message: `profile '${profileId}' references missing runner '${profile.runner}'`,
      });
      continue;
    }
    validateProfile(
      profileId,
      profile,
      runner,
      config,
      issues,
      projectRoot,
      options
    );
  }

  validateHookConfig(config, issues, projectRoot, options);

  for (const [ruleId, rule] of Object.entries(config.rules)) {
    validatePath(`rules.${ruleId}.path`, rule, projectRoot, issues, options);
  }

  for (const [skillId, skill] of Object.entries(config.skills)) {
    validatePath(`skills.${skillId}.path`, skill, projectRoot, issues, options);
  }

  for (const [workflowId, workflow] of Object.entries(config.workflows)) {
    validateWorkflow(
      workflowId,
      workflow,
      config,
      issues,
      projectRoot,
      options
    );
  }

  if (issues.length > 0) {
    throw validationError(issues);
  }
  return config;
}

function validateRegistryIds(
  name: string,
  registry: Record<string, unknown>,
  issues: PipelineConfigIssue[]
): void {
  for (const id of Object.keys(registry)) {
    if (!ID_RE.test(id)) {
      issues.push({
        path: `${name}.${id}`,
        message: `registry id '${id}' must match ${ID_RE.source}`,
      });
    }
  }
}

function validateHookConfig(
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): void {
  const allowedEvents = new Set<string>(HOOK_EVENTS);
  for (const [functionId, hookFunction] of Object.entries(
    config.hooks.functions
  )) {
    validatePath(
      `hooks.functions.${functionId}.returns.schema`,
      { path: hookFunction.returns?.schema },
      projectRoot,
      issues,
      options
    );
  }
  for (const [event, bindings] of Object.entries(config.hooks.on)) {
    if (!allowedEvents.has(event)) {
      issues.push({
        path: `hooks.on.${event}`,
        message: `unsupported hook event '${event}'`,
      });
      continue;
    }
    for (const [index, binding] of bindings.entries()) {
      if (!ID_RE.test(binding.id)) {
        issues.push({
          path: `hooks.on.${event}.${index}.id`,
          message: `hook binding id '${binding.id}' must match ${ID_RE.source}`,
        });
      }
      if (!config.hooks.functions[binding.function]) {
        issues.push({
          path: `hooks.on.${event}.${index}.function`,
          message: `hook binding '${binding.id}' references missing function '${binding.function}'`,
        });
      }
    }
  }
}

function validateProfile(
  profileId: string,
  profile: PipelineConfig["profiles"][string],
  runner: PipelineConfig["runners"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): void {
  validateActor(
    `profile '${profileId}'`,
    `profiles.${profileId}`,
    profile,
    runner,
    config,
    issues,
    projectRoot,
    options
  );
  validateListCapability(
    `profiles.${profileId}.output.format`,
    profile.output?.format ? [profile.output.format] : undefined,
    runner.capabilities.output_formats,
    "output format",
    issues
  );

  if (profile.output?.format === "json_schema" && !profile.output.schema_path) {
    issues.push({
      path: `profiles.${profileId}.output.schema_path`,
      message: `profile '${profileId}' must declare output.schema_path for json_schema output`,
    });
  }
  const repairRunnerId = profile.output?.repair?.runner;
  if (repairRunnerId && !config.runners[repairRunnerId]) {
    issues.push({
      path: `profiles.${profileId}.output.repair.runner`,
      message: `profile '${profileId}' references missing repair runner '${repairRunnerId}'`,
    });
  }
  if (repairRunnerId && config.runners[repairRunnerId]) {
    validateListCapability(
      `profiles.${profileId}.output.repair.runner`,
      ["text"],
      config.runners[repairRunnerId].capabilities.output_formats,
      "repair output format",
      issues
    );
  }
  validatePath(
    `profiles.${profileId}.output.schema_path`,
    { path: profile.output?.schema_path },
    projectRoot,
    issues,
    options
  );
}

function validateActor(
  label: string,
  path: string,
  actor: PipelineConfig["profiles"][string],
  runner: PipelineConfig["runners"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): void {
  if (!(actor.instructions.path || actor.instructions.inline)) {
    issues.push({
      path: `${path}.instructions`,
      message: `${label} must declare instructions.path or instructions.inline`,
    });
  }
  validatePath(
    `${path}.instructions.path`,
    { path: actor.instructions.path },
    projectRoot,
    issues,
    options
  );

  validateReferences(
    `${path}.rules`,
    actor.rules,
    config.rules,
    "rule",
    issues
  );
  validateReferences(
    `${path}.skills`,
    actor.skills,
    config.skills,
    "skill",
    issues
  );
  validateReferences(
    `${path}.mcp_servers`,
    actor.mcp_servers,
    config.mcp_gateway
      ? { [PIPELINE_GATEWAY_SERVER_ID]: {} }
      : config.mcp_servers,
    "MCP server",
    issues
  );
  if (config.mcp_gateway) {
    for (const serverId of actor.mcp_servers ?? []) {
      if (serverId !== PIPELINE_GATEWAY_SERVER_ID) {
        issues.push({
          path: `${path}.mcp_servers`,
          message: `${path}.mcp_servers must only reference ${PIPELINE_GATEWAY_SERVER_ID} when mcp_gateway is configured`,
        });
      }
    }
  }

  validateBooleanCapability(
    `${path}.rules`,
    actor.rules,
    runner.capabilities.rules,
    "rules",
    issues
  );
  validateBooleanCapability(
    `${path}.skills`,
    actor.skills,
    runner.capabilities.skills,
    "skills",
    issues
  );
  validateBooleanCapability(
    `${path}.mcp_servers`,
    actor.mcp_servers,
    runner.capabilities.mcp_servers,
    "MCP servers",
    issues
  );
  validateListCapability(
    `${path}.tools`,
    actor.tools,
    runner.capabilities.tools,
    "tool",
    issues
  );
  validateListCapability(
    `${path}.filesystem.mode`,
    actor.filesystem?.mode ? [actor.filesystem.mode] : undefined,
    runner.capabilities.filesystem,
    "filesystem mode",
    issues
  );
  validateListCapability(
    `${path}.network.mode`,
    actor.network?.mode ? [actor.network.mode] : undefined,
    runner.capabilities.network,
    "network mode",
    issues
  );
}

function validateWorkflow(
  workflowId: string,
  workflow: PipelineConfig["workflows"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): void {
  const nodeIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        path: `workflows.${workflowId}.nodes.${node.id}`,
        message: `workflow '${workflowId}' declares duplicate node id '${node.id}'`,
      });
    }
    nodeIds.add(node.id);
  }

  for (const node of workflow.nodes) {
    validateWorkflowNode(workflowId, node, nodeIds, config, issues);
    validateNodeGates(workflowId, node, issues, projectRoot, options);
  }
}

function validateWorkflowNode(
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  nodeIds: Set<string>,
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void {
  if (!ID_RE.test(node.id)) {
    issues.push({
      path: `workflows.${workflowId}.nodes.${node.id}`,
      message: `workflow node id '${node.id}' must match ${ID_RE.source}`,
    });
  }
  for (const need of node.needs ?? []) {
    if (!nodeIds.has(need)) {
      issues.push({
        path: `workflows.${workflowId}.nodes.${node.id}.needs`,
        message: `node '${node.id}' references missing dependency '${need}'`,
      });
    }
  }
  validateWorkflowNodeKind(workflowId, node, config, issues);
  if (node.kind === "parallel") {
    validateParallelWorkflowNode(workflowId, node, config, issues);
  }
}

function validateWorkflowNodeKind(
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void {
  if (node.kind === "agent" && !config.profiles[node.profile]) {
    issues.push({
      path: `workflows.${workflowId}.nodes.${node.id}.profile`,
      message: `node '${node.id}' references missing profile '${node.profile}'`,
    });
  }
  if (node.kind === "workflow" && !config.workflows[node.workflow]) {
    issues.push({
      path: `workflows.${workflowId}.nodes.${node.id}.workflow`,
      message: `node '${node.id}' references missing workflow '${node.workflow}'`,
    });
  }
}

function validateParallelWorkflowNode(
  workflowId: string,
  node: Extract<
    PipelineConfig["workflows"][string]["nodes"][number],
    { kind: "parallel" }
  >,
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void {
  const childIds = new Set<string>();
  for (const child of node.nodes) {
    if (childIds.has(child.id)) {
      issues.push({
        path: `workflows.${workflowId}.nodes.${node.id}.nodes.${child.id}`,
        message: `parallel node '${node.id}' declares duplicate child node id '${child.id}'`,
      });
    }
    childIds.add(child.id);
  }
  for (const child of node.nodes) {
    validateWorkflowNode(workflowId, child, childIds, config, issues);
  }
}

function validateNodeGates(
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  issues: PipelineConfigIssue[],
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): void {
  for (const [index, gate] of (node.gates ?? []).entries()) {
    const path = `workflows.${workflowId}.nodes.${node.id}.gates.${index}`;
    validateGateRequiredFields(gate, path, node.id, issues);
    if (gate.kind === "json_schema") {
      validatePath(
        `${path}.schema_path`,
        { path: gate.schema_path },
        projectRoot,
        issues,
        options
      );
    }
  }
}

function validateGateRequiredFields(
  gate: ConfigGateSpec,
  path: string,
  nodeId: string,
  issues: PipelineConfigIssue[]
): void {
  const missing = gateMissingField(gate);
  if (!missing) {
    return;
  }
  issues.push({
    path: `${path}.${missing.field}`,
    message: missing.message(nodeId),
  });
}

function gateMissingField(gate: ConfigGateSpec): {
  field: string;
  message: (nodeId: string) => string;
} | null {
  if ("target" in gate && gate.target === "artifact" && !gate.path) {
    return {
      field: "path",
      message: (nodeId) =>
        `${gate.kind} artifact gate on node '${nodeId}' must declare path`,
    };
  }
  return null;
}

function validateReferences(
  path: string,
  refs: string[] | undefined,
  registry: Record<string, unknown>,
  label: string,
  issues: PipelineConfigIssue[]
): void {
  for (const ref of refs ?? []) {
    if (!registry[ref]) {
      issues.push({
        path,
        message: `references missing ${label} '${ref}'`,
      });
    }
  }
}

function validateBooleanCapability(
  path: string,
  refs: string[] | undefined,
  capability: boolean | undefined,
  label: string,
  issues: PipelineConfigIssue[]
): void {
  if ((refs?.length ?? 0) > 0 && capability !== true) {
    issues.push({
      path,
      message: `selected runner does not support ${label}`,
    });
  }
}

function validateListCapability(
  path: string,
  requested: string[] | undefined,
  supported: readonly string[] | undefined,
  label: string,
  issues: PipelineConfigIssue[]
): void {
  if (!requested || requested.length === 0) {
    return;
  }
  const allowed = new Set(supported ?? []);
  for (const item of requested) {
    if (!allowed.has(item)) {
      issues.push({
        path,
        message: `selected runner does not support ${label} '${item}'`,
      });
    }
  }
}

function validatePath(
  path: string,
  ref: { path?: string; source_root?: "package" | "project" },
  projectRoot: string | undefined,
  issues: PipelineConfigIssue[],
  options: PipelineConfigValidationOptions = {}
): void {
  const value = ref.path;
  if (!(value && projectRoot)) {
    return;
  }
  if (standardOutputSchemaNameFromPath(value)) {
    return;
  }
  if (!existsSync(resolvePathReference(projectRoot, ref))) {
    if (
      options.allowMissingLintFileReferences &&
      isLintableMissingFileReferencePath(path)
    ) {
      return;
    }
    issues.push({
      path,
      message: `referenced file '${value}' does not exist`,
    });
  }
}

function resolvePathReference(
  projectRoot: string,
  ref: { path?: string; source_root?: "package" | "project" }
): string {
  if (ref.source_root === "package") {
    return new URL(ref.path ?? "", PACKAGE_ASSET_ROOT).pathname;
  }
  return resolveFileReference(projectRoot, ref.path ?? "");
}

const SKILLS_REGEX = /^skills\.[^.]+\.path$/;
const PROFILES_INSTRUCTIONS_REGEX = /^profiles\.[^.]+\.instructions\.path$/;
const PROFILES_OUTPUT_REGEX = /^profiles\.[^.]+\.output\.schema_path$/;

function isLintableMissingFileReferencePath(path: string): boolean {
  return (
    SKILLS_REGEX.test(path) ||
    PROFILES_INSTRUCTIONS_REGEX.test(path) ||
    PROFILES_OUTPUT_REGEX.test(path)
  );
}

function validationError(issues: PipelineConfigIssue[]): PipelineConfigError {
  return new PipelineConfigError(
    "PIPELINE_CONFIG_VALIDATION_ERROR",
    [
      "Invalid pipeline config:",
      ...issues.map((issue) =>
        issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`
      ),
    ].join("\n"),
    issues
  );
}
