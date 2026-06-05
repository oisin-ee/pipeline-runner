import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import {
  loadPipelineConfig,
  PIPELINE_CONFIG_PATH,
  PROFILES_CONFIG_PATH,
  RUNNERS_CONFIG_PATH,
} from "./config.js";
import {
  DEFAULT_SKILL_INSTALLS,
  type PipelineSkillInstallSpec,
} from "./mcp/bootstrap.js";

export type PipelineSkillInstaller = (
  specs: PipelineSkillInstallSpec[],
  cwd: string
) => Promise<void>;

export interface PipelineInitOptions {
  cwd?: string;
  overwrite?: boolean;
  skillInstaller?: PipelineSkillInstaller;
}

export interface PipelineInitResult {
  files: string[];
}

export class PipelineInitError extends Error {
  conflicts: string[];

  constructor(conflicts: string[]) {
    super(
      [
        "Refusing to overwrite existing pipeline scaffold files.",
        ...conflicts.map((path) => `- ${path}`),
        "Re-run with --overwrite to replace them.",
      ].join("\n")
    );
    this.name = "PipelineInitError";
    this.conflicts = conflicts;
  }
}

const DEFAULT_PIPELINE_YAML = `version: 1
default_workflow: default

entrypoints:
  pipe:
    schedule: pipe-schedule
    description: Full pipeline
  inspect:
    workflow: inspect
    description: Read-only repository inspection
  epic:
    schedule: epic-schedule
    description: Route an epic's tickets into specialist tracks, run them in parallel, then thermo-nuclear review.

orchestrator:
  profile: orchestrator

hooks:
  functions:
    generated-defaults-audit:
      kind: command
      command:
        - node
        - -e
        - |
          const fs = require("node:fs");
          const files = [".pipeline/profiles.yaml"].filter((file) => fs.existsSync(file));
          const text = files.map((file) => fs.readFileSync(file, "utf8")).join("\\n").toLowerCase();
          const banned = ["atlassian", "jira", "linear", "confluence", "compass", "sentry", "deepwiki"];
          const hits = banned.filter((item) => text.includes(item));
          const githubUrls = [...text.matchAll(/https:\\/\\/api\\.githubcopilot\\.com\\/mcp[^"'\\s]*/g)].map((match) => match[0]);
          const writeGithub = githubUrls.filter((url) => !url.includes("/readonly"));
          if (hits.length || writeGithub.length) {
            console.error(["Banned generated defaults detected.", hits.length ? "services=" + hits.join(",") : "", writeGithub.length ? "github=" + writeGithub.join(",") : ""].filter(Boolean).join(" "));
            process.exit(1);
          }
          fs.writeFileSync(process.env.PIPELINE_HOOK_RESULT, JSON.stringify({ status: "pass", summary: "Generated defaults audit passed" }));
      trusted: true
      timeout_ms: 5000
      output_limit_bytes: 4096
  on:
    workflow.start:
      - id: generated-defaults-audit
        function: generated-defaults-audit
        failure: fail

schedules:
  pipe-schedule:
    baseline: pipe
    planner_profile: pipeline-schedule-planner
  epic-schedule:
    baseline: epic
    planner_profile: pipeline-schedule-planner

workflows:
  inspect:
    description: Read-only repository inspection workflow.
    nodes:
      - id: inspect
        kind: agent
        profile: pipeline-inspector
  default:
    description: Default research, red, green, acceptance, verify, learn workflow.
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: red
        kind: agent
        profile: pipeline-test-writer
        needs: [research]
        gates:
          - id: red-test-file-policy
            kind: changed_files
            changed_files:
              allow:
                [
                  "**/*.test.*",
                  "**/*.spec.*",
                  "**/*_test.*",
                  "**/__tests__/**",
                  "test/**",
                  "tests/**",
                  "**/*.snap",
                ]
              require_any:
                [
                  "**/*.test.*",
                  "**/*.spec.*",
                  "**/*_test.*",
                  "**/__tests__/**",
                  "test/**",
                  "tests/**",
                ]
      - id: green
        kind: agent
        profile: pipeline-code-writer
        needs: [red]
      - id: acceptance
        kind: agent
        profile: pipeline-acceptance-reviewer
        needs: [green]
        gates:
          - id: acceptance-coverage
            kind: acceptance
            target: stdout
            required: false
          - id: acceptance-verdict
            kind: verdict
            target: stdout
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [acceptance]
        gates:
          - id: verify-typecheck
            kind: builtin
            builtin: typecheck
          - id: verify-tests
            kind: builtin
            builtin: test
          - id: verify-semgrep
            kind: builtin
            builtin: semgrep
          - id: verify-duplication
            kind: builtin
            builtin: duplication
          - id: verify-verdict
            kind: verdict
            target: stdout
      - id: learn
        kind: agent
        profile: pipeline-learner
        needs: [verify]
  infra:
    description: Default-shaped stub workflow for infrastructure specialization.
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: red
        kind: agent
        profile: pipeline-test-writer
        needs: [research]
        gates:
          - id: red-test-file-policy
            kind: changed_files
            changed_files:
              allow:
                [
                  "**/*.test.*",
                  "**/*.spec.*",
                  "**/*_test.*",
                  "**/__tests__/**",
                  "test/**",
                  "tests/**",
                  "**/*.snap",
                ]
              require_any:
                [
                  "**/*.test.*",
                  "**/*.spec.*",
                  "**/*_test.*",
                  "**/__tests__/**",
                  "test/**",
                  "tests/**",
                ]
      - id: green
        kind: agent
        profile: pipeline-code-writer
        needs: [red]
      - id: acceptance
        kind: agent
        profile: pipeline-acceptance-reviewer
        needs: [green]
        gates:
          - id: acceptance-coverage
            kind: acceptance
            target: stdout
            required: false
          - id: acceptance-verdict
            kind: verdict
            target: stdout
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [acceptance]
        gates:
          - id: verify-typecheck
            kind: builtin
            builtin: typecheck
          - id: verify-tests
            kind: builtin
            builtin: test
          - id: verify-semgrep
            kind: builtin
            builtin: semgrep
          - id: verify-duplication
            kind: builtin
            builtin: duplication
          - id: verify-verdict
            kind: verdict
            target: stdout
      - id: learn
        kind: agent
        profile: pipeline-learner
        needs: [verify]
  epic-drain:
    description: Research, route, parallel-implement tracks in isolated worktrees, integrate, thermo-nuclear review.
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: plan
        kind: agent
        profile: pipeline-epic-router
        needs: [research]
      - id: implement
        kind: parallel
        needs: [plan]
        nodes:
          - id: test
            kind: workflow
            workflow: default
            worktree_root: .pipeline/runs/\${runId}/test
          - id: frontend
            kind: workflow
            workflow: default
            worktree_root: .pipeline/runs/\${runId}/frontend
          - id: backend
            kind: workflow
            workflow: default
            worktree_root: .pipeline/runs/\${runId}/backend
          - id: k8s
            kind: workflow
            workflow: infra
            worktree_root: .pipeline/runs/\${runId}/k8s
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [implement]
      - id: review
        kind: agent
        profile: pipeline-thermo-nuclear-reviewer
        needs: [merge]
        gates:
          - id: review-verdict
            kind: verdict
            target: stdout
`;

