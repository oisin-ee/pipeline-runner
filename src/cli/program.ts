// fallow-ignore-file complexity code-duplication
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Help, Option } from "commander";
import { Effect } from "effect";
import { registerBenchCommand } from "../commands/bench-command";
import { registerConfiguredEntrypointCommands } from "../commands/pipeline-command";
import { registerRunnerCommandCommand } from "../commands/runner-command-command";
import {
  registerTicketCommand,
  type TicketCommandOptions,
} from "../commands/ticket-command";
import { loadPipelineConfig, type PipelineConfig } from "../config";
import { formatConfigLintWarning, lintPipelineConfig } from "../config/lint";
import {
  formatCodexAuthSyncResult,
  syncLocalCodexAuth,
} from "../credentials/local-codex-auth-sync";
import {
  type LoopCommandOptions,
  parseLoopFlags,
  runLoopSubmit,
} from "../loop/loop-command";
import { runLoopControllerEntrypoint } from "../loop/loop-controller-entrypoint";
import { renderGatewayConfig } from "../mcp/gateway-config";
import { runGatewayDoctor } from "../mcp/gateway-doctor";
import {
  localGatewayStatus,
  reconcileGateway,
  startLocalGateway,
} from "../mcp/gateway-reconcile";
import {
  configureGatewayHosts,
  type GatewayHostScope,
  type GatewayHostSelection,
} from "../mcp/host-config";
import {
  loadMokaGlobalConfig,
  type MokaGlobalConfig,
} from "../moka-global-config";
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
import { flattenNodes } from "../planning/graph";
import { registerRunControlCommands } from "../run-control/commands";
import type { RunEffort, RunMode, RunTarget } from "../run-control/contracts";
import { startDetachedRunController } from "../run-control/detach";
import {
  type RunControlStore,
  withRunControlStoreScoped,
} from "../run-control/run-control-store";
import { createRunStoreRuntimeReporter } from "../run-control/runtime-reporter";
import { createRunControlSupervisor } from "../run-control/supervisor";
import {
  createOrchestratorLaunchPlan,
  createRunnerLaunchPlan,
} from "../runner";
import {
  generateRuntimeRunId,
  resolveWorkflowSelection,
} from "../runtime/context";
import { type DoctorFlags, runDoctor as runDoctorChecks } from "./doctor";
import {
  createTerminalRuntimeReporter,
  formatDoctorResult,
  formatRuntimeFailure,
  formatRuntimeResult,
} from "./format";
import { dispatchMokaRunCommand, type RunCommand } from "./run-command";
import {
  type LocalRuntimeExecution,
  MOKA_RUN_EFFORTS,
  MOKA_RUN_TARGETS,
  type RemoteSubmitExecution,
  type RunResolverFlags,
  resolveMokaRun,
} from "./run-resolver";
import {
  addMokaSubmitOptions,
  type MokaSubmitFlags,
  runMokaSubmitFromCli,
} from "./submit-options";

interface ExecuteOptions {
  entrypoint?: string;
  pipelineRunner?: typeof runPipelineFromConfig;
  runControl?: RunControlOptions;
  runId?: string;
  runStoreMode?: RunStoreMode;
  schedule?: string;
  supervised?: boolean;
  supervisor?: boolean;
  workflow?: string;
}

type RunStoreMode = "create" | "reuse";

interface RunControlOptions {
  effort?: RunEffort;
  mode?: RunMode;
  target?: RunTarget;
}

interface RequiredRunControlOptions {
  effort: RunEffort;
  mode: RunMode;
  target: RunTarget;
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
      runId: options.runId,
      runStoreMode: options.runStoreMode,
      runControl: options.runControl,
      schedule: options.schedule,
      supervised: options.supervised,
      supervisor: options.supervisor,
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
  return execute(description, {
    ...options,
    entrypoint: "quick",
    runControl: { ...options.runControl, effort: "quick" },
  });
}

type RunFlags = RunResolverFlags;

interface RunInputs {
  entrypoint?: string;
  pipelineRunner?: typeof runPipelineFromConfig;
  runControl?: RunControlOptions;
  runId?: string;
  runStoreMode?: RunStoreMode;
  schedule?: string;
  // PIPE-91.16: serialized schedule artifact (schedule.yaml content) for the run.
  // Persisted at createRun so `moka resume` rebuilds this exact graph.
  scheduleArtifact?: string;
  supervised?: boolean;
  supervisor?: boolean;
  task: string;
  workflow?: string;
  worktreePath: string;
}

