#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Help, Option } from "commander";
import { execa } from "execa";
import {
  BUILTIN_PIPE_COMMANDS,
  registerConfiguredEntrypointCommands,
} from "./commands/pipeline-command";
import { registerRunnerJobCommand } from "./commands/runner-job-command";
import {
  loadPipelineConfig,
  type PipelineConfig,
  PipelineConfigError,
} from "./config";
import {
  type CommandHostSelection,
  formatInstallCommandsResult,
  installCommands,
  parseCommandHost,
} from "./install-commands";
import {
  configureGatewayHosts,
  type GatewayHostScope,
  localGatewayStatus,
  reconcileGateway,
  renderGatewayConfig,
  runGatewayDoctor,
  startLocalGateway,
} from "./mcp/gateway";
import { resolvePackageAssetPath } from "./package-assets";
import { formatPipelineInitResult, initPipelineProject } from "./pipeline-init";
import {
  formatConfigError,
  type PipelineRuntimeEvent,
  type PipelineRuntimeResult,
  runPipelineFromConfig,
} from "./pipeline-runtime";
import { createOrchestratorLaunchPlan, createRunnerLaunchPlan } from "./runner";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
  parseScheduleArtifact,
} from "./schedule-planner";
import { standardOutputSchemaNameFromPath } from "./standard-output-schemas";
import {
  compileWorkflowPlan,
  type PlannedWorkflowNode,
} from "./workflow-planner";

const PATH_SEPARATOR_RE = /[\\/]/;
const LINE_RE = /\r?\n/;
interface ExecuteOptions {
  entrypoint?: string;
  pipelineRunner?: typeof runPipelineFromConfig;
  schedule?: string;
  workflow?: string;
}

/**
 * Config-driven `execute` entrypoint. Package-owned defaults are the source of
 * truth; repo-local pipeline files are ignored by runtime loading.
 */
export function execute(
  description: string,
  options: ExecuteOptions = {}
): Promise<void> {
  try {
    if (!description.trim()) {
      throw new Error("Task description is required");
    }

    const worktreePath = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
    return runConfiguredPipeline({
      pipelineRunner: options.pipelineRunner,
      entrypoint: options.entrypoint,
      schedule: options.schedule,
      task: description,
      workflow: options.workflow,
      worktreePath,
    });
  } catch (err) {
    return Promise.reject(err as Error);
  }
}

export function quick(
  description: string,
  options: Omit<ExecuteOptions, "entrypoint"> = {}
): Promise<void> {
  return execute(description, { ...options, entrypoint: "quick" });
}

interface RunFlags {
  entrypoint?: string;
  schedule?: string;
  workflow?: string;
}

interface DoctorCheck {
  detail: string;
  name: string;
  passed: boolean;
}

interface DoctorResult {
  checks: DoctorCheck[];
  passed: boolean;
}

interface RunInputs {
  entrypoint?: string;
  pipelineRunner?: typeof runPipelineFromConfig;
  schedule?: string;
  task: string;
  workflow?: string;
  worktreePath: string;
}

async function runConfiguredPipeline(inputs: RunInputs): Promise<void> {
  const config = loadPipelineConfig(inputs.worktreePath, {
    allowMissingLintFileReferences: true,
  });
  if (inputs.schedule) {
    const compiled = compileScheduleArtifact(
      config,
      parseScheduleArtifact(
        readFileSync(inputs.schedule, "utf8"),
        inputs.schedule
      ),
      inputs.worktreePath
    );
    await runAndPrintPipeline({
      ...inputs,
      config: compiled.config,
      workflow: compiled.workflowId,
    });
    return;
  }

  const scheduledEntrypoint = scheduledEntrypointId(
    config,
    inputs.workflow,
    inputs.entrypoint
  );
  if (scheduledEntrypoint) {
    if (inputs.pipelineRunner) {
      await runAndPrintPipeline({
        ...inputs,
        config,
      });
      return;
    }
    const result = await generateScheduleArtifact({
      config,
      entrypointId: scheduledEntrypoint,
      task: inputs.task,
      worktreePath: inputs.worktreePath,
    });
    console.log(`Schedule generated: ${result.path}`);
    const compiled = compileScheduleArtifact(
      config,
      parseScheduleArtifact(
        readFileSync(resolve(inputs.worktreePath, result.path), "utf8"),
        result.path
      ),
      inputs.worktreePath
    );
    await runAndPrintPipeline({
      ...inputs,
      config: compiled.config,
      workflow: compiled.workflowId,
    });
    return;
  }

  await runAndPrintPipeline({ ...inputs, config });
}

