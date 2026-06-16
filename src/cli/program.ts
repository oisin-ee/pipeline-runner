import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Help, Option } from "commander";
import { execa } from "execa";
import {
  defaultClusterDoctorNamespace,
  runClusterDoctor,
} from "../cluster-doctor";
import {
  formatCodexAuthSyncResult,
  syncLocalCodexAuth,
} from "../codex-auth-sync";
import { registerBenchCommand } from "../commands/bench-command";
import { registerConfiguredEntrypointCommands } from "../commands/pipeline-command";
import { registerRunnerCommandCommand } from "../commands/runner-command-command";
import {
  loadPipelineConfig,
  type PipelineConfig,
  PipelineConfigError,
} from "../config";
import { formatConfigLintWarning, lintPipelineConfig } from "../config/lint";
import {
  type CommandHostSelection,
  formatInstallCommandsResult,
  installCommands,
  parseCommandHost,
} from "../install-commands";
import {
  configureGatewayHosts,
  type GatewayHostScope,
  type GatewayHostSelection,
  localGatewayStatus,
  reconcileGateway,
  renderGatewayConfig,
  runGatewayDoctor,
  startLocalGateway,
} from "../mcp/gateway";
import { loadMokaGlobalConfig } from "../moka-global-config";
import {
  formatPipelineInitResult,
  initPipelineProject,
} from "../pipeline-init";
import { runPipelineFromConfig } from "../pipeline-runtime";
import {
  compileWorkflowPlan,
  type PlannedWorkflowNode,
} from "../planning/compile";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
  parseScheduleArtifact,
} from "../planning/generate";
import {
  createOrchestratorLaunchPlan,
  createRunnerLaunchPlan,
} from "../runner";
import {
  createTerminalRuntimeReporter,
  formatDoctorResult,
  formatRuntimeFailure,
  formatRuntimeResult,
} from "./format";
import {
  addMokaSubmitOptions,
  type MokaSubmitFlags,
  runMokaSubmitFromCli,
} from "./submit-options";

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

