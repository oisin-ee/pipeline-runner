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

export interface PipelineInitOptions {
  cwd?: string;
  mcpInstaller?: PipelineMcpInstaller;
  overwrite?: boolean;
  skillInstaller?: PipelineSkillInstaller;
}

export interface PipelineInitResult {
  files: string[];
}

export interface PipelineSkillInstallSpec {
  skills: string[];
  source: string;
}

export type PipelineSkillInstaller = (
  specs: PipelineSkillInstallSpec[],
  cwd: string
) => Promise<void>;

export interface PipelineMcpInstallSpec {
  args?: string[];
  catalog?: string;
  command?: string;
  env?: Record<string, string>;
  headers?: Record<string, PipelineMcpHeaderValue>;
  name: string;
  transport: "remote" | "stdio";
  url?: string;
}

export interface PipelineMcpHeaderSource {
  env: string;
  prefix?: string;
  suffix?: string;
}

export type PipelineMcpHeaderValue = string | PipelineMcpHeaderValueSpec;

export interface PipelineMcpHeaderValueSpec {
  sources: PipelineMcpHeaderSource[];
}

export type PipelineMcpInstaller = (
  specs: PipelineMcpInstallSpec[],
  cwd: string
) => Promise<void>;

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

export class PipelineSkillInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineSkillInstallError";
  }
}

export class PipelineMcpInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineMcpInstallError";
  }
}

export class PipelineDefaultManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineDefaultManifestError";
  }
}

export const DEFAULT_MCPM_COMMAND = "uvx";
export const DEFAULT_MCPM_ARGS = ["--python", "3.12", "mcpm"];
const DEFAULT_INSTALL_MANIFEST_URL = new URL(
  "../defaults/install-manifest.json",
  import.meta.url
);

const pipelineSkillInstallSpecSchema = z
  .object({
    skills: z.array(z.string().min(1)).min(1),
    source: z.string().min(1),
  })
  .strict();

const pipelineMcpHeaderSourceSchema = z
  .object({
    env: z.string().min(1),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
  })
  .strict();

const pipelineMcpHeaderValueSchema = z.union([
  z.string(),
  z
    .object({
      sources: z.array(pipelineMcpHeaderSourceSchema).min(1),
    })
    .strict(),
]);

const pipelineMcpInstallSpecSchema = z
  .object({
    args: z.array(z.string()).optional(),
    catalog: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), pipelineMcpHeaderValueSchema).optional(),
    name: z.string().min(1),
    transport: z.enum(["remote", "stdio"]),
    url: z.string().url().optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.catalog) {
      return;
    }
    if (spec.transport === "remote") {
      if (!spec.url) {
        ctx.addIssue({
          code: "custom",
          message: "remote MCP install spec must declare url or catalog",
          path: ["url"],
        });
      }
      if (spec.command) {
        ctx.addIssue({
          code: "custom",
          message: "remote MCP install spec cannot declare command",
          path: ["command"],
        });
      }
      if (spec.args) {
        ctx.addIssue({
          code: "custom",
          message: "remote MCP install spec cannot declare args",
          path: ["args"],
        });
      }
      if (spec.env) {
        ctx.addIssue({
          code: "custom",
          message: "remote MCP install spec cannot declare env",
          path: ["env"],
        });
      }
      return;
    }
    if (!spec.command) {
      ctx.addIssue({
        code: "custom",
        message: "stdio MCP install spec must declare command or catalog",
        path: ["command"],
      });
    }
    if (spec.headers) {
      ctx.addIssue({
        code: "custom",
        message: "stdio MCP install spec cannot declare headers",
        path: ["headers"],
      });
    }
    if (spec.url) {
      ctx.addIssue({
        code: "custom",
        message: "stdio MCP install spec cannot declare url",
        path: ["url"],
      });
    }
  });