async function runAndPrintPipeline(
  inputs: RunInputs & { config: PipelineConfig }
): Promise<void> {
  const runner = inputs.pipelineRunner ?? runPipelineFromConfig;
  const result = await runner({
    config: inputs.config,
    reporter: formatRuntimeProgress,
    entrypoint: inputs.entrypoint,
    task: inputs.task,
    workflowId: inputs.workflow,
    worktreePath: inputs.worktreePath,
  });
  console.log(formatRuntimeResult(result));
  if (result.outcome !== "PASS") {
    throw new Error(formatRuntimeFailure(result));
  }
}

function scheduledEntrypointId(
  config: PipelineConfig,
  workflowId: string | undefined,
  entrypointId: string | undefined
): string | null {
  if (workflowId) {
    return null;
  }
  const id = entrypointId ?? "execute";
  const entrypoint = config.entrypoints[id];
  return entrypoint && "schedule" in entrypoint ? id : null;
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
    formatObservabilityProgress(event) ??
    formatRepairProgress(event)
  );
}

function formatWorkflowProgress(event: PipelineRuntimeEvent): string | null {
  switch (event.type) {
    case "workflow.planned":
      return `Pipeline planned: ${event.workflowId} (${event.nodes.map((node) => node.id).join(" -> ")})`;
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
    case "node.output.recorded":
      return `Node output recorded: ${event.nodeId} format=${event.format}`;
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
    case "hook.result":
      return `Hook result: ${event.hookId} ${event.status}${event.summary ? ` (${event.summary})` : ""}`;
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

function formatObservabilityProgress(
  event: PipelineRuntimeEvent
): string | null {
  switch (event.type) {
    case "runtime.observability":
      return `Runtime observed: ${event.name} - ${event.summary}`;
    default:
      return null;
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

interface GatewayConfigureHostFlags {
  host?: CommandHostSelection;
  scope?: GatewayHostScope;
}

interface GatewayLocalStartFlags {
  detach?: boolean;
}

interface ValidateFlags {
  entrypoint?: string;
  lint?: boolean;
  schedule?: string;
  strict?: boolean;
  workflow?: string;
}

type ConfigWorkflowNode = PipelineConfig["workflows"][string]["nodes"][number];

interface ConfigLintWarning {
  message: string;
  ruleId: string;
}

export function createCliProgram(): Command {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const configuredPipeline = loadConfiguredEntrypoints(cwd);
  const program = new Command();
  program
    .name("@oisincoveney/pipeline")
    .description("Run package-owned @oisincoveney/pipeline config")
    .exitOverride();

  const runAction = async (descriptionParts: string[], flags: RunFlags) => {
    await execute(descriptionParts.join(" "), {
      entrypoint: flags.entrypoint,
      schedule: flags.schedule,
      workflow: flags.workflow,
    });
  };

  program
    .command("run")
    .description(
      "Run a workflow from package-owned @oisincoveney/pipeline config"
    )
    .argument("<description...>", "task description")
    .option("--entrypoint <entrypoint>", "entrypoint alias from package config")
    .option("--schedule <schedule>", "approved schedule YAML to execute")
    .option("--workflow <workflow>", "workflow id from package config")
    .action(runAction);

  program
    .command("validate")
    .description(
      "Validate package-owned @oisincoveney/pipeline config and compile the workflow plan"
    )
    .option("--entrypoint <entrypoint>", "entrypoint alias from package config")
    .option("--schedule <schedule>", "approved schedule YAML to validate")
    .option("--strict", "fail when validation lint warnings are emitted")
    .option("--no-lint", "skip validation lint warnings")
    .option("--workflow <workflow>", "workflow id from package config")
    .action((flags: ValidateFlags) => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      const plan = flags.schedule
        ? compileScheduleArtifact(
            config,
            parseScheduleArtifact(
              readFileSync(flags.schedule, "utf8"),
              flags.schedule
            ),
            cwd
          ).plan
        : compileWorkflowPlan(
            config,
            resolveWorkflowSelection(config, flags.workflow, flags.entrypoint)
          );
      const warnings =
        flags.lint === false ? [] : lintPipelineConfig(config, cwd);
      for (const warning of warnings) {
        console.error(formatConfigLintWarning(warning));
      }
      if (flags.strict && warnings.length > 0) {
        throw new Error(
          `Validation failed with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`
        );
      }
      console.log(
        `OK: ${plan.workflowId} (${plan.topologicalOrder.length} nodes)`
      );
    });

  program
    .command("explain-plan")
    .description("Explain workflow nodes, runners, gates, hooks, and artifacts")
    .option("--entrypoint <entrypoint>", "entrypoint alias from package config")
    .option("--schedule <schedule>", "approved schedule YAML to explain")
    .option("--workflow <workflow>", "workflow id from package config")
    .action((flags: ValidateFlags) => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      console.log(formatSelectedWorkflowPlan(config, cwd, flags));
    });

  program
    .command("doctor")
    .description("Check local prerequisites for pipeline init and execution")
    .action(async () => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const result = await runDoctor(cwd);
      console.log(formatDoctorResult(result));
      if (!result.passed) {
        throw new Error("Doctor checks failed.");
      }
    });

  const gatewayCommand = program
    .command("mcp")
    .description("Manage the hosted-first MCP gateway")
    .command("gateway")
    .description("Inspect and configure the pipeline MCP gateway");

  gatewayCommand
    .command("doctor")
    .description(
      "Check MCP gateway configuration and legacy direct MCP entries"
    )
    .action(async () => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      const result = await runGatewayDoctor(config, cwd);
      console.log(formatDoctorResult(result));
      if (!result.passed) {
        throw new Error("MCP gateway doctor checks failed.");
      }
    });

  gatewayCommand
    .command("config")
    .description("Print resolved MCP gateway client configuration")
    .action(() => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      console.log(renderGatewayConfig(config));
    });

  gatewayCommand
    .command("configure-host")
    .description("Rewrite host MCP config to the singleton pipeline gateway")
    .addOption(
      new Option("--host <host>", "host config to update")
        .choices(["all", "opencode", "codex"])
        .default("all")
        .argParser(parseCommandHost)
    )
    .addOption(
      new Option("--scope <scope>", "config scope to update")
        .choices(["project", "global"])
        .default("project")
        .argParser(parseGatewayHostScope)
    )
    .action((flags: GatewayConfigureHostFlags) => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      const result = configureGatewayHosts(config, {
        cwd,
        host: flags.host ?? "all",
        scope: flags.scope ?? "project",
      });
      console.log(
        result
          .map((item) =>
            [
              `${item.host}: ${item.path}`,
              item.backupPath ? `backup=${item.backupPath}` : "backup=none",
            ].join(" ")
          )
          .join("\n")
      );
    });

  gatewayCommand
    .command("reconcile")
    .description("Apply the current workspace gateway backend inventory")
    .action(async () => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      const result = await reconcileGateway(config, cwd);
      console.log(
        [
          `workspace=${result.workspacePath}`,
          `config=${result.configPath}`,
          `backends=${result.backendCount}`,
          result.readinessFailures.length > 0
            ? `readiness_failures=${result.readinessFailures.join("; ")}`
            : "readiness_failures=none",
        ].join("\n")
      );
    });

  gatewayCommand
    .command("local-start")
    .description("Start a local ToolHive vMCP gateway for local mode")
    .option("--detach", "reserved for future background startup", false)
    .action(async (flags: GatewayLocalStartFlags) => {
      if (flags.detach) {
        throw new Error("Detached local gateway startup is not implemented.");
      }
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      await startLocalGateway(config, cwd);
    });

  gatewayCommand
    .command("local-status")
    .description("Show local ToolHive MCP server status")
    .action(async () => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      console.log(await localGatewayStatus(cwd));
    });

  program
    .command("init")
    .description(
      "Initialize package-owned pipeline support without repo-local config"
    )
    .action(async () => {
      const result = await initPipelineProject({
        cwd: process.env.PIPELINE_TARGET_PATH ?? process.cwd(),
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
        .choices(["all", "opencode", "codex"])
        .default("all")
        .argParser(parseCommandHost)
    )
    .option("--dry-run", "show planned changes without writing files")
    .option("--check", "fail if generated command files are missing or stale")
    .option("--force", "overwrite manually edited command files")
    .action(async (flags: InstallCommandFlags) => {
      const result = await installCommands({
        ...flags,
        cwd: process.env.PIPELINE_TARGET_PATH ?? process.cwd(),
      });
      console.log(formatInstallCommandsResult(result));
    });

  registerRunnerJobCommand(program);

  const configuredEntrypointCommands = registerConfiguredEntrypointCommands(
    program,
    configuredPipeline,
    (entrypoint, task) => execute(task, { entrypoint })
  );
  if (configuredEntrypointCommands.size > 0) {
    program.configureHelp({
      subcommandTerm(this: Help, command: Command) {
        if (configuredEntrypointCommands.has(command.name())) {
          return command.name();
        }
        return Help.prototype.subcommandTerm.call(this, command);
      },
    });
  }

  return program;
}

function loadConfiguredEntrypoints(cwd: string): PipelineConfig {
  return loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });
}