interface DoctorFlags {
  cluster?: boolean | string;
  kubeContext?: string;
  kubeconfig?: string;
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
  const reporter = createTerminalRuntimeReporter();
  const result = await runner({
    config: inputs.config,
    reporter,
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

interface InstallCommandFlags {
  check?: boolean;
  dryRun?: boolean;
  force?: boolean;
  host?: CommandHostSelection;
}

interface CodexAuthSyncLocalFlags {
  check?: boolean;
  dryRun?: boolean;
  root?: string;
}

interface GatewayConfigureHostFlags {
  host?: GatewayHostSelection;
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

export function createCliProgram(): Command {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const configuredPipeline = loadConfiguredEntrypoints(cwd);
  const program = new Command();
  program
    .name("moka")
    .description("Submit work to Momokaya")
    .version(readPackageVersion())
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
    .description("Explain nodes, runners, gates, hooks, and artifacts")
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
    .option(
      "--cluster [namespace]",
      "also check runner-job Kubernetes prerequisites"
    )
    .option("--kube-context <context>", "kubectl context for cluster checks")
    .option("--kubeconfig <path>", "kubeconfig path for cluster checks")
    .action(async (flags: DoctorFlags) => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const result = await runDoctor(cwd, flags);
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
        .choices(["all", "opencode"])
        .default("all")
        .argParser(parseGatewayHost)
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
    .addOption(
      new Option(
        "--skill-scope <scope>",
        "where to install default skills: project (repo-local copy) or personal (one inherited user/global install)"
      )
        .choices(["project", "personal"])
        .default("project")
    )
    .action(async (flags: { skillScope: "project" | "personal" }) => {
      const result = await initPipelineProject({
        cwd: process.env.PIPELINE_TARGET_PATH ?? process.cwd(),
        scope: flags.skillScope,
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
        .choices(["all", "opencode", "claude-code"])
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

  const codexAuthCommand = program
    .command("codex-auth")
    .description("Manage local Codex multi-auth integration");

  codexAuthCommand
    .command("sync-local")
    .description(
      "Use one local oc-codex account pool and declare the plugin in dev repos"
    )
    .option("--root <path>", "directory containing repositories to sync")
    .option("--dry-run", "show planned changes without writing files")
    .option("--check", "fail if local Codex auth config is not synced")
    .action((flags: CodexAuthSyncLocalFlags) => {
      const result = syncLocalCodexAuth({
        check: flags.check,
        dryRun: flags.dryRun,
        root: resolve(
          flags.root ?? process.env.PIPELINE_TARGET_PATH ?? process.cwd()
        ),
      });
      console.log(formatCodexAuthSyncResult(result));
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  addMokaSubmitOptions(
    program
      .command("submit")
      .description("Submit work to Momokaya as an Argo Workflow")
      .argument(
        "[input...]",
        "task description, or command argv with --command"
      )
  ).action(async (input: string[], flags: MokaSubmitFlags) => {
    const result = await runMokaSubmitFromCli(input, flags);
    console.log(
      `Workflow submitted: ${result.workflowName} in ${result.namespace}`
    );
    if (result.workflowUid) {
      console.log(`Workflow UID: ${result.workflowUid}`);
    }
  });

  registerRunnerCommandCommand(program);
  registerBenchCommand(program);

  const configuredEntrypointCommands = registerConfiguredEntrypointCommands(
    program,
    omitConfiguredEntrypoints(configuredPipeline, ["execute", "quick"]),
    async (entrypoint, task, _opts) => {
      await execute(task, { entrypoint });
    }
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

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read @oisincoveney/pipeline package version.");
  }
  return packageJson.version;
}

function loadConfiguredEntrypoints(cwd: string): PipelineConfig {
  return loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });
}

function omitConfiguredEntrypoints(
  config: PipelineConfig,
  ids: string[]
): PipelineConfig {
  const omitted = new Set(ids);
  return {
    ...config,
    entrypoints: Object.fromEntries(
      Object.entries(config.entrypoints).filter(([id]) => !omitted.has(id))
    ),
  };
}

function parseGatewayHostScope(value: string): GatewayHostScope {
  if (value === "project" || value === "global") {
    return value;
  }
  throw new Error("scope must be project or global");
}

function parseGatewayHost(value: string): GatewayHostSelection {
  if (value === "all" || value === "opencode") {
    return value;
  }
  throw new Error("host must be all or opencode");
}

export async function runCli(argv: string[]): Promise<void> {
  const program = createCliProgram();
  await program.parseAsync(argv, { from: "node" });
}

export async function runDoctor(
  cwd: string,
  options: DoctorFlags = {}
): Promise<DoctorResult> {
  const commandChecks = await Promise.all([
    checkCommand("npx", ["--version"], cwd),
    checkCommand("opencode", ["--version"], cwd),
    checkCommand("fallow", ["--version"], cwd),
  ]);
  const configCheck = checkPipelineConfig(cwd);
  const globalConfig = loadMokaGlobalConfig();
  const clusterResult = options.cluster
    ? await runClusterDoctor({
        kubeContext: options.kubeContext,
        kubeconfigPath:
          options.kubeconfig ?? globalConfig?.momokaya.kubernetes.kubeconfig,
        namespace: clusterNamespace(
          options.cluster,
          globalConfig?.momokaya.kubernetes.namespace
        ),
      })
    : { checks: [] };
  const checks = [...commandChecks, configCheck, ...clusterResult.checks];
  return {
    checks,
    passed: checks.every((check) => check.passed),
  };
}

function clusterNamespace(
  value: boolean | string,
  configuredNamespace?: string
): string {
  return typeof value === "string" && value.length > 0
    ? value
    : (configuredNamespace ?? defaultClusterDoctorNamespace());
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
  if (!config.orchestrator) {
    return "Orchestrator: not configured";
  }
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