const DEFAULT_RUNNERS_YAML = `version: 1

runners:
  codex:
    type: codex
    command: codex
    model: gpt-5.5
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json, jsonl, json_schema]
  opencode:
    type: opencode
    command: opencode
    model: opencode/deepseek-v4-flash-free
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write, task]
      filesystem: [read-only, workspace-write]
      network: [inherit]
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

const DEFAULT_PROFILES_YAML = `version: 1

rules:
  test-first:
    path: .pipeline/rules/test-first.md
  verification:
    path: .pipeline/rules/verification.md

skills:
  schedule-graph-shaping:
    path: .pipeline/skills/schedule-graph-shaping/SKILL.md
  critique:
    path: .agents/skills/critique/SKILL.md
  diagnose:
    path: .agents/skills/diagnose/SKILL.md
  doubt:
    path: .agents/skills/doubt/SKILL.md
  fix:
    path: .agents/skills/fix/SKILL.md
  improve:
    path: .agents/skills/improve/SKILL.md
  library-first-development:
    path: .agents/skills/library-first-development/SKILL.md
  migrate:
    path: .agents/skills/migrate/SKILL.md
  optimize:
    path: .agents/skills/optimize/SKILL.md
  research:
    path: .agents/skills/research/SKILL.md
  scope:
    path: .agents/skills/scope/SKILL.md
  secure:
    path: .agents/skills/secure/SKILL.md
  spec:
    path: .agents/skills/spec/SKILL.md
  test:
    path: .agents/skills/test/SKILL.md
  trace:
    path: .agents/skills/trace/SKILL.md
  verify:
    path: .agents/skills/verify/SKILL.md
