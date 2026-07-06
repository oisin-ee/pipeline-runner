import { readFileSync } from "node:fs";

import { Command, Help } from "commander";
import { Effect } from "effect";

import { registerBenchCommand } from "../commands/bench-command";
import { registerConfiguredEntrypointCommands } from "../commands/pipeline-command";
import { registerRunnerCommandCommand } from "../commands/runner-command-command";
import { registerTicketCommand } from "../commands/ticket-command";
import type { TicketCommandOptions } from "../commands/ticket-command";
import { loadPipelineConfig } from "../config";
import type { PipelineConfig } from "../config";
import { registerRunControlCommands } from "../run-control/commands";
import { registerBootstrapCommands } from "./bootstrap-commands";
import { registerFactoryCommands } from "./factory-commands";
import { registerLoopCommand } from "./loop-commands";
import { registerMcpGatewayCommands } from "./mcp-gateway-commands";
import { registerPlanCommands } from "./plan-commands";
import type { RunCommand } from "./run-command";
import { printMokaSubmitResult, registerRunCommands } from "./run-commands";
import { execute } from "./run-service";
import { addMokaSubmitOptions, runMokaSubmitFromCli } from "./submit-options";
import type { MokaSubmitFlags } from "./submit-options";

export interface CliProgramOptions {
  readonly runCommand?: RunCommand;
  readonly ticketCommand?: TicketCommandOptions;
}

const registerSubmitCommand = (program: Command): void => {
  addMokaSubmitOptions(
    program
      .command("submit")
      .description("Submit work to Momokaya as an Argo Workflow.")
      .argument("[input...]", "task description, or command argv with --command"),
  ).action(async (input: string[], flags: MokaSubmitFlags) => {
    const result = await runMokaSubmitFromCli(input, flags);
    printMokaSubmitResult(result);
  });
};

const registerApplicationCommands = (program: Command, options: CliProgramOptions): void => {
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
};

const configureEntrypointHelp = (program: Command, configuredEntrypointCommands: Set<string>): void => {
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
};

const runEntrypointCommand = async (entrypoint: string, task: string): Promise<void> => {
  await execute(task, { entrypoint });
};

const registerEntrypointCommands = (program: Command, configuredPipeline: PipelineConfig): void => {
  const configuredEntrypointCommands = registerConfiguredEntrypointCommands(
    program,
    configuredPipeline,
    runEntrypointCommand,
  );
  configureEntrypointHelp(program, configuredEntrypointCommands);
};

const isPackageVersionRecord = (value: unknown): value is { version: string } =>
  typeof value === "object" && value !== null && "version" in value && typeof value.version === "string";

const readPackageVersion = (): string => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
  if (!isPackageVersionRecord(packageJson)) {
    throw new Error("Unable to read @oisincoveney/pipeline package version.");
  }
  return packageJson.version;
};

const createBaseProgram = (): Command =>
  new Command().name("moka").description("Submit work to Momokaya").version(readPackageVersion()).exitOverride();

const loadConfiguredEntrypoints = (cwd: string): PipelineConfig =>
  loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });

export const createCliProgram = (options: CliProgramOptions = {}): Command => {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const configuredPipeline = loadConfiguredEntrypoints(cwd);
  const program = createBaseProgram();

  registerApplicationCommands(program, options);
  registerEntrypointCommands(program, configuredPipeline);

  return program;
};

export const runCliEffect = (argv: string[]): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await createCliProgram().parseAsync(argv, { from: "node" }),
  }).pipe(Effect.asVoid);

export const runCli = async (argv: string[]): Promise<void> => {
  const program = createCliProgram();
  await program.parseAsync(argv, { from: "node" });
};