function parseGatewayHostScope(value: string): GatewayHostScope {
  if (value === "project" || value === "global") {
    return value;
  }
  throw new Error("scope must be project or global");
}

function lintPipelineConfig(
  config: PipelineConfig,
  projectRoot: string
): ConfigLintWarning[] {
  return [
    ...lintShadowedEntrypoints(config),
    ...lintMissingFileReferences(config, projectRoot),
    ...lintWorkflowNodes(config),
  ];
}

function lintShadowedEntrypoints(config: PipelineConfig): ConfigLintWarning[] {
  return Object.keys(config.entrypoints)
    .filter((id) => BUILTIN_PIPE_COMMANDS.has(id))
    .map((id) => ({
      ruleId: "entrypoint-shadowed",
      message: `entrypoint '${id}' is shadowed by the builtin subcommand; invoke via 'oisin-pipeline run --entrypoint ${id} ...'`,
    }));
}

function lintMissingFileReferences(
  config: PipelineConfig,
  projectRoot: string
): ConfigLintWarning[] {
  const refs: Array<{
    path: string;
    ref?: { path?: string; source_root?: "package" | "project" };
  }> = [];
  for (const [skillId, skill] of Object.entries(config.skills)) {
    refs.push({ path: `skills.${skillId}.path`, ref: skill });
  }
  for (const [profileId, profile] of Object.entries(config.profiles)) {
    refs.push({
      path: `profiles.${profileId}.instructions.path`,
      ref: { path: profile.instructions.path },
    });
    refs.push({
      path: `profiles.${profileId}.output.schema_path`,
      ref: { path: profile.output?.schema_path },
    });
  }
  return refs.flatMap((ref) => {
    const value = ref.ref?.path;
    if (
      !value ||
      standardOutputSchemaNameFromPath(value) ||
      existsSync(resolveLintPathReference(projectRoot, ref.ref))
    ) {
      return [];
    }
    return [
      {
        ruleId: "missing-file-reference",
        message: `${ref.path} references missing file '${value}'`,
      },
    ];
  });
}