// One stable run id per invocation, shared by the schedule and the run so the
// durability journal (PIPE-83.10) is keyed consistently and crash-resume can
// target it by re-running with the same id.
function withRunId(inputs: RunInputs): RunInputs {
  return { ...inputs, runId: inputs.runId ?? generateRuntimeRunId() };
}

async function runConfiguredPipeline(rawInputs: RunInputs): Promise<void> {
  const inputs = withRunId(rawInputs);
  const config = loadPipelineConfig(inputs.worktreePath, {
    allowMissingLintFileReferences: true,
  });
  if (inputs.schedule) {
    const scheduleYaml = readFileSync(inputs.schedule, "utf8");
    const compiled = compileScheduleArtifact(
      config,
      parseScheduleArtifact(scheduleYaml, inputs.schedule),
      inputs.worktreePath
    );
    await runAndPrintPipeline({
      ...inputs,
      config: compiled.config,
      scheduleArtifact: scheduleYaml,
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
      runId: inputs.runId,
      task: inputs.task,
      worktreePath: inputs.worktreePath,
    });
    console.log(`Schedule generated: ${result.path}`);
    const scheduleYaml = readFileSync(
      resolve(inputs.worktreePath, result.path),
      "utf8"
    );
    const compiled = compileScheduleArtifact(
      config,
      parseScheduleArtifact(scheduleYaml, result.path),
      inputs.worktreePath
    );
    await runAndPrintPipeline({
      ...inputs,
      config: compiled.config,
      scheduleArtifact: scheduleYaml,
      workflow: compiled.workflowId,
    });
    return;
  }

  await runAndPrintPipeline({ ...inputs, config });
}

async function runAndPrintPipeline(
  inputs: RunInputs & { config: PipelineConfig }
): Promise<void> {
  // Resolve the run-control store once via the db.url seam and keep it alive for
  // the whole run (the writer reporters fire callbacks throughout); the scope
  // releases the Postgres connection after the final flush. With db.url absent
  // this is byte-identical to the prior direct filesystem store calls.
  await Effect.runPromise(
    withRunControlStoreScoped(inputs.worktreePath, (store) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: () => runAndPrintPipelineWithStore(inputs, store),
      })
    )
  );
}

async function runAndPrintPipelineWithStore(
  inputs: RunInputs & { config: PipelineConfig },
  store: RunControlStore
): Promise<void> {
  const runner = inputs.pipelineRunner ?? runPipelineFromConfig;
  const terminalReporter = createTerminalRuntimeReporter();
  const runStoreReporter = await createRunStoreReporter(
    inputs,
    terminalReporter,
    store
  );
  if (inputs.supervised) {
    console.log(formatSupervisedRunFollowUp(requireRunId(inputs.runId)));
  }
  let result: Awaited<ReturnType<typeof runPipelineFromConfig>>;
  try {
    result = await runWithFlushedReporter(runStoreReporter.flush, () =>
      runner({
        config: inputs.config,
        reporter: runStoreReporter.reporter,
        entrypoint: inputs.entrypoint,
        runId: inputs.runId,
        task: inputs.task,
        workflowId: inputs.workflow,
        worktreePath: inputs.worktreePath,
      })
    );
  } catch (error) {
    throw runtimeErrorWithFollowUp(error, inputs);
  }
  console.log(formatRuntimeResult(result));
  if (result.outcome !== "PASS") {
    throw new Error(formatRuntimeFailureWithFollowUp(result, inputs));
  }
}

async function runWithFlushedReporter<T>(
  flush: () => Promise<void>,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } finally {
    await flush();
  }
}

async function createLocalRunStoreRuntimeReporter(
  inputs: RunInputs & { config: PipelineConfig },
  reporter: NonNullable<
    Parameters<typeof createRunStoreRuntimeReporter>[0]["reporter"]
  >,
  store: RunControlStore
) {
  const runId = requireRunId(inputs.runId);
  await Effect.runPromise(
    store.createRun({
      ...resolvedRunControlOptions(inputs.runControl),
      nodeIds: plannedRunStoreNodeIds(inputs),
      runId,
      ...(inputs.scheduleArtifact ? { schedule: inputs.scheduleArtifact } : {}),
    })
  );

  return createRunStoreRuntimeReporter({
    reporter,
    runId,
    store,
    workspaceRoot: inputs.worktreePath,
  });
}