mcp_gateway:
  provider: toolhive
  mode: local
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
  default_profile: default

profiles:
  orchestrator:
    runner: codex
    instructions:
      path: .pipeline/prompts/orchestrator.md
    rules: [test-first, verification]
    skills: [scope, doubt]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
  pipeline-researcher:
    runner: codex
    description: Research the requested task and produce structured findings.
    instructions:
      path: .pipeline/prompts/researcher.md
    rules: [test-first]
    skills: [research, spec, scope]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/research.schema.json
      repair:
        enabled: true
        max_attempts: 1
  pipeline-inspector:
    runner: codex
    description: Inspect the repository without modifying files.
    instructions:
      path: .pipeline/prompts/inspector.md
    skills: [research]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: text
  pipeline-schedule-planner:
    runner: codex
    description: Refine a baseline schedule into a specialized approved-plan artifact.
    instructions:
      path: .pipeline/prompts/schedule-planner.md
    skills: [schedule-graph-shaping]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: text
  pipeline-test-writer:
    runner: codex
    description: Add focused failing tests for the requested behavior.
    instructions:
      path: .pipeline/prompts/test-writer.md
    rules: [test-first]
    skills: [test]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash, edit, write]
    filesystem:
      mode: workspace-write
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: text
  pipeline-epic-router:
    runner: codex
    description: Route epic sub-tickets into fixed implementation tracks.
    instructions:
      path: .pipeline/prompts/epic-router.md
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/epic-plan.schema.json
      repair:
        enabled: true
        max_attempts: 1
  pipeline-code-writer:
    runner: codex
    scheduling_roles: [implementation]
    description: Implement production code until the failing tests pass.
    instructions:
      path: .pipeline/prompts/code-writer.md
    rules: [test-first]
    skills: [trace, test, fix, library-first-development]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash, edit, write]
    filesystem:
      mode: workspace-write
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: text
  pipeline-acceptance-reviewer:
    runner: codex
    scheduling_roles: [coverage]
    description: Audit the finished change against every acceptance criterion.
    instructions:
      path: .pipeline/prompts/acceptance-reviewer.md
    rules: [verification]
    skills: [critique, doubt]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/acceptance.schema.json
      repair:
        enabled: true
        max_attempts: 1
  pipeline-thermo-nuclear-reviewer:
    runner: codex
    scheduling_roles: [coverage]
    description: Perform the final thermo-nuclear code quality review of the integration branch.
    instructions:
      path: .agents/skills/critique/SKILL.md
    skills: [critique]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/review.schema.json
      repair:
        enabled: true
        max_attempts: 1
  pipeline-verifier:
    runner: codex
    scheduling_roles: [coverage]
    description: Verify checks, implementation fit, and final evidence.
    instructions:
      path: .pipeline/prompts/verifier.md
    rules: [verification]
    skills: [verify, critique, secure, optimize]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/verify.schema.json
      repair:
        enabled: true
        max_attempts: 1
  pipeline-learner:
    runner: codex
    description: Store durable lessons from the completed run.
    instructions:
      path: .pipeline/prompts/learner.md
    skills: [migrate]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/learn.schema.json
      repair:
        enabled: true
        max_attempts: 1
  pipeline-opencode-researcher:
    runner: opencode
    description: Research the requested task and produce structured findings with OpenCode.
    instructions:
      path: .pipeline/prompts/researcher.md
    rules: [test-first]
    skills: [research, spec, scope]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/research.schema.json
      repair:
        enabled: true
        max_attempts: 1
  pipeline-opencode-test-writer:
    runner: opencode
    description: Add focused failing tests for the requested behavior with OpenCode.
    instructions:
      path: .pipeline/prompts/test-writer.md
    rules: [test-first]
    skills: [test]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash, edit, write]
    filesystem:
      mode: workspace-write
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: text
  pipeline-opencode-code-writer:
    runner: opencode
    scheduling_roles: [implementation]
    description: Implement production code until the failing tests pass with OpenCode.
    instructions:
      path: .pipeline/prompts/code-writer.md
    rules: [test-first]
    skills: [trace, test, fix, library-first-development]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash, edit, write]
    filesystem:
      mode: workspace-write
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: text
  pipeline-opencode-acceptance-reviewer:
    runner: opencode
    scheduling_roles: [coverage]
    description: Audit the finished change against every acceptance criterion with OpenCode.
    instructions:
      path: .pipeline/prompts/acceptance-reviewer.md
    rules: [verification]
    skills: [critique, doubt]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/acceptance.schema.json
      repair:
        enabled: true
        max_attempts: 1
  pipeline-opencode-verifier:
    runner: opencode
    scheduling_roles: [coverage]
    description: Verify checks, implementation fit, and final evidence with OpenCode.
    instructions:
      path: .pipeline/prompts/verifier.md
    rules: [verification]
    skills: [verify, critique, secure, optimize]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/verify.schema.json
      repair:
        enabled: true
        max_attempts: 1
