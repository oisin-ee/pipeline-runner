#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";
import {
  type CommandHostSelection,
  formatInstallCommandsResult,
  installCommands,
  parseCommandHost,
} from "./install-commands.js";
import {
  loadPipelineConfig,
  type PipelineConfig,
  PipelineConfigError,
} from "./mastra/config.js";
import {
  createOrchestratorLaunchPlan,
  createRunnerLaunchPlan,
} from "./mastra/runner.js";
import {
  formatPipelineInitResult,
  initPipelineProject,
} from "./pipeline-init.js";
import {
  formatConfigError,
  type PipelineRuntimeEvent,
  type PipelineRuntimeResult,
  runPipelineFromConfig,
} from "./pipeline-runtime.js";
import { compileWorkflowPlan } from "./workflow-planner.js";

const PATH_SEPARATOR_RE = /[\\/]/;
const LINE_RE = /\r?\n/;

interface PipeOptions {
  pipelineRunner?: typeof runPipelineFromConfig;
  workflow?: string;
}

/**
 * Config-driven `pipe` entrypoint. The workflow source of truth is
 * `.pipeline/pipeline.yaml`; missing YAML is a hard error.
 */
export function pipe(
  description: string,
  options: PipeOptions = {}
): Promise<void> {
  try {
    if (!description.trim()) {
      throw new Error("Task description is required");
    }

    const worktreePath = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
    const runner = options.pipelineRunner ?? runPipelineFromConfig;
    return runConfiguredPipeline({
      pipelineRunner: runner,
      task: description,
      workflow: options.workflow,
      worktreePath,
    });
  } catch (err) {
    return Promise.reject(err as Error);
  }
}

interface RunFlags {
  workflow?: string;
}

interface RunInputs {
  pipelineRunner?: typeof runPipelineFromConfig;
  task: string;
  workflow?: string;
  worktreePath: string;
}

async function runConfiguredPipeline(inputs: RunInputs): Promise<void> {
  const runner = inputs.pipelineRunner ?? runPipelineFromConfig;
  const result = await runner({
    reporter: formatRuntimeProgress,
    task: inputs.task,
    workflowId: inputs.workflow,
    worktreePath: inputs.worktreePath,
  });
  console.log(formatRuntimeResult(result));
  if (result.outcome !== "PASS") {
    throw new Error(formatRuntimeFailure(result));
  }
}

function formatRuntimeProgress(event: PipelineRuntimeEvent): void {
  const message = formatRuntimeProgressMessage(event);
  console.error(message);
}

function formatRuntimeProgressMessage(event: PipelineRuntimeEvent): string {
  return (
    formatWorkflowProgress(event) ??
    formatAgentProgress(event) ??
    formatCheckProgress(event) ??
    formatRepairProgress(event)
  );
}

function formatWorkflowProgress(event: PipelineRuntimeEvent): string | null {
  switch (event.type) {
    case "workflow.start":
      return `Pipeline starting: ${event.workflowId} (${event.nodeIds.join(" -> ")})`;
    case "node.start":
      return [
        `Node starting: ${event.nodeId}`,
        event.runnerId ? `runner=${event.runnerId}` : "",
        event.profile ? `profile=${event.profile}` : "",
        `attempt=${event.attempt}`,
      ]
        .filter(Boolean)
        .join(" ");
    case "node.finish":
      return `Node finished: ${event.nodeId} ${event.status} exit=${event.exitCode}`;
    case "workflow.finish":
      return `Pipeline finished: ${event.workflowId} ${event.outcome}`;
    default:
      return null;
  }
}

function formatAgentProgress(event: PipelineRuntimeEvent): string | null {
  switch (event.type) {
    case "agent.start":
      return `Agent starting: ${event.nodeId} runner=${event.runnerId ?? "unknown"} attempt=${event.attempt}`;
    case "agent.finish":
      return `Agent finished: ${event.nodeId} runner=${event.runnerId ?? "unknown"} exit=${event.exitCode}`;
    case "hook.start":
      return `Hook starting: ${event.hookId} event=${event.event}${event.nodeId ? ` node=${event.nodeId}` : ""}`;
    case "hook.finish":
      return `Hook ${event.passed ? "passed" : "failed"}: ${event.hookId}${event.reason ? ` (${event.reason})` : ""}`;
    default:
      return null;
  }
}

function formatCheckProgress(event: PipelineRuntimeEvent): string | null {
  switch (event.type) {
    case "gate.start":
      return `Gate starting: ${event.nodeId}/${event.gateId}`;
    case "gate.finish":
      return `Gate ${event.passed ? "passed" : "failed"}: ${event.nodeId}/${event.gateId}${event.reason ? ` (${event.reason})` : ""}`;
    case "artifact.check.start":
      return `Artifact check starting: ${event.nodeId}/${event.path}`;
    case "artifact.check.finish":
      return `Artifact check ${event.passed ? "passed" : "failed"}: ${event.nodeId}/${event.path}${event.reason ? ` (${event.reason})` : ""}`;
    default:
      return null;
  }
}