function resolveLintPathReference(
  projectRoot: string,
  ref: { path?: string; source_root?: "package" | "project" } | undefined
): string {
  if (ref?.source_root === "package") {
    return resolvePackageAssetPath(ref.path);
  }
  return resolve(projectRoot, ref?.path ?? "");
}

function lintWorkflowNodes(config: PipelineConfig): ConfigLintWarning[] {
  const warnings: ConfigLintWarning[] = [];
  for (const workflow of Object.values(config.workflows)) {
    for (const node of workflow.nodes) {
      lintWorkflowNode(warnings, node);
    }
  }
  return warnings;
}

function lintWorkflowNode(
  warnings: ConfigLintWarning[],
  node: ConfigWorkflowNode
): void {
  if (node.kind === "parallel") {
    if (node.nodes.length === 1) {
      warnings.push({
        ruleId: "singleton-parallel",
        message: `node '${node.id}' is a parallel container with only one child; remove the wrapper`,
      });
    }
    for (const child of node.nodes) {
      lintWorkflowNode(warnings, child);
    }
  }
  if (
    node.kind === "workflow" &&
    node.worktree_root &&
    !isPipelineWorktreeRoot(node.worktree_root)
  ) {
    warnings.push({
      ruleId: "worktree-root-style",
      message: `node '${node.id}' worktree_root '${node.worktree_root}' is outside the suggested .pipeline/runs/ root; this is a style nudge, not an error`,
    });
  }
}

