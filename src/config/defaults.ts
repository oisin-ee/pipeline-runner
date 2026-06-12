import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  configIssuesFromZodError,
  PipelineConfigError,
  validationError,
} from "./schemas";

export const PIPELINE_CONFIG_PATH = ".pipeline/pipeline.yaml";
export const RUNNERS_CONFIG_PATH = ".pipeline/runners.yaml";
export const PROFILES_CONFIG_PATH = ".pipeline/profiles.yaml";
export const OPENCODE_ECOSYSTEM_MANIFEST_PATH =
  "defaults/opencode-ecosystem.yaml";

export const PACKAGE_DEFAULT_RUNNERS_YAML = `version: 1
runners:
  opencode:
    type: opencode
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

export const PACKAGE_DEFAULT_PROFILES_YAML = `version: 1
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
  execute:
    path: .agents/skills/execute/SKILL.md
    source_root: package
  inspect:
    path: .agents/skills/inspect/SKILL.md
    source_root: package
  quick:
    path: .agents/skills/quick/SKILL.md
    source_root: package
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
    path: .agents/skills/schedule-graph-shaping/SKILL.md
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
  moka-orchestrator:
    runner: opencode
    description: Orchestrate the configured pipeline and enforce gates.
    instructions: { inline: "Orchestrate the configured pipeline through package-defined entrypoints, native agents, and gates. Do not bypass configured runner subprocesses or package-configured gates." }
    skills: [execute, quick, inspect]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
  moka-researcher:
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
  moka-inspector:
    runner: opencode
    model: openai/gpt-5.5-low
    description: Inspect the repository without modifying files.
    instructions: { inline: "Inspect the repository without modifying files." }
    skills: [research]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
  moka-schedule-planner:
    runner: opencode
    model: openai/gpt-5.5-xhigh
    description: Refine a baseline schedule into a specialized approved-plan artifact.
    instructions: { inline: "Generate exactly one workflow named root as an explicit schedule graph. Return YAML only." }
    timeout_ms: 300000
    skills: [schedule-graph-shaping]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only, allow: ["**/*"], deny: ["node_modules/**", "dist/**", ".git/**"] }
    network: { mode: inherit }
  moka-test-writer:
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
  moka-code-writer:
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
  moka-acceptance-reviewer:
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
  moka-thermo-nuclear-reviewer:
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
  moka-verifier:
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
  moka-learner:
    runner: opencode
    model: openai/gpt-5.5-low
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

export const PACKAGE_DEFAULT_PIPELINE_YAML = `version: 1
default_workflow: inspect
orchestrator:
  profile: moka-orchestrator
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
runner_command:
  environment:
    setup:
      - command: bun
        args: [install, --frozen-lockfile]
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
          profile: moka-researcher
          models: [openai/gpt-5.5-medium]
        red-tests:
          category: red
          profile: moka-test-writer
          models: [openai/gpt-5.5-high, kimi-for-coding/kimi-k2-thinking]
        green-implementation:
          category: green
          profile: moka-code-writer
          models: [openai/gpt-5.5-high, kimi-for-coding/k2p6, opencode-go/qwen3.7-max]
        verification:
          category: verification
          profile: moka-verifier
          models: [openai/gpt-5.5-medium]
    execute:
      required_categories: [intake, research, red, green, mechanical, acceptance, verification, learn]
      nodes:
        backlog-intake:
          category: intake
          profile: moka-researcher
          models: [openai/gpt-5.5-medium]
        research:
          category: research
          profile: moka-researcher
          models: [openai/gpt-5.5-medium, kimi-for-coding/k2p6]
        red-tests:
          category: red
          profile: moka-test-writer
          models: [openai/gpt-5.5-high, kimi-for-coding/kimi-k2-thinking]
        green-backend:
          category: green
          profile: moka-code-writer
          models: [openai/gpt-5.5-high, kimi-for-coding/k2p6, opencode-go/qwen3.7-max]
        green-frontend:
          category: green
          profile: moka-code-writer
          models: [openai/gpt-5.5-high, kimi-for-coding/k2p6, opencode-go/qwen3.7-max]
        acceptance-review:
          category: acceptance
          profile: moka-acceptance-reviewer
          models: [openai/gpt-5.5-medium]
        verification:
          category: verification
          profile: moka-verifier
          models: [openai/gpt-5.5-medium]
        learn:
          category: learn
          profile: moka-learner
          models: [openai/gpt-5.5-low]
schedules:
  quick-schedule:
    baseline: quick
    planner_profile: moka-schedule-planner
    node_catalog: quick
  execute-schedule:
    baseline: execute
    planner_profile: moka-schedule-planner
    node_catalog: execute
workflows:
  inspect:
    description: Read-only repository inspection workflow.
    nodes:
      - id: inspect
        kind: agent
        profile: moka-inspector
`;

const DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST_URL = new URL(
  `../../${OPENCODE_ECOSYSTEM_MANIFEST_PATH}`,
  import.meta.url
);

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

const ecosystemProviderModelOptionsSchema = z
  .object({
    include: ecosystemStringArraySchema,
    reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]),
    reasoningSummary: z.enum(["auto", "detailed"]),
    store: z.literal(false),
    textVerbosity: z.enum(["low", "medium", "high"]),
  })
  .strict();

const ecosystemProviderModelSchema = z
  .object({
    id: z.string().min(1),
    options: ecosystemProviderModelOptionsSchema,
    provider: z.string().min(1),
    role: z.string().min(1),
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
    provider_models: z.array(ecosystemProviderModelSchema).min(1),
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
    throw validationError(configIssuesFromZodError(parsed.error));
  }
  return parsed.data;
}