`;

const VERDICT_SCHEMA = z.enum(["PASS", "FAIL"]);
const STRING_ARRAY_SCHEMA = z.array(z.string());
const EPIC_TRACK_ITEM_SCHEMA = z.object({
  id: z.string(),
  rationale: z.string().optional(),
  title: z.string().optional(),
});

function zodJsonSchema(schema: z.ZodType): string {
  return JSON.stringify(
    z.toJSONSchema(schema, { target: "draft-07" }),
    null,
    2
  );
}

const RESEARCH_SCHEMA = zodJsonSchema(
  z.object({
    ac: STRING_ARRAY_SCHEMA,
    files: STRING_ARRAY_SCHEMA.optional(),
    findings: STRING_ARRAY_SCHEMA,
    risks: STRING_ARRAY_SCHEMA.optional(),
    target: z.string().optional(),
  })
);

const VERIFY_SCHEMA = zodJsonSchema(
  z.object({
    evidence: STRING_ARRAY_SCHEMA,
    verdict: VERDICT_SCHEMA,
    violations: STRING_ARRAY_SCHEMA.optional(),
  })
);

const LEARN_SCHEMA = zodJsonSchema(
  z.object({
    evidence: STRING_ARRAY_SCHEMA,
    qdrant: z.object({
      attempted: z.boolean(),
      succeeded: z.boolean(),
    }),
  })
);

const ACCEPTANCE_SCHEMA = zodJsonSchema(
  z.object({
    acceptance: z.array(
      z.object({
        evidence: STRING_ARRAY_SCHEMA,
        id: z.string(),
        verdict: VERDICT_SCHEMA,
      })
    ),
    evidence: STRING_ARRAY_SCHEMA,
    verdict: VERDICT_SCHEMA,
    violations: STRING_ARRAY_SCHEMA.optional(),
  })
);

const EPIC_PLAN_SCHEMA = zodJsonSchema(
  z.object({
    backend: z.array(EPIC_TRACK_ITEM_SCHEMA),
    frontend: z.array(EPIC_TRACK_ITEM_SCHEMA),
    k8s: z.array(EPIC_TRACK_ITEM_SCHEMA),
    rationale: z.string().optional(),
    test: z.array(EPIC_TRACK_ITEM_SCHEMA),
  })
);

const REVIEW_SCHEMA = zodJsonSchema(
  z.object({
    findings: z.array(
      z.object({
        file: z.string().optional(),
        line: z.number().int().min(1).optional(),
        message: z.string(),
        rule: z.string().optional(),
        severity: z.enum(["info", "warn", "error", "critical"]),
      })
    ),
    summary: z.string().optional(),
    verdict: VERDICT_SCHEMA,
  })
);

const SCAFFOLD_FILES: Record<string, string> = {
  [PIPELINE_CONFIG_PATH]: DEFAULT_PIPELINE_YAML,
  [PROFILES_CONFIG_PATH]: DEFAULT_PROFILES_YAML,
  [RUNNERS_CONFIG_PATH]: DEFAULT_RUNNERS_YAML,
  ".pipeline/skills/schedule-graph-shaping/SKILL.md": [
    "---",
    "name: schedule-graph-shaping",
    "description: Use when generating or reviewing pipeline schedule graphs for a task or epic. Shapes explicit root DAGs by grouping related tickets and verification work by goal, dependency, and evidence instead of defaulting to one full RED/GREEN/VERIFY chain per ticket.",
    "---",
    "",
    "# Schedule Graph Shaping",
    "",
    "Use this when producing a `pipeline-schedule` YAML artifact.",
    "",
    "## Contract",
    "",
    "- Return only the artifact requested by the schedule planner. Do not add prose.",
    "- Generate exactly one workflow named `root`.",
    "- Do not use `kind: workflow` or embed configured workflow copies such as `default`, `infra`, `track`, or `epic-drain`.",
    "- Every generated agent node must declare a configured `profile`.",
    "- Node IDs must be stable lowercase kebab-case and match `^[a-z][a-z0-9-]*$`.",
    "- Do not invent profiles, node-level skills, or unconfigured gates.",
    "",
    "## Shaping Procedure",
    "",
    "1. Cluster work units by intent before drawing nodes.",
    "   Group tickets that validate the same behavior, touch the same subsystem, share acceptance evidence, or must land in a fixed order.",
    "",
    "2. Use RED nodes for test strategy, not ticket counting.",
    "   One RED node can cover several GREEN tickets when they share the same failing test suite or behavior contract. Split RED nodes only when the tests are meaningfully independent or different profiles are needed.",
    "",
    "3. Use GREEN nodes for independently implementable slices.",
    "   A GREEN node may cover one ticket or a coherent group of tickets. Split GREEN nodes when the work can run in parallel, has different dependencies, has materially different ownership/risk, or would make one node too broad to review.",
    "",
    "4. Use acceptance nodes for user-visible outcomes.",
    "   One acceptance node can cover multiple implementation nodes when they produce the same visible outcome or acceptance checklist.",
    "",
    "5. Use verifier nodes for shared evidence.",
    "   One verifier can validate multiple tickets when the same real repository commands and checks prove them. Split verifiers only when evidence differs, one area needs specialized inspection, or a dependency boundary requires earlier proof.",
    "",
    "6. Preserve necessary serial order.",
    "   Dependencies from the backlog, shared migrations/schema changes, public API changes, and foundational refactors should gate downstream implementation. Independent clusters should fan out and then fan in to shared acceptance, verifier, merge, or review nodes.",
    "",
    "## Task Context",
    "",
    "- Assign every backlog work unit to at least one explicit generated agent node with `task_context.id`.",
    "- Prefer assigning ticket-specific context to GREEN nodes.",
    "- RED, acceptance, and verifier nodes may omit `task_context` when they cover a group; include it only when the node is genuinely ticket-specific.",
    "",
    "## Efficiency Checks",
    "",
    "Before returning the graph, ask:",
    "",
    "- Did I create a RED/GREEN/VERIFY chain just because a ticket exists?",
    "- Can several GREEN nodes share one RED node without losing test-first behavior?",
    "- Can several GREEN nodes share one verifier because the same commands prove them?",
    "- Are independent implementation slices parallelized?",
    "- Are serial edges based on real dependencies rather than habit?",
    "",
  ].join("\n"),
  ".pipeline/prompts/orchestrator.md": [
    "You are the orchestrator for the pipeline.",
    "Use `.pipeline/pipeline.yaml` as the source of truth for workflow order, profiles, gates, hooks, and artifacts.",
    "Delegate only to workflow node profiles and enforce configured gates before reporting completion.",
    "Only gates declared in `.pipeline/pipeline.yaml` are blocking. Do not invent RED, GREEN, full-suite, typecheck, or unrelated-drift gates.",
    "If a node returns targeted evidence and has no configured blocking gate, advance to the next workflow node.",
    "",
  ].join("\n"),
  ".pipeline/prompts/researcher.md": [
    "You are the research phase for the pipeline.",
    "Call `qdrant-find` before local inspection when the qdrant MCP server is available.",
    "Use collection_name equal to the repository directory basename, and skip this only when the user explicitly disables memory.",
    "Surface relevant prior lessons briefly before continuing.",
    "Inspect first-party source, tests, docs, and task context before proposing changes.",
    "Write structured findings that identify relevant files, existing patterns, acceptance criteria, and risks.",
    "Return only valid JSON matching `.pipeline/schemas/research.schema.json`: an object with `findings` and `ac` arrays, plus optional `files`, `risks`, and `target`.",
    "Do not wrap the JSON in Markdown fences or add prose outside the JSON object.",
    "",
  ].join("\n"),
  ".pipeline/prompts/inspector.md": [
    "You are the read-only inspection phase for the pipeline.",
    "Use a bounded inspection: run at most 8 discovery commands and read at most 12 small, high-signal files.",
    "Prefer `pwd`, `rg --files -g '!*node_modules*' -g '!dist/**' -g '!build/**' | head -200`, package/workspace manifests, mise/turbo config, and test config files.",
    "When reading paths with shell metacharacters such as brackets, quote the whole path.",
    "Do not recursively inspect route trees or generated output.",
    "Report the app structure, available checks, important files, and notable risks from the sampled evidence.",
    "Do not modify files.",
    "",
  ].join("\n"),
  ".pipeline/prompts/schedule-planner.md": [
    "# Schedule planner",
    "",
    "Generate a constrained agent graph as a specialized `pipeline-schedule` YAML artifact for the user task.",
    "",
    "Keep the graph auditable: execution must include research, implementation, and verification.",
    "",
    "Generate exactly one workflow named `root`. Do not embed `default`, `epic-drain`, `infra`, `track`, or other configured workflow copies. Use explicit generated agent, builtin, command, parallel, or group nodes. Do not use `kind: workflow`.",
    "",
    "Use the provided backlog work units as the source of truth when present. Assign each work unit to explicit generated agent nodes with only its `task_context.id`, use only allowed configured profiles, and ensure profiles with the `implementation` scheduling role have downstream profiles with the `coverage` scheduling role. Do not invent profiles or node-level skill overrides.",
    "Do not copy backlog descriptions or acceptance criteria into output; the scheduler hydrates them from the assigned `task_context.id` after parsing.",
    "Preserve Backlog dependency ids as schedule needs edges. A node assigned a dependent work unit must depend on the nodes assigned its prerequisite work units, directly or through an explicit path.",
    "",
    "Shape the graph by intent, not by ticket count. Do not create a full RED/GREEN/ACCEPTANCE/VERIFY chain for each backlog ticket unless each step needs ticket-specific evidence. Use one RED node for a group of tickets when they share a test strategy, fan out to parallel GREEN implementation nodes where the work can be implemented independently, and fan back in to shared acceptance or verifier nodes when the same acceptance checklist or real repository commands prove the group. Only serialize ticket nodes when the backlog, a shared migration/schema/API dependency, or implementation risk requires it.",
    "",
    "Return exactly one YAML document and nothing else. Do not wrap it in Markdown fences. Do not include commentary, plans, task lists, or explanations. Do not modify files. Do not invoke other agents.",
    "",
    "Use block-style YAML for objects and arrays. Do not use compact inline mappings like `{ id: PIPE-41.1, title: ... }`. Quote scalar strings that contain punctuation such as `:`, `#`, `[`, `]`, `{`, or `}`.",
    "",
  ].join("\n"),
  ".pipeline/prompts/test-writer.md": [
    "You are the RED/test-write phase for the pipeline.",
    "Add focused failing tests for the requested behavior only.",
    "Do not change production code.",
    "Return concrete failing-test evidence.",
    "",
  ].join("\n"),
  ".pipeline/prompts/epic-router.md": [
    "# Epic router",
    "",
    "You read an epic ticket and its sub-tickets via the Backlog MCP server, then route each sub-ticket into exactly one of four named tracks: test, frontend, backend, k8s. You output a JSON document matching `.pipeline/schemas/epic-plan.schema.json`.",
    "",
    "## Inputs",
    "",
    "- The user's task is an epic id (or a description that names one). Use the Backlog MCP `task_view` and `task_search` tools to find the epic and enumerate its sub-tickets.",
    "- For each sub-ticket, read its title, description, labels, and any referenced files.",
    "",
    "## Routing rules",
    "",
    "Pick the single best-fit track per ticket. Heuristics, in priority order:",
    "",
    "1. **k8s** - anything touching deployment, Kubernetes manifests, Helm charts, infra YAML, CI/CD pipelines, Docker, ingress, RBAC, cluster config.",
    "2. **backend** - server-side APIs, services, database schema, server-side data flows, MCP servers, non-UI integrations.",
    "3. **frontend** - UI components, client-side state, styling, browser interactions, accessibility, Figma-referenced work.",
    "4. **test** - work that is *primarily* writing or restructuring tests (e.g. coverage uplift, harness changes). Don't route a feature ticket here just because it mentions tests - features go to their domain track and write their own tests there.",
    "",
    "Ties: prefer **backend > frontend > test > k8s** unless a strong signal flips it.",
    "",
    "A track may be empty (`[]`).",
    "",
    "## Output",
    "",
    "Emit a single JSON document conforming to the schema. Include a short `rationale` string explaining notable routing decisions.",
    "",
    "Do not modify any files. Do not invoke other agents.",
    "",
  ].join("\n"),
  ".pipeline/prompts/code-writer.md": [
    "You are the GREEN/code-write phase for the pipeline.",
    "Implement the smallest production change that satisfies the failing tests.",
    "Keep edits scoped to the requested behavior.",
    "Return concrete targeted test evidence. Include typecheck evidence only when a typecheck command exists or a configured gate requires it.",
    "Unrelated full-suite failures and missing optional scripts are not blocking unless `.pipeline/pipeline.yaml` declares a gate for them.",
    "",
  ].join("\n"),
  ".pipeline/prompts/acceptance-reviewer.md": [
    "You are the ACCEPTANCE phase for the pipeline.",
    "Audit the completed change against each canonical acceptance criterion independently.",
    "Use concrete evidence from files, tests, command output, or browser observations when granted.",
    "Return only valid JSON matching `.pipeline/schemas/acceptance.schema.json`: an object with `verdict`, `evidence`, `acceptance`, and optional `violations`.",
    "Every acceptance entry must include `id`, `verdict`, and `evidence`.",
    "Do not wrap the JSON in Markdown fences or add prose outside the JSON object.",
    "",
  ].join("\n"),
  ".pipeline/prompts/verifier.md": [
    "You are the VERIFY phase for the pipeline.",
    "Review implementation fit, run targeted supporting checks, and report PASS or FAIL with evidence.",
    "Do not mark the workflow passing without concrete verification evidence.",
    "The runtime runs deterministic gates declared in `.pipeline/pipeline.yaml` after your verifier output, including typecheck, tests, semgrep, duplication, and verdict gates.",
    "Do not run built-in deterministic gates manually; do not run semgrep or duplication directly unless the user task specifically asks you to debug those tools.",
    "Verifier agents must not run semgrep or duplication directly unless the task specifically asks them to debug those tools.",
    "Do not invent ad hoc replacements for deterministic gates or fail because an unrelated manual check differs from the configured gate.",
    "If you run extra checks, they are supporting evidence only. Treat configured gates declared in `.pipeline/pipeline.yaml` as authoritative.",
    "Return only valid JSON matching `.pipeline/schemas/verify.schema.json`: an object with `verdict`, `evidence`, and optional `violations`.",
    "Do not wrap the JSON in Markdown fences or add prose outside the JSON object.",
    "",
  ].join("\n"),
  ".pipeline/prompts/learner.md": [
    "You are the LEARN phase for the pipeline.",
    "Store durable lessons from the run when useful and report qdrant-store evidence.",
    "Call `qdrant-store` with collection_name equal to the repository directory basename.",
    "Include metadata with at least repo, phase, workflow or entrypoint, task, and outcome.",
    "Do not write local markdown knowledge as the durable sink.",
    "Return only valid JSON matching `.pipeline/schemas/learn.schema.json`: an object with `qdrant` and `evidence`.",
    "Do not wrap the JSON in Markdown fences or add prose outside the JSON object.",
    "",
  ].join("\n"),
  ".pipeline/rules/test-first.md": [
    "# Test First",
    "",
    "RED writes failing tests before GREEN changes production code.",
    "",
  ].join("\n"),
  ".pipeline/rules/verification.md": [
    "# Verification",
    "",
    "VERIFY requires concrete check output and implementation-fit evidence.",
    "",
  ].join("\n"),
  ".pipeline/schemas/research.schema.json": `${RESEARCH_SCHEMA}\n`,
  ".pipeline/schemas/acceptance.schema.json": `${ACCEPTANCE_SCHEMA}\n`,
  ".pipeline/schemas/epic-plan.schema.json": `${EPIC_PLAN_SCHEMA}\n`,
  ".pipeline/schemas/verify.schema.json": `${VERIFY_SCHEMA}\n`,
  ".pipeline/schemas/review.schema.json": `${REVIEW_SCHEMA}\n`,
  ".pipeline/schemas/learn.schema.json": `${LEARN_SCHEMA}\n`,
  ".pipeline/host-resources/codex.md": hostResourceInput("Codex"),
  ".pipeline/host-resources/opencode.md": hostResourceInput("OpenCode"),
};