function createRunStoreReporter(
  inputs: RunInputs & { config: PipelineConfig },
  reporter: NonNullable<
    Parameters<typeof createRunStoreRuntimeReporter>[0]["reporter"]
  >,
  store: RunControlStore
) {
  if (inputs.runStoreMode === "reuse") {
    const runId = requireRunId(inputs.runId);
    if (inputs.supervisor) {
      const supervisor = createRunControlSupervisor({
        reporter,
        runId,
        store,
        workspaceRoot: inputs.worktreePath,
      });
      supervisor.start();
      return {
        flush: supervisor.stop,
        reporter: supervisor.reporter,
      };
    }
    return createRunStoreRuntimeReporter({
      reporter,
      runId,
      store,
      workspaceRoot: inputs.worktreePath,
    });
  }

  return createLocalRunStoreRuntimeReporter(inputs, reporter, store);
}

function requireRunId(runId: string | undefined): string {
  if (!runId) {
    throw new Error("Run id is required for local run-control persistence.");
  }
  return runId;
}

function resolvedRunControlOptions(
  input: RunControlOptions | undefined
): RequiredRunControlOptions {
  return {
    effort: input?.effort ?? "normal",
    mode: input?.mode ?? "write",
    target: input?.target ?? "local",
  };
}

function plannedRunStoreNodeIds(
  inputs: RunInputs & { config: PipelineConfig }
): string[] {
  if (inputs.pipelineRunner) {
    return [];
  }
  const workflowId = resolveWorkflowSelection(
    inputs.config,
    inputs.workflow,
    inputs.entrypoint
  );
  const plan = compileWorkflowPlan(inputs.config, workflowId);
  // Include parallel children: the runtime reports node sessions/results for
  // each child, and the run-control store rejects unknown node ids — registering
  // only top-level nodes crashes any parallel fan-out the moment a child runs.
  return flattenNodes(plan.topologicalOrder, (node) => node.children).map(
    (node) => node.id
  );
}

function formatSupervisedRunFollowUp(runId: string): string {
  return [
    `Run id: ${runId}`,
    `Status: moka status ${runId}`,
    `Logs: moka logs ${runId}`,
  ].join("\n");
}

function formatDetachedRunFollowUp(runId: string): string {
  return [
    `Run id: ${runId}`,
    `Status: moka status ${runId}`,
    `Logs: moka logs ${runId}`,
    `Stop: moka stop ${runId}`,
  ].join("\n");
}

function formatRuntimeFailureWithFollowUp(
  result: Parameters<typeof formatRuntimeFailure>[0],
  inputs: RunInputs
): string {
  const message = formatRuntimeFailure(result);
  if (!(inputs.supervised && inputs.runId)) {
    return message;
  }

  return [message, "", formatSupervisedRunFollowUp(inputs.runId)].join("\n");
}