const LEADING_DOT_SLASH = /^\.\//;

function isPipelineWorktreeRoot(worktreeRoot: string): boolean {
  const normalized = worktreeRoot
    .replaceAll("\\", "/")
    .replace(LEADING_DOT_SLASH, "");
  return (
    normalized.startsWith(".pipeline/runs/") ||
    normalized.startsWith(".pipeline/drain/")
  );
}

function formatConfigLintWarning(warning: ConfigLintWarning): string {
  return `WARN ${warning.ruleId}: ${warning.message}`;
}

export async function runCli(argv: string[]): Promise<void> {
  const program = createCliProgram();
  await program.parseAsync(argv, { from: "node" });
}

export async function runDoctor(cwd: string): Promise<DoctorResult> {
  const commandChecks = await Promise.all([
    checkCommand("npx", ["--version"], cwd),
    checkCommand("codex", ["--version"], cwd),
    checkCommand("opencode", ["--version"], cwd),
  ]);
  const configCheck = checkPipelineConfig(cwd);
  const checks = [...commandChecks, configCheck];
  return {
    checks,
    passed: checks.every((check) => check.passed),
  };
}

function checkCommand(
  name: string,
  args: string[],
  cwd: string
): Promise<DoctorCheck> {
  return checkCommandWithRunner(name, name, args, cwd);
}

async function checkCommandWithRunner(
  name: string,
  command: string,
  args: string[],
  cwd: string
): Promise<DoctorCheck> {
  try {
    await execa(command, args, {
      cwd,
      stdin: "ignore",
    });
    return {
      detail: "available",
      name,
      passed: true,
    };
  } catch (err) {
    const error = err as { shortMessage?: string; stderr?: string };
    return {
      detail: (error.shortMessage || error.stderr || "not available").trim(),
      name,
      passed: false,
    };
  }
}

function checkPipelineConfig(cwd: string): DoctorCheck {
  try {
    loadPipelineConfig(cwd);
    return {
      detail: "valid",
      name: "pipeline-config",
      passed: true,
    };
  } catch (err) {
    let message = "invalid";
    if (err instanceof PipelineConfigError) {
      message = err.issues.map((issue) => issue.message).join("; ");
    } else if (err instanceof Error) {
      message = err.message;
    }
    return {
      detail: message || "missing or invalid",
      name: "pipeline-config",
      passed: false,
    };
  }
}

function formatDoctorResult(result: DoctorResult): string {
  return [
    `Doctor: ${result.passed ? "PASS" : "FAIL"}`,
    ...result.checks.map(
      (check) =>
        `- ${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`
    ),
  ].join("\n");
}

function scriptName(argv: string[]): string {
  return argv[1]?.split(PATH_SEPARATOR_RE).pop() ?? "";
}