const defaultInstallManifestSchema = z
  .object({
    mcps: z.array(pipelineMcpInstallSpecSchema),
    skills: z.array(pipelineSkillInstallSpecSchema),
    version: z.literal(1),
  })
  .strict();

interface DefaultInstallManifest {
  mcps: PipelineMcpInstallSpec[];
  skills: PipelineSkillInstallSpec[];
  version: 1;
}

function loadDefaultInstallManifest(): DefaultInstallManifest {
  const raw = JSON.parse(readFileSync(DEFAULT_INSTALL_MANIFEST_URL, "utf8"));
  const parsed = defaultInstallManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PipelineDefaultManifestError(
      [
        "Invalid defaults/install-manifest.json.",
        ...parsed.error.issues.map((issue) =>
          [issue.path.join("."), issue.message].filter(Boolean).join(": ")
        ),
      ].join("\n")
    );
  }
  return parsed.data;
}

export const DEFAULT_INSTALL_MANIFEST = loadDefaultInstallManifest();
export const DEFAULT_SKILL_INSTALLS: PipelineSkillInstallSpec[] =
  DEFAULT_INSTALL_MANIFEST.skills;
export const DEFAULT_MCP_INSTALLS: PipelineMcpInstallSpec[] =
  DEFAULT_INSTALL_MANIFEST.mcps;

const DEFAULT_PIPELINE_YAML = `version: 1
default_workflow: default

entrypoints:
  pipe:
    workflow: default
    description: Full pipeline
  inspect:
    workflow: inspect
    description: Read-only repository inspection

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

function defaultMcpJson(): string {
  return `${JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        [
          ["backlog", "oisin-pipeline-backlog"],
          ["context7", "oisin-pipeline-context7"],
          ["github-readonly", "oisin-pipeline-github-readonly"],
          ["playwright", "oisin-pipeline-playwright"],
          ["qdrant", "oisin-pipeline-qdrant"],
          ["semgrep", "oisin-pipeline-semgrep"],
          ["serena", "oisin-pipeline-serena"],
        ].map(([server, installName]) => [
          server,
          {
            args: [...DEFAULT_MCPM_ARGS, "run", installName],
            command: DEFAULT_MCPM_COMMAND,
          },
        ])
      ),
    },
    null,
    2
  )}\n`;
}

const DEFAULT_PROFILES_YAML = `version: 1

rules:
  test-first:
    path: .pipeline/rules/test-first.md
  verification:
    path: .pipeline/rules/verification.md

