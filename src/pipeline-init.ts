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
  DEFAULT_MCP_INSTALLS,
  DEFAULT_SKILL_INSTALLS,
  defaultMcpJson,
  installDefaultMcpsWithCli,
  type PipelineMcpInstaller,
  type PipelineMcpSkippedRegistration,
  type PipelineSkillInstallSpec,
} from "./mcp/bootstrap.js";

export type PipelineSkillInstaller = (
  specs: PipelineSkillInstallSpec[],
  cwd: string
) => Promise<void>;

export interface PipelineInitOptions {
  cwd?: string;
  mcpInstaller?: PipelineMcpInstaller;
  overwrite?: boolean;
  skillInstaller?: PipelineSkillInstaller;
}

export interface PipelineInitResult {
  files: string[];
  skippedMcps: PipelineMcpSkippedRegistration[];
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
    workflow: default
    description: Full pipeline
  inspect:
    workflow: inspect
    description: Read-only repository inspection
  epic:
    workflow: epic-drain
    description: Route an epic's tickets into specialist tracks, run them in parallel, then thermo-nuclear review.

orchestrator:
  profile: orchestrator
  hooks: [generated-defaults-audit]

hooks:
  generated-defaults-audit:
    event: workflow.start
    kind: command
    command:
      - node
      - -e
      - |
        const fs = require("node:fs");
        const files = [".pipeline/profiles.yaml", ".mcp.json"].filter((file) => fs.existsSync(file));
        const text = files.map((file) => fs.readFileSync(file, "utf8")).join("\\n").toLowerCase();
        const banned = ["atlassian", "jira", "linear", "confluence", "compass", "sentry", "deepwiki"];
        const hits = banned.filter((item) => text.includes(item));
        const githubUrls = [...text.matchAll(/https:\\/\\/api\\.githubcopilot\\.com\\/mcp[^"'\\s]*/g)].map((match) => match[0]);
        const writeGithub = githubUrls.filter((url) => !url.includes("/readonly"));
        if (hits.length || writeGithub.length) {
          console.error(["Banned generated defaults detected.", hits.length ? "services=" + hits.join(",") : "", writeGithub.length ? "github=" + writeGithub.join(",") : ""].filter(Boolean).join(" "));
          process.exit(1);
        }
    required: true
    trusted: true
    timeout_ms: 5000
    output_limit_bytes: 4096

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
  claude:
    type: claude
    command: claude
    capabilities:
      native_subagents: true
      rules: true
      skills: false
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json, json_schema]
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      rules: true
      skills: false
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write, task]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json, jsonl, json_schema]
  kimi:
    type: kimi
    command: kimi
    capabilities:
      native_subagents: true
      rules: true
      skills: false
      mcp_servers: false
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json]
  pi:
    type: pi
    command: pi
    capabilities:
      native_subagents: true
      rules: true
      skills: false
      mcp_servers: false
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json]
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
mcp_servers:
  serena:
    ref:
      path: .mcp.json
  context7:
    ref:
      path: .mcp.json
  semgrep:
    ref:
      path: .mcp.json
  backlog:
    ref:
      path: .mcp.json
  qdrant:
    ref:
      path: .mcp.json
  github-readonly:
    ref:
      path: .mcp.json
  playwright:
    ref:
      path: .mcp.json

profiles:
  orchestrator:
    runner: codex
    instructions:
      path: .pipeline/prompts/orchestrator.md
    rules: [test-first, verification]
    skills: [scope, doubt]
    mcp_servers: [backlog, qdrant, github-readonly]
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
    mcp_servers: [serena, context7, backlog, qdrant, github-readonly]
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
    mcp_servers: [serena, context7]
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
    mcp_servers: [serena, context7]
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
    mcp_servers: [backlog, github-readonly]
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
    description: Implement production code until the failing tests pass.
    instructions:
      path: .pipeline/prompts/code-writer.md
    rules: [test-first]
    skills: [trace, test, fix, library-first-development]
    mcp_servers: [serena, context7, semgrep]
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
    description: Audit the finished change against every acceptance criterion.
    instructions:
      path: .pipeline/prompts/acceptance-reviewer.md
    rules: [verification]
    skills: [critique, doubt]
    mcp_servers: [serena, context7, semgrep, github-readonly, playwright]
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
    description: Perform the final thermo-nuclear code quality review of the integration branch.
    instructions:
      path: .agents/skills/critique/SKILL.md
    skills: [critique]
    mcp_servers: [serena, semgrep, github-readonly]
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
    description: Verify checks, implementation fit, and final evidence.
    instructions:
      path: .pipeline/prompts/verifier.md
    rules: [verification]
    skills: [verify, critique, secure, optimize]
    mcp_servers: [serena, semgrep, github-readonly, playwright]
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
    mcp_servers: [qdrant, backlog]
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
  ".pipeline/host-resources/claude.md": hostResourceInput("Claude Code"),
  ".pipeline/host-resources/codex.md": hostResourceInput("Codex"),
  ".pipeline/host-resources/opencode.md": hostResourceInput("OpenCode"),
  ".pipeline/host-resources/kimi.md": hostResourceInput("Kimi"),
  ".pipeline/host-resources/pi.md": hostResourceInput("Pi"),
};

export function defaultPipelineScaffoldFiles(): Record<string, string> {
  return { ".mcp.json": defaultMcpJson(), ...SCAFFOLD_FILES };
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

  const mcpInstaller = options.mcpInstaller ?? installDefaultMcpsWithCli;
  const mcpInstallResult = await mcpInstaller(DEFAULT_MCP_INSTALLS, cwd);
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
    skippedMcps: mcpInstallResult?.skipped ?? [],
  };
}

export function formatPipelineInitResult(result: PipelineInitResult): string {
  const skippedMcps = result.skippedMcps ?? [];
  return [
    "Initialized pipeline scaffold:",
    ...result.files.map((path) => `create ${path}`),
    ...skippedMcps.flatMap((skip) => [
      `Skipped MCPM registration for ${skip.name}: ${skip.reason}.`,
      `Set ${skip.missingEnv.join(" or ")} before retrying MCPM registration. The generated MCP entry remains in .mcp.json.`,
    ]),
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