export function isCliEntrypoint(argv: string[]): boolean {
  const name = scriptName(argv);
  const entrypoint = normalizeEntrypointPath(argv[1]);
  const modulePath = normalizeEntrypointPath(fileURLToPath(import.meta.url));
  return entrypoint === modulePath || name === "oisin-pipeline";
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
    if (hasExitCode(err)) {
      if (err.message) {
        console.error(err.message);
      }
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

function hasExitCode(err: unknown): err is Error & { exitCode: number } {
  return (
    err instanceof Error &&
    "exitCode" in err &&
    typeof (err as { exitCode?: unknown }).exitCode === "number"
  );
}

function formatWorkflowPlan(
  config: PipelineConfig,
  worktreePath: string,
  workflowId?: string
): string {
  const plan = compileWorkflowPlan(config, workflowId);
  return formatCompiledWorkflowPlan(config, worktreePath, plan);
}

function formatSelectedWorkflowPlan(
  config: PipelineConfig,
  worktreePath: string,
  flags: ValidateFlags
): string {
  if (flags.schedule) {
    const compiled = compileScheduleArtifact(
      config,
      parseScheduleArtifact(
        readFileSync(flags.schedule, "utf8"),
        flags.schedule
      ),
      worktreePath
    );
    return formatCompiledWorkflowPlan(
      compiled.config,
      worktreePath,
      compiled.plan
    );
  }
  return formatWorkflowPlan(
    config,
    worktreePath,
    resolveWorkflowSelection(config, flags.workflow, flags.entrypoint)
  );
}

function formatCompiledWorkflowPlan(
  config: PipelineConfig,
  worktreePath: string,
  plan: ReturnType<typeof compileWorkflowPlan>
): string {
  const lines = [`Workflow: ${plan.workflowId}`];
  lines.push(formatOrchestratorPlan(config, worktreePath));
  lines.push(
    `Batches: ${plan.parallelBatches
      .map((batch) => `[${batch.map((node) => node.id).join(", ")}]`)
      .join(" -> ")}`
  );
  for (const node of plan.topologicalOrder) {
    if (node.kind === "parallel" && node.children?.length) {
      lines.push(
        `${node.id}(parallel: ${node.children.map((child) => child.id).join(", ")})`
      );
    }
    lines.push(formatWorkflowPlanNode(node, config, worktreePath));
  }
  const workflowHooks = Object.entries(config.hooks.on).flatMap(
    ([event, bindings]) =>
      bindings
        .filter((binding) => binding.where?.workflow === plan.workflowId)
        .map((binding) => `${event}:${binding.id}`)
  );
  if (workflowHooks.length > 0) {
    lines.push(`Workflow hooks: ${workflowHooks.join(", ")}`);
  }
  return lines.join("\n");
}

function formatWorkflowPlanNode(
  node: PlannedWorkflowNode,
  config: PipelineConfig,
  worktreePath: string
): string {
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
  return [
    `- ${node.id}`,
    `kind=${node.kind}`,
    `needs=${node.needs.join(",") || "none"}`,
    launch ? `runner=${launch.runnerId}` : "",
    node.gates?.length ? `gates=${node.gates.length}` : "gates=0",
    node.artifacts?.length
      ? `artifacts=${node.artifacts.map((artifact) => artifact.path).join(",")}`
      : "artifacts=none",
  ]
    .filter(Boolean)
    .join(" ");
}

function resolveWorkflowSelection(
  config: PipelineConfig,
  workflowId?: string,
  entrypointId?: string
): string | undefined {
  if (workflowId) {
    return workflowId;
  }
  if (!entrypointId) {
    return;
  }
  const entrypoint = config.entrypoints[entrypointId];
  if (!entrypoint) {
    throw new Error(`Unknown pipeline entrypoint '${entrypointId}'`);
  }
  if ("schedule" in entrypoint) {
    throw new Error(
      `Pipeline entrypoint '${entrypointId}' generates schedule '${entrypoint.schedule}'; use the entrypoint to create a schedule, then run with --schedule.`
    );
  }
  return entrypoint.workflow;
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
    orchestrator.model ? `model=${orchestrator.model}` : "",
    formatList("rules", orchestrator.rules),
    formatList("skills", orchestrator.skills),
    formatList("mcp_servers", orchestrator.mcp_servers),
    formatList("hooks", Object.keys(config.hooks.functions)),
  ]
    .filter(Boolean)
    .join(" ");
}

function formatList(label: string, items: string[] | undefined): string {
  return items?.length ? `${label}=${items.join(",")}` : "";
}