skills:
  using-superpowers:
    path: .agents/skills/using-superpowers/SKILL.md
  writing-plans:
    path: .agents/skills/writing-plans/SKILL.md
  dispatching-parallel-agents:
    path: .agents/skills/dispatching-parallel-agents/SKILL.md
  test-driven-development:
    path: .agents/skills/test-driven-development/SKILL.md
  requesting-code-review:
    path: .agents/skills/requesting-code-review/SKILL.md
  receiving-code-review:
    path: .agents/skills/receiving-code-review/SKILL.md
  verification-before-completion:
    path: .agents/skills/verification-before-completion/SKILL.md
  context-engineering:
    path: .agents/skills/context-engineering/SKILL.md
  source-driven-development:
    path: .agents/skills/source-driven-development/SKILL.md
  spec-driven-development:
    path: .agents/skills/spec-driven-development/SKILL.md
  planning-and-task-breakdown:
    path: .agents/skills/planning-and-task-breakdown/SKILL.md
  incremental-implementation:
    path: .agents/skills/incremental-implementation/SKILL.md
  debugging-and-error-recovery:
    path: .agents/skills/debugging-and-error-recovery/SKILL.md
  code-review-and-quality:
    path: .agents/skills/code-review-and-quality/SKILL.md
  doubt-driven-development:
    path: .agents/skills/doubt-driven-development/SKILL.md
  security-and-hardening:
    path: .agents/skills/security-and-hardening/SKILL.md
  performance-optimization:
    path: .agents/skills/performance-optimization/SKILL.md
  documentation-and-adrs:
    path: .agents/skills/documentation-and-adrs/SKILL.md
  deprecation-and-migration:
    path: .agents/skills/deprecation-and-migration/SKILL.md
  semgrep:
    path: .agents/skills/semgrep/SKILL.md
  supply-chain-risk-auditor:
    path: .agents/skills/supply-chain-risk-auditor/SKILL.md
  vercel-react-best-practices:
    path: .agents/skills/vercel-react-best-practices/SKILL.md
  web-design-guidelines:
    path: .agents/skills/web-design-guidelines/SKILL.md
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
    skills:
      [
        using-superpowers,
        writing-plans,
        dispatching-parallel-agents,
        planning-and-task-breakdown,
        doubt-driven-development,
      ]
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
    skills:
      [
        context-engineering,
        source-driven-development,
        spec-driven-development,
        planning-and-task-breakdown,
      ]
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
    skills: [context-engineering, source-driven-development]
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
    skills: [test-driven-development]
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
  pipeline-code-writer:
    runner: codex
    description: Implement production code until the failing tests pass.
    instructions:
      path: .pipeline/prompts/code-writer.md
    rules: [test-first]
    skills:
      [
        incremental-implementation,
        source-driven-development,
        debugging-and-error-recovery,
        test-driven-development,
      ]
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
    skills:
      [
        requesting-code-review,
        receiving-code-review,
        code-review-and-quality,
        doubt-driven-development,
      ]
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
  pipeline-verifier:
    runner: codex
    description: Verify checks, implementation fit, and final evidence.
    instructions:
      path: .pipeline/prompts/verifier.md
    rules: [verification]
    skills:
      [
        verification-before-completion,
        code-review-and-quality,
        security-and-hardening,
        performance-optimization,
      ]
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
    skills: [documentation-and-adrs, deprecation-and-migration]
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

const RESEARCH_SCHEMA = JSON.stringify(
  {
    additionalProperties: false,
    properties: {
      ac: { items: { type: "string" }, type: "array" },
      files: { items: { type: "string" }, type: "array" },
      findings: { items: { type: "string" }, type: "array" },
      risks: { items: { type: "string" }, type: "array" },
      target: { type: "string" },
    },
    required: ["findings", "ac"],
    type: "object",
  },
  null,
  2
);

const VERIFY_SCHEMA = JSON.stringify(
  {
    additionalProperties: false,
    properties: {
      evidence: { items: { type: "string" }, type: "array" },
      verdict: { enum: ["PASS", "FAIL"], type: "string" },
      violations: { items: { type: "string" }, type: "array" },
    },
    required: ["verdict", "evidence"],
    type: "object",
  },
  null,
  2
);

const LEARN_SCHEMA = JSON.stringify(
  {
    additionalProperties: false,
    properties: {
      evidence: { items: { type: "string" }, type: "array" },
      qdrant: {
        additionalProperties: false,
        properties: {
          attempted: { type: "boolean" },
          succeeded: { type: "boolean" },
        },
        required: ["attempted", "succeeded"],
        type: "object",
      },
    },
    required: ["qdrant", "evidence"],
    type: "object",
  },
  null,
  2
);

const ACCEPTANCE_SCHEMA = JSON.stringify(
  {
    additionalProperties: false,
    properties: {
      acceptance: {
        items: {
          additionalProperties: false,
          properties: {
            evidence: { items: { type: "string" }, type: "array" },
            id: { type: "string" },
            verdict: { enum: ["PASS", "FAIL"], type: "string" },
          },
          required: ["id", "verdict", "evidence"],
          type: "object",
        },
        type: "array",
      },
      evidence: { items: { type: "string" }, type: "array" },
      verdict: { enum: ["PASS", "FAIL"], type: "string" },
      violations: { items: { type: "string" }, type: "array" },
    },
    required: ["verdict", "evidence", "acceptance"],
    type: "object",
  },
  null,
  2
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
  ".pipeline/schemas/verify.schema.json": `${VERIFY_SCHEMA}\n`,
  ".pipeline/schemas/learn.schema.json": `${LEARN_SCHEMA}\n`,
  ".pipeline/host-resources/claude.md": hostResourceInput("Claude Code"),
  ".pipeline/host-resources/codex.md": hostResourceInput("Codex"),
  ".pipeline/host-resources/opencode.md": hostResourceInput("OpenCode"),
  ".pipeline/host-resources/kimi.md": hostResourceInput("Kimi"),
  ".pipeline/host-resources/pi.md": hostResourceInput("Pi"),
};

