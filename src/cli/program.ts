import { readFileSync } from "node:fs";
import { Command, Help } from "commander";
import { Effect } from "effect";
import { registerBenchCommand } from "../commands/bench-command";
import { registerConfiguredEntrypointCommands } from "../commands/pipeline-command";
import { registerRunnerCommandCommand } from "../commands/runner-command-command";
import {
  registerTicketCommand,
  type TicketCommandOptions,
} from "../commands/ticket-command";
import { loadPipelineConfig, type PipelineConfig } from "../config";
import { registerRunControlCommands } from "../run-control/commands";
import { registerBootstrapCommands } from "./bootstrap-commands";
import { registerFactoryCommands } from "./factory-commands";
import { registerLoopCommand } from "./loop-commands";
import { registerMcpGatewayCommands } from "./mcp-gateway-commands";
import { registerPlanCommands } from "./plan-commands";
import type { RunCommand } from "./run-command";
import { printMokaSubmitResult, registerRunCommands } from "./run-commands";
import { execute } from "./run-service";
import {
  addMokaSubmitOptions,
  type MokaSubmitFlags,
  runMokaSubmitFromCli,
} from "./submit-options";

export interface CliProgramOptions {
  readonly runCommand?: RunCommand;
  readonly ticketCommand?: TicketCommandOptions;
}

export function createCliProgram(options: CliProgramOptions = {}): Command {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const configuredPipeline = loadConfiguredEntrypoints(cwd);
  const program = createBaseProgram();

  registerApplicationCommands(program, options);
  registerEntrypointCommands(program, configuredPipeline);

  return program;
}

function createBaseProgram(): Command {
  return new Command()
    .name("moka")
    .description("Submit work to Momokaya")
    .version(readPackageVersion())
    .exitOverride();
}

function registerApplicationCommands(
  program: Command,
  options: CliProgramOptions
): void {
  const dispatchResolvedRunCommand = registerRunCommands(program, {
    runCommand: options.runCommand,
  });
  registerRunControlCommands(program);
  registerPlanCommands(program);
  registerBootstrapCommands(program);
  registerMcpGatewayCommands(program);
  registerSubmitCommand(program);
  registerLoopCommand(program);
  registerFactoryCommands(program);
  registerRunnerCommandCommand(program);
  registerBenchCommand(program);
  registerTicketCommand(program, {
    ...options.ticketCommand,
    runCommand: options.ticketCommand?.runCommand ?? dispatchResolvedRunCommand,
  });
}

function registerSubmitCommand(program: Command): void {
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
}

function registerEntrypointCommands(
  program: Command,
  configuredPipeline: PipelineConfig
): void {
  const configuredEntrypointCommands = registerConfiguredEntrypointCommands(
    program,
    configuredPipeline,
    runEntrypointCommand
  );
  configureEntrypointHelp(program, configuredEntrypointCommands);
}

function configureEntrypointHelp(
  program: Command,
  configuredEntrypointCommands: Set<string>
): void {
  if (configuredEntrypointCommands.size === 0) {
    return;
  }
  program.configureHelp({
    subcommandTerm(this: Help, command: Command) {
      if (configuredEntrypointCommands.has(command.name())) {
        return command.name();
      }
      return Help.prototype.subcommandTerm.call(this, command);
    },
  });
}

function runEntrypointCommand(entrypoint: string, task: string): Promise<void> {
  return execute(task, { entrypoint });
}

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  );
  if (!isPackageVersionRecord(packageJson)) {
    throw new Error("Unable to read @oisincoveney/pipeline package version.");
  }
  return packageJson.version;
}

function isPackageVersionRecord(value: unknown): value is { version: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string"
  );
}

function loadConfiguredEntrypoints(cwd: string): PipelineConfig {
  return loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });
}

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