function formatRepairProgress(event: PipelineRuntimeEvent): string {
  switch (event.type) {
    case "output.repair":
      return `Output repair ${event.passed ? "passed" : "failed"}: ${event.nodeId} attempt=${event.attempt}${event.reason ? ` (${event.reason})` : ""}`;
    default:
      throw new Error(`Unhandled runtime event: ${event.type}`);
  }
}

function formatRuntimeResult(result: PipelineRuntimeResult): string {
  const lines = [
    `Pipeline complete: ${result.outcome}`,
    `Workflow: ${result.plan.workflowId}`,
    `Nodes: ${result.nodes.map((node) => `${node.nodeId}:${node.status}`).join(", ")}`,
    `Agent boundaries: ${result.agentInvocations.length}`,
  ];
  const outputs = result.nodes.filter((node) => node.output.trim());
  if (outputs.length > 0) {
    lines.push("Node outputs:");
    for (const node of outputs) {
      appendIndentedSection(lines, node.nodeId, [node.output]);
    }
  }
  return lines.join("\n");
}

function formatRuntimeFailure(result: PipelineRuntimeResult): string {
  const lines = ["Pipeline failed."];
  for (const failure of result.failureDetails) {
    lines.push(
      failure.nodeId
        ? `- ${failure.nodeId}: ${failure.reason}`
        : `- ${failure.reason}`
    );
    appendIndentedSection(lines, "Evidence", failure.evidence);
    const node = failure.nodeId
      ? result.nodes.find((item) => item.nodeId === failure.nodeId)
      : undefined;
    if (node) {
      lines.push(
        `  Node: status=${node.status} attempts=${node.attempts} exit=${node.exitCode}`
      );
      appendIndentedSection(lines, "Node evidence", node.evidence);
      appendIndentedSection(lines, "Node output", [node.output]);
    }
  }
  if (result.gates.length > 0) {
    lines.push("Gates:");
    for (const gate of result.gates) {
      lines.push(
        `  - ${gate.nodeId}/${gate.gateId}: ${gate.passed ? "PASS" : "FAIL"}${gate.reason ? ` (${gate.reason})` : ""}`
      );
      appendIndentedSection(lines, "Gate evidence", gate.evidence);
    }
  }
  return lines.join("\n");
}

function appendIndentedSection(
  lines: string[],
  label: string,
  values: string[]
): void {
  const text = values.filter(Boolean).join("\n").trim();
  if (!text) {
    return;
  }
  lines.push(`  ${label}:`);
  lines.push(indent(truncateMiddle(text, 4000), "    "));
}

function indent(text: string, prefix: string): string {
  return text
    .split(LINE_RE)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const keep = Math.floor((maxLength - 32) / 2);
  return `${text.slice(0, keep)}\n... truncated ...\n${text.slice(-keep)}`;
}

interface InstallCommandFlags {
  check?: boolean;
  dryRun?: boolean;
  force?: boolean;
  host?: CommandHostSelection;
}

interface InitFlags {
  overwrite?: boolean;
}

interface ValidateFlags {
  workflow?: string;
}

export function createCliProgram(): Command {
  const program = new Command();
  program
    .name("@oisincoveney/pipeline")
    .description("Run and install the oisin pipeline")
    .exitOverride();

  const runAction = async (descriptionParts: string[], flags: RunFlags) => {
    await pipe(descriptionParts.join(" "), {
      workflow: flags.workflow,
    });
  };

  program
    .command("run")
    .description("Run a workflow from .pipeline/pipeline.yaml")
    .argument("<description...>", "task description")
    .option("--workflow <workflow>", "workflow id from pipeline.yaml")
    .action(runAction);

  program
    .command("pipe")
    .description("Alias for run")
    .argument("<description...>", "task description")
    .option("--workflow <workflow>", "workflow id from pipeline.yaml")
    .action(runAction);

  program
    .command("validate")
    .description(
      "Validate .pipeline/pipeline.yaml and compile the workflow plan"
    )
    .option("--workflow <workflow>", "workflow id from pipeline.yaml")
    .action((flags: ValidateFlags) => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd);
      const plan = compileWorkflowPlan(config, flags.workflow);
      console.log(
        `OK: ${plan.workflowId} (${plan.topologicalOrder.length} nodes)`
      );
    });

  program
    .command("explain-plan")
    .description("Explain workflow nodes, runners, gates, hooks, and artifacts")
    .option("--workflow <workflow>", "workflow id from pipeline.yaml")
    .action((flags: ValidateFlags) => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd);
      console.log(formatWorkflowPlan(config, cwd, flags.workflow));
    });

  program
    .command("init")
    .description("Scaffold the default .pipeline/pipeline.yaml workflow")
    .option("--overwrite", "replace existing pipeline scaffold files", false)
    .action(async (flags: InitFlags) => {
      const result = await initPipelineProject({
        cwd: process.env.PIPELINE_TARGET_PATH ?? process.cwd(),
        overwrite: flags.overwrite ?? false,
      });
      console.log(formatPipelineInitResult(result));
    });

  program
    .command("install-commands")
    .description(
      "Install generated slash-command adapters into this repository"
    )
    .addOption(
      new Option("--host <host>", "host command set to install")
        .choices(["all", "claude", "opencode", "codex", "kimi", "pi"])
        .default("all")
        .argParser(parseCommandHost)
    )
    .option("--dry-run", "show planned changes without writing files")
    .option("--check", "fail if generated command files are missing or stale")
    .option("--force", "overwrite manually edited command files")
    .action(async (flags: InstallCommandFlags) => {
      const result = await installCommands(flags);
      console.log(formatInstallCommandsResult(result));
    });

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = createCliProgram();
  // When invoked via the `pipe` bin entry (or its legacy aliases), prepend
  // the `pipe` subcommand so Commander parses the remaining args correctly.
  const scriptName = argv[1]?.split(PATH_SEPARATOR_RE).pop() ?? "";
  if (scriptName === "pipe") {
    const firstArg = argv[2];
    const directSubcommands = new Set([
      "explain-plan",
      "init",
      "install-commands",
      "run",
      "validate",
    ]);
    if (firstArg && directSubcommands.has(firstArg)) {
      await program.parseAsync(argv, { from: "node" });
      return;
    }
    await program.parseAsync(
      [argv[0] ?? "node", argv[1] ?? "pipe", "run", ...argv.slice(2)],
      { from: "node" }
    );
    return;
  }
  await program.parseAsync(argv, { from: "node" });
}