export function defaultPipelineScaffoldFiles(): Record<string, string> {
  return { ...SCAFFOLD_FILES };
}

export async function installDefaultSkillsWithCli(
  specs: PipelineSkillInstallSpec[],
  cwd: string
): Promise<void> {
  for (const spec of specs) {
    await execa(
      "npx",
      ["--yes", "skills", "add", spec.source, ...(spec.args ?? [])],
      {
        cwd,
        stderr: "inherit",
        stdout: "inherit",
      }
    );
  }
}

export async function initPipelineProject(
  options: PipelineInitOptions = {}
): Promise<PipelineInitResult> {
  const cwd = options.cwd ?? process.cwd();
  const files = defaultPipelineScaffoldFiles();
  const paths = Object.keys(files);
  const conflicts = paths.filter((path) => {
    const target = join(cwd, path);
    return existsSync(target) && readFileSync(target, "utf8") !== files[path];
  });

  if (conflicts.length > 0 && !options.overwrite) {
    throw new PipelineInitError(conflicts);
  }

  const skillInstaller = options.skillInstaller ?? installDefaultSkillsWithCli;
  await skillInstaller(DEFAULT_SKILL_INSTALLS, cwd);

  for (const [path, content] of Object.entries(files)) {
    const target = join(cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  loadPipelineConfig(cwd);
  return {
    files: paths,
  };
}

export function formatPipelineInitResult(result: PipelineInitResult): string {
  return [
    "Initialized pipeline scaffold:",
    ...result.files.map((path) => `create ${path}`),
  ].join("\n");
}

function hostResourceInput(host: string): string {
  return [
    `# ${host} Resource Input`,
    "",
    "This file is scaffolded input for host-specific generated resources.",
    "The source of truth is `.pipeline/pipeline.yaml` plus `.pipeline/profiles.yaml` and `.pipeline/runners.yaml`; generated host resources must preserve the profiles, prompts, rules, tools, filesystem policy, network policy, and output contracts declared there.",
    "",
  ].join("\n");
}
