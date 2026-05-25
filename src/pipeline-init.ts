import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadPipelineConfig, PIPELINE_CONFIG_PATH } from "./mastra/config.js";

export interface PipelineInitOptions {
  cwd?: string;
  overwrite?: boolean;
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

runners:
  codex:
    type: codex
    command: codex
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

rules:
  test-first:
    path: .pipeline/rules/test-first.md
  verification:
    path: .pipeline/rules/verification.md

skills: {}
mcp_servers: {}
hooks: {}

agents:
  pipeline-researcher:
    runner: codex
    description: Research the requested task and produce structured findings.
    instructions:
      path: .pipeline/prompts/researcher.md
    rules: [test-first]
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
  pipeline-test-writer:
    runner: codex
    description: Add focused failing tests for the requested behavior.
    instructions:
      path: .pipeline/prompts/test-writer.md
    rules: [test-first]
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
    tools: [read, list, grep, glob, bash, edit, write]
    filesystem:
      mode: workspace-write
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: text
  pipeline-verifier:
    runner: codex
    description: Verify checks, implementation fit, and final evidence.
    instructions:
      path: .pipeline/prompts/verifier.md
    rules: [verification]
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
  pipeline-learner:
    runner: codex
    description: Store durable lessons from the completed run.
    instructions:
      path: .pipeline/prompts/learner.md
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

workflows:
  default:
    description: Default research, red, green, verify, learn workflow.
    nodes:
      - id: research
        kind: agent
        agent: pipeline-researcher
      - id: red
        kind: agent
        agent: pipeline-test-writer
        needs: [research]
      - id: green
        kind: agent
        agent: pipeline-code-writer
        needs: [red]
      - id: verify
        kind: agent
        agent: pipeline-verifier
        needs: [green]
      - id: learn
        kind: agent
        agent: pipeline-learner
        needs: [verify]
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

const SCAFFOLD_FILES: Record<string, string> = {
  [PIPELINE_CONFIG_PATH]: DEFAULT_PIPELINE_YAML,
  ".pipeline/prompts/researcher.md": [
    "You are the research phase for the pipeline.",
    "Inspect first-party source, tests, docs, and task context before proposing changes.",
    "Write structured findings that identify relevant files, existing patterns, acceptance criteria, and risks.",
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
    "Return concrete test and typecheck evidence.",
    "",
  ].join("\n"),
  ".pipeline/prompts/verifier.md": [
    "You are the VERIFY phase for the pipeline.",
    "Run configured checks, review implementation fit, and report PASS or FAIL with evidence.",
    "Do not mark the workflow passing without concrete verification evidence.",
    "",
  ].join("\n"),
  ".pipeline/prompts/learner.md": [
    "You are the LEARN phase for the pipeline.",
    "Store durable lessons from the run when useful and report qdrant-store evidence.",
    "Do not write local markdown knowledge as the durable sink.",
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
  ".pipeline/schemas/verify.schema.json": `${VERIFY_SCHEMA}\n`,
  ".pipeline/schemas/learn.schema.json": `${LEARN_SCHEMA}\n`,
  ".pipeline/host-resources/claude.md": hostResourceInput("Claude Code"),
  ".pipeline/host-resources/codex.md": hostResourceInput("Codex"),
  ".pipeline/host-resources/opencode.md": hostResourceInput("OpenCode"),
  ".pipeline/host-resources/kimi.md": hostResourceInput("Kimi"),
  ".pipeline/host-resources/pi.md": hostResourceInput("Pi"),
};

export function defaultPipelineScaffoldFiles(): Record<string, string> {
  return { ...SCAFFOLD_FILES };
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

  for (const [path, content] of Object.entries(files)) {
    const target = join(cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  loadPipelineConfig(cwd);
  return { files: paths };
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
    "This file is scaffolded input for host-specific resource projection.",
    "The source of truth is `.pipeline/pipeline.yaml`; generated host resources must preserve the agents, prompts, rules, tools, filesystem policy, network policy, and output contracts declared there.",
    "",
  ].join("\n");
}