function scriptName(argv: string[]): string {
  return argv[1]?.split(PATH_SEPARATOR_RE).pop() ?? "";
}

export function isCliEntrypoint(argv: string[]): boolean {
  const name = scriptName(argv);
  const entrypoint = normalizeEntrypointPath(argv[1]);
  const modulePath = normalizeEntrypointPath(fileURLToPath(import.meta.url));
  return (
    entrypoint === modulePath || name === "pipe" || name === "oisin-pipeline"
  );
}

function normalizeEntrypointPath(path: string | undefined): string | undefined {
  if (!path) {
    return;
  }
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

if (isCliEntrypoint(process.argv)) {
  runCli(process.argv).catch((err: unknown) => {
    if (err instanceof CommanderError) {
      process.exit(err.exitCode);
    }
    if (err instanceof Error) {
      if (err instanceof PipelineConfigError) {
        console.error(formatConfigError(err));
      } else {
        console.error(err.message);
      }
      process.exit(1);
    }
    console.error(String(err));
    process.exit(1);
  });
}

function formatWorkflowPlan(
  config: PipelineConfig,
  worktreePath: string,
  workflowId?: string
): string {
  const plan = compileWorkflowPlan(config, workflowId);
  const workflow = config.workflows[plan.workflowId];
  const lines = [`Workflow: ${plan.workflowId}`];
  lines.push(formatOrchestratorPlan(config, worktreePath));
  lines.push(
    `Batches: ${plan.parallelBatches
      .map((batch) => `[${batch.map((node) => node.id).join(", ")}]`)
      .join(" -> ")}`
  );
  for (const node of plan.topologicalOrder) {
    const profile = node.profile ? config.profiles[node.profile] : undefined;
    const launch =
      profile && node.profile
        ? createRunnerLaunchPlan(config, {
            nodeId: node.id,
            profileId: node.profile,
            prompt: "<task>",
            worktreePath,
          })
        : null;
    lines.push(
      [
        `- ${node.id}`,
        `kind=${node.kind}`,
        `needs=${node.needs.join(",") || "none"}`,
        launch ? `runner=${launch.runnerId}` : "",
        launch ? `strategy=${launch.strategy}` : "",
        node.gates?.length ? `gates=${node.gates.length}` : "gates=0",
        node.artifacts?.length
          ? `artifacts=${node.artifacts.map((artifact) => artifact.path).join(",")}`
          : "artifacts=none",
        node.hooks?.length ? `hooks=${node.hooks.join(",")}` : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
  }
  if (workflow?.hooks?.length) {
    lines.push(`Workflow hooks: ${workflow.hooks.join(", ")}`);
  }
  return lines.join("\n");
}

function formatOrchestratorPlan(
  config: PipelineConfig,
  worktreePath: string
): string {
  const orchestrator = config.profiles[config.orchestrator.profile];
  const launch = createOrchestratorLaunchPlan(config, {
    nodeId: "orchestrator",
    prompt: "<task>",
    worktreePath,
  });
  return [
    `Orchestrator: runner=${launch.runnerId}`,
    `strategy=${launch.strategy}`,
    orchestrator.model ? `model=${orchestrator.model}` : "",
    formatList("rules", orchestrator.rules),
    formatList("skills", orchestrator.skills),
    formatList("mcp_servers", orchestrator.mcp_servers),
    formatList("hooks", config.orchestrator.hooks),
  ]
    .filter(Boolean)
    .join(" ");
}

function formatList(label: string, items: string[] | undefined): string {
  return items?.length ? `${label}=${items.join(",")}` : "";
}