function defaultSkillPaths(): string[] {
  return [
    ...new Set(
      DEFAULT_SKILL_INSTALLS.flatMap((install) =>
        install.skills.map((skill) => `.agents/skills/${skill}/SKILL.md`)
      )
    ),
  ].sort();
}

export async function installDefaultSkillsWithCli(
  specs: PipelineSkillInstallSpec[],
  cwd: string
): Promise<void> {
  for (const spec of specs) {
    try {
      await execa(
        "npx",
        [
          "-y",
          "skills",
          "add",
          spec.source,
          "--agent",
          "codex",
          "--copy",
          "-y",
          "--skill",
          ...spec.skills,
        ],
        {
          cwd,
          stdin: "ignore",
        }
      );
    } catch (err) {
      const error = err as {
        stderr?: string;
        stdout?: string;
        shortMessage?: string;
      };
      throw new PipelineSkillInstallError(
        [
          `Failed to install skills from ${spec.source}.`,
          error.shortMessage,
          error.stderr,
          error.stdout,
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  }
}

export async function installDefaultMcpsWithCli(
  specs: PipelineMcpInstallSpec[],
  cwd: string
): Promise<void> {
  for (const spec of specs) {
    const install = mcpInstallArgs(spec);
    try {
      await execa(
        DEFAULT_MCPM_COMMAND,
        [...DEFAULT_MCPM_ARGS, ...install.args],
        {
          cwd,
          env: {
            MCPM_FORCE: "true",
            MCPM_JSON_OUTPUT: "true",
            MCPM_NON_INTERACTIVE: "true",
          },
          stdin: "ignore",
        }
      );
    } catch (err) {
      const error = err as {
        stderr?: string;
        stdout?: string;
        shortMessage?: string;
      };
      throw new PipelineMcpInstallError(
        [
          `Failed to register MCP server ${spec.name} with MCPM.`,
          "Pipeline init runs MCPM through `uvx --python 3.12 mcpm`.",
          "Install uv/uvx from https://docs.astral.sh/uv/ and re-run pipeline init.",
          redactMcpInstallOutput(error.shortMessage, install.redactions),
          redactMcpInstallOutput(error.stderr, install.redactions),
          redactMcpInstallOutput(error.stdout, install.redactions),
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  }
}

interface McpInstallArgs {
  args: string[];
  redactions: string[];
}

function mcpInstallArgs(spec: PipelineMcpInstallSpec): McpInstallArgs {
  if (spec.catalog) {
    return {
      args: ["install", spec.catalog, "--force", "--alias", spec.name],
      redactions: [],
    };
  }
  const args = ["new", spec.name, "--type", spec.transport, "--force"];
  if (spec.transport === "remote") {
    if (!spec.url) {
      throw new PipelineMcpInstallError(
        `MCP server ${spec.name} is remote but has no url.`
      );
    }
    const redactions: string[] = [];
    return {
      args: [
        ...args,
        "--url",
        spec.url,
        ...Object.entries(spec.headers ?? {}).flatMap(([key, value]) => {
          const headerValue = resolveMcpHeaderValue(spec.name, key, value);
          redactions.push(headerValue);
          return ["--headers", `${key}=${headerValue}`];
        }),
      ],
      redactions,
    };
  }
  if (!spec.command) {
    throw new PipelineMcpInstallError(
      `MCP server ${spec.name} is stdio but has no command.`
    );
  }
  return {
    args: [
      ...args,
      "--command",
      spec.command,
      ...(spec.args?.length ? ["--args", spec.args.join(" ")] : []),
      ...Object.entries(spec.env ?? {}).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]),
    ],
    redactions: [],
  };
}

const MCP_CREDENTIAL_PATTERN = /^\S+\s+(.+)$/;

function redactMcpInstallOutput(
  value: string | undefined,
  redactions: string[]
): string | undefined {
  if (!value) {
    return value;
  }
  const sensitiveValues = redactions
    .flatMap((item) => {
      const trimmed = item.trim();
      const credential = trimmed.match(MCP_CREDENTIAL_PATTERN)?.[1]?.trim();
      return credential ? [trimmed, credential] : [trimmed];
    })
    .filter((item) => item.length > 0);
  const escaped = [...new Set(sensitiveValues)]
    .sort((a, b) => b.length - a.length)
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const sensitivePattern =
    escaped.length > 0 ? new RegExp(escaped.join("|"), "g") : null;
  const redacted = sensitivePattern
    ? value.replace(sensitivePattern, "[REDACTED]")
    : value;
  return redacted.replace(
    /Authorization=[^\r\n'"]+/gi,
    "Authorization=[REDACTED]"
  );
}

function resolveMcpHeaderValue(
  serverName: string,
  headerName: string,
  header: PipelineMcpHeaderValue
): string {
  if (typeof header === "string") {
    return header;
  }
  for (const source of header.sources ?? []) {
    const rawValue = process.env[source.env];
    if (rawValue && rawValue.trim().length > 0) {
      return `${source.prefix ?? ""}${rawValue}${source.suffix ?? ""}`;
    }
  }
  const envNames = header.sources.map((source) => source.env).join(" or ");
  throw new PipelineMcpInstallError(
    [
      `MCP server ${serverName} requires ${headerName} credentials before it can be registered.`,
      `Set ${envNames} and re-run pipeline init.`,
    ].join("\n")
  );
}

function assertDefaultSkillsInstalled(cwd: string): string[] {
  const paths = defaultSkillPaths();
  const missing = paths.filter((path) => !existsSync(join(cwd, path)));
  if (missing.length > 0) {
    throw new PipelineSkillInstallError(
      [
        "skills CLI did not install every default pipeline skill.",
        ...missing.map((path) => `- ${path}`),
      ].join("\n")
    );
  }
  return paths;
}

export function defaultPipelineScaffoldFiles(): Record<string, string> {
  return { ".mcp.json": defaultMcpJson(), ...SCAFFOLD_FILES };
}

export async function initPipelineProject(
  options: PipelineInitOptions = {}
): Promise<PipelineInitResult> {
  const cwd = options.cwd ?? process.cwd();
  const files = defaultPipelineScaffoldFiles();
  const paths = Object.keys(files);
  const conflicts = paths.filter((path) => existsSync(join(cwd, path)));

  if (conflicts.length > 0 && !options.overwrite) {
    throw new PipelineInitError(conflicts);
  }

  const mcpInstaller = options.mcpInstaller ?? installDefaultMcpsWithCli;
  await mcpInstaller(DEFAULT_MCP_INSTALLS, cwd);
  const skillInstaller = options.skillInstaller ?? installDefaultSkillsWithCli;
  await skillInstaller(DEFAULT_SKILL_INSTALLS, cwd);
  const skillPaths = assertDefaultSkillsInstalled(cwd);

  for (const [path, content] of Object.entries(files)) {
    const target = join(cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const generatedPaths = [
    ...paths,
    ...skillPaths,
    ...(existsSync(join(cwd, "skills-lock.json")) ? ["skills-lock.json"] : []),
  ];

  loadPipelineConfig(cwd);
  return { files: generatedPaths };
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