function runtimeErrorWithFollowUp(error: unknown, inputs: RunInputs): unknown {
  if (!(inputs.supervised && inputs.runId)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    [message, "", formatSupervisedRunFollowUp(inputs.runId)].join("\n")
  );
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

interface InitFlags {
  check?: boolean;
  dryRun?: boolean;
  force?: boolean;
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

interface RunControllerFlags {
  entrypoint?: string;
  runId: string;
  schedule?: string;
  workflow?: string;
}

export interface CliProgramOptions {
  readonly runCommand?: RunCommand;
  readonly ticketCommand?: TicketCommandOptions;
}

export function createCliProgram(options: CliProgramOptions = {}): Command {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const configuredPipeline = loadConfiguredEntrypoints(cwd);
  const program = new Command();
  program
    .name("moka")
    .description("Submit work to Momokaya")
    .version(readPackageVersion())
    .exitOverride();

  const dispatchResolvedRunCommand: RunCommand = async (call) => {
    await dispatchMokaRunCommand(call, {
      runCommand: options.runCommand,
      runDetached: ({ execution, runControl, task: resolvedTask }) =>
        runDetachedResolvedTask(resolvedTask, execution, runControl),
      runLocal: ({ execution, runControl, task: resolvedTask }) =>
        runLocalResolvedTask(resolvedTask, execution, runControl),
      runRemoteSubmit: async ({ descriptionParts: parts, execution }) => {
        const result = await runMokaSubmitFromCli(
          parts,
          remoteSubmitFlags(execution)
        );
        printMokaSubmitResult(result);
      },
    });
  };

  const runAction = async (descriptionParts: string[], flags: RunFlags) => {
    const task = descriptionParts.join(" ");
    const resolution = resolveMokaRun({ flags, task });
    await dispatchResolvedRunCommand({
      descriptionParts,
      flags,
      resolution,
      task,
    });
  };

  program
    .command("run")
    .description(
      "Primary command: run a workflow from package-owned @oisincoveney/pipeline config"
    )
    .argument("<description...>", "task description")
    .option(
      "--command",
      "treat input after -- as explicit argv for remote submission"
    )
    .option("--entrypoint <entrypoint>", "entrypoint alias from package config")
    .option(
      "--detach",
      "start a supervised controller process in the background"
    )
    .addOption(
      new Option("--effort <effort>", "run effort")
        .choices([...MOKA_RUN_EFFORTS])
        .default("normal")
    )
    .option("--read-only", "run the read-only inspect workflow")
    .option("--schedule <schedule>", "approved schedule YAML to execute")
    .addOption(
      new Option("--target <target>", "execution target")
        .choices([...MOKA_RUN_TARGETS])
        .default("local")
    )
    .option("--workflow <workflow>", "workflow id from package config")
    .action(runAction);

  program
    .command("run-controller", { hidden: true })
    .description("Internal detached run controller")
    .argument("<description...>", "task description")
    .requiredOption("--run-id <run-id>", "existing run id to supervise")
    .option("--entrypoint <entrypoint>", "entrypoint alias from package config")
    .option("--schedule <schedule>", "approved schedule YAML to execute")
    .option("--workflow <workflow>", "workflow id from package config")
    .action(async (descriptionParts: string[], flags: RunControllerFlags) => {
      await execute(descriptionParts.join(" "), {
        entrypoint: flags.entrypoint,
        runId: flags.runId,
        runStoreMode: "reuse",
        schedule: flags.schedule,
        supervised: true,
        supervisor: true,
        workflow: flags.workflow,
      });
    });

  registerRunControlCommands(program);

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
    .option("--json", "print machine-readable readiness results")
    .option("--kube-context <context>", "kubectl context for cluster checks")
    .option("--kubeconfig <path>", "kubeconfig path for cluster checks")
    .action(async (flags: DoctorFlags) => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const result = await runDoctorChecks(cwd, flags);
      console.log(
        flags.json ? JSON.stringify(result) : formatDoctorResult(result)
      );
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
      "Install or refresh package-owned pipeline support: per-machine harness (skills + slash-command adapters + agent hooks + global instruction files) installed globally to ~/.claude, ~/.config/opencode, ~/.codex with no repo-local config"
    )
    .option("--check", "verify the generated harness is current; fail if stale")
    .option("--dry-run", "show planned changes without writing files")
    .option("--force", "overwrite manually edited harness files")
    .action(async (flags: InitFlags) => {
      const result = await initPipelineProject({
        ...flags,
        cwd: process.env.PIPELINE_TARGET_PATH ?? process.cwd(),
      });
      console.log(
        formatPipelineInitResult(result, {
          check: flags.check,
          dryRun: flags.dryRun,
        })
      );
    });

  const codexAuthCommand = program
    .command("codex-auth")
    .description("Manage local Codex broker auth integration");

  codexAuthCommand
    .command("sync-local")
    .description(
      "Point local dev repos' opencode openai provider at the central CLIProxyAPI broker"
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
      .description("Submit work to Momokaya as an Argo Workflow.")
      .argument(
        "[input...]",
        "task description, or command argv with --command"
      )
  ).action(async (input: string[], flags: MokaSubmitFlags) => {
    const result = await runMokaSubmitFromCli(input, flags);
    printMokaSubmitResult(result);
  });

  registerLoopCommand(program);
  registerRunnerCommandCommand(program);
  registerBenchCommand(program);
  registerTicketCommand(program, {
    ...options.ticketCommand,
    runCommand: options.ticketCommand?.runCommand ?? dispatchResolvedRunCommand,
  });

  const configuredEntrypointCommands = registerConfiguredEntrypointCommands(
    program,
    compatibilityPresetDescriptions(configuredPipeline),
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

interface LoopControllerEntrypointFlags {
  maxRemediationAttempts?: string;
  mergeTimeout?: string;
  payloadFile: string;
  root?: string;
  strategy?: string;
}

/**
 * Register `moka loop` (submit the cloud controller) and the hidden
 * `moka loop-controller` (the in-cluster process that drives the loop). The
 * public command validates the backlog and submits; a cyclic or empty backlog
 * refuses to start with a non-zero exit.
 */
function registerLoopCommand(program: Command): void {
  program
    .command("loop")
    .description(
      "Submit a long-running cloud controller that drains the backlog ticket-by-ticket"
    )
    .addOption(
      new Option("--strategy <strategy>", "ready-ticket selection strategy")
        .choices(["priority", "bfs", "dfs"])
        .default("priority")
    )
    .option("--root <epic-id>", "restrict traversal to this epic subtree")
    .option(
      "--max-remediation-attempts <n>",
      "bounded fix-up submits before a PR is declared blocked"
    )
    .option(
      "--merge-timeout <n>",
      "bounded merge polls before an indeterminate PR is declared blocked"
    )
    .action(async (options: LoopCommandOptions) => {
      const result = await runLoopSubmit(buildLoopSubmitInput(options));
      console.log(
        `Loop controller submitted: ${result.workflowName} in ${result.namespace}`
      );
    });

  program
    .command("loop-controller", { hidden: true })
    .description("Internal in-cluster loop controller process")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .addOption(
      new Option("--strategy <strategy>", "ready-ticket selection strategy")
        .choices(["priority", "bfs", "dfs"])
        .default("priority")
    )
    .option("--root <epic-id>", "restrict traversal to this epic subtree")
    .option("--max-remediation-attempts <n>", "bounded fix-up submits")
    .option("--merge-timeout <n>", "bounded merge polls")
    .action(async (flags: LoopControllerEntrypointFlags) => {
      await runLoopControllerEntrypoint({
        flags: parseLoopFlags(flags),
        payloadFile: flags.payloadFile,
        worktreePath: process.env.PIPELINE_TARGET_PATH ?? process.cwd(),
      });
    });
}

function buildLoopSubmitInput(
  options: LoopCommandOptions
): Parameters<typeof runLoopSubmit>[0] {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const config = loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });
  const globalConfig = loadMokaGlobalConfig();
  const momokaya: MokaGlobalConfig["momokaya"] | undefined =
    globalConfig?.momokaya;
  const brokerAuth = momokaya?.submit.brokerAuth;
  if (!brokerAuth) {
    throw new Error(
      "momokaya.submit.brokerAuth is required for moka loop submit"
    );
  }
  return {
    brokerAuth,
    config,
    eventUrl: momokaya?.submit.eventUrl,
    flags: parseLoopFlags(options),
    gitCredentialsSecretName: momokaya?.submit.gitCredentialsSecretName,
    githubAuthSecretName: momokaya?.submit.githubAuthSecretName,
    kubeconfigPath: momokaya?.kubernetes.kubeconfig,
    namespace: momokaya?.kubernetes.namespace,
    serviceAccountName: momokaya?.submit.serviceAccountName,
    worktreePath: cwd,
  };
}

function runLocalResolvedTask(
  task: string,
  execution: LocalRuntimeExecution,
  runControl: RunControlOptions
): Promise<void> {
  return execute(task, {
    entrypoint: execution.entrypoint,
    runControl,
    schedule: execution.schedule,
    supervised: true,
    workflow: execution.workflow,
  });
}

async function runDetachedResolvedTask(
  task: string,
  execution: LocalRuntimeExecution,
  runControl: RunControlOptions
): Promise<void> {
  const worktreePath = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const runId = generateRuntimeRunId();
  const config = loadPipelineConfig(worktreePath, {
    allowMissingLintFileReferences: true,
  });
  const prepared = await prepareDetachedRun({
    config,
    execution,
    runId,
    task,
    worktreePath,
  });

  // Resolve the run-control store once via the db.url seam: createRun seeds the
  // manifest and updateRunController records the detached controller, both
  // through the store; the scope releases the Postgres connection afterwards.
  await Effect.runPromise(
    withRunControlStoreScoped(worktreePath, (store) =>
      Effect.gen(function* () {
        yield* store.createRun({
          ...resolvedRunControlOptions(runControl),
          nodeIds: plannedRunStoreNodeIds({
            config: prepared.config,
            entrypoint: prepared.entrypoint,
            runId,
            runControl,
            schedule: prepared.schedule,
            task,
            workflow: prepared.workflow,
            worktreePath,
          }),
          runId,
          ...(prepared.scheduleArtifact
            ? { schedule: prepared.scheduleArtifact }
            : {}),
        });

        const launch = yield* Effect.tryPromise({
          catch: (error) => error,
          try: () =>
            startDetachedRunController({
              entrypoint: prepared.entrypoint,
              runId,
              schedule: prepared.schedule,
              task,
              workflow: prepared.workflow,
              workspaceRoot: worktreePath,
            }),
        });
        yield* store.updateRunController({
          controller: {
            argv: launch.argv,
            cwd: worktreePath,
            paths: store.statusPaths({ runId }),
            pid: launch.pid,
            startedAt: launch.startedAt,
          },
          runId,
        });
      })
    )
  );
  console.log(formatDetachedRunFollowUp(runId));
}

interface PrepareDetachedRunInput {
  config: PipelineConfig;
  execution: LocalRuntimeExecution;
  runId: string;
  task: string;
  worktreePath: string;
}

interface PreparedDetachedRun {
  config: PipelineConfig;
  entrypoint?: string;
  schedule?: string;
  // PIPE-91.16: serialized schedule artifact persisted at createRun for resume.
  scheduleArtifact?: string;
  workflow?: string;
}

async function prepareDetachedRun(
  input: PrepareDetachedRunInput
): Promise<PreparedDetachedRun> {
  if (input.execution.schedule) {
    const schedule = resolve(input.execution.schedule);
    const scheduleYaml = readFileSync(schedule, "utf8");
    const compiled = compileScheduleArtifact(
      input.config,
      parseScheduleArtifact(scheduleYaml, schedule),
      input.worktreePath
    );
    return {
      config: compiled.config,
      schedule,
      scheduleArtifact: scheduleYaml,
      workflow: compiled.workflowId,
    };
  }

  const scheduledEntrypoint = scheduledEntrypointId(
    input.config,
    input.execution.workflow,
    input.execution.entrypoint
  );
  if (!scheduledEntrypoint) {
    return {
      config: input.config,
      entrypoint: input.execution.entrypoint,
      workflow: input.execution.workflow,
    };
  }

  const result = await generateScheduleArtifact({
    config: input.config,
    entrypointId: scheduledEntrypoint,
    runId: input.runId,
    task: input.task,
    worktreePath: input.worktreePath,
  });
  console.log(`Schedule generated: ${result.path}`);
  const schedule = resolve(input.worktreePath, result.path);
  const scheduleYaml = readFileSync(schedule, "utf8");
  const compiled = compileScheduleArtifact(
    input.config,
    parseScheduleArtifact(scheduleYaml, result.path),
    input.worktreePath
  );
  return {
    config: compiled.config,
    schedule,
    scheduleArtifact: scheduleYaml,
    workflow: compiled.workflowId,
  };
}

function remoteSubmitFlags(execution: RemoteSubmitExecution): MokaSubmitFlags {
  return {
    command: execution.command,
    quick: execution.mode === "quick",
    schedule: execution.schedule,
  };
}

function printMokaSubmitResult(
  result: Awaited<ReturnType<typeof runMokaSubmitFromCli>>
): void {
  console.log(
    `Workflow submitted: ${result.workflowName} in ${result.namespace}`
  );
  if (result.workflowUid) {
    console.log(`Workflow UID: ${result.workflowUid}`);
  }
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

function compatibilityPresetDescriptions(
  config: PipelineConfig
): PipelineConfig {
  const descriptions: Record<string, string> = {
    execute:
      "Compatibility preset for `moka run --effort thorough`: full planner-generated pipeline for repository work",
    inspect:
      "Compatibility preset for `moka run --read-only`: read-only repository inspection",
    quick:
      "Compatibility preset for `moka run --effort quick`: compact planner-generated pipeline for small work",
  };
  return {
    ...config,
    entrypoints: Object.fromEntries(
      Object.entries(config.entrypoints).map(([id, entrypoint]) => [
        id,
        descriptions[id]
          ? { ...entrypoint, description: descriptions[id] }
          : entrypoint,
      ])
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

// The single Effect entry for the CLI: parseAsync runs inside Effect.tryPromise
// so the process boundary in index.ts can run it through one
// Effect.runPromiseExit / Exit.match and map failures to exit codes. runCli
// stays a plain Promise facade for tests + the public API (its raw rejection
// behaviour is relied on).
export function runCliEffect(argv: string[]): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => createCliProgram().parseAsync(argv, { from: "node" }),
  }).pipe(Effect.asVoid);
}

export async function runCli(argv: string[]): Promise<void> {
  const program = createCliProgram();
  await program.parseAsync(argv, { from: "node" });
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
