import { readFileSync } from "node:fs";

import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { createBenchCommand } from "../commands/bench-command";
import { createConfiguredEntrypointCommands } from "../commands/pipeline-command";
import { createRunnerCommandCommands } from "../commands/runner-command-command";
import { createTicketCommand } from "../commands/ticket-command";
import type { TicketCommandOptions } from "../commands/ticket-command";
import { loadPipelineConfig } from "../config";
import type { PipelineConfig } from "../config";
import { createRunControlCommands } from "../run-control/commands";
import { createBootstrapCommands } from "./bootstrap-commands";
import {
  encodeLiteralCliArg,
  expandValueOptionalFlags,
  literalArgFlagName,
} from "./cli-args";
import { mokaCliRuntimeLayer } from "./cli-runtime";
import { createFactoryCommands } from "./factory-commands";
import { createLoopCommands } from "./loop-commands";
import { createMcpGatewayCommand } from "./mcp-gateway-commands";
import { createPlanCommands } from "./plan-commands";
import type { RunCommand } from "./run-command";
import { createRunCommands, printMokaSubmitResult } from "./run-commands";
import { execute } from "./run-service";
import {
  mokaSubmitCliConfig,
  normalizeMokaSubmitCliInput,
  runMokaSubmitFromCli,
} from "./submit-options";

export interface CliProgramOptions {
  readonly runCommand?: RunCommand;
  readonly ticketCommand?: TicketCommandOptions;
}

const valueOptionalFlags = new Set(["cluster"]);
const commandModeCommands = new Set(["run", "submit"]);

const createSubmitCommand = () =>
  Command.make("submit", mokaSubmitCliConfig, (parsed) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        const { flags, input } = normalizeMokaSubmitCliInput(parsed);
        const result = await runMokaSubmitFromCli(input, flags);
        printMokaSubmitResult(result);
      },
    })
  ).pipe(
    Command.withDescription("Submit work to Momokaya as an Argo Workflow.")
  );

const runEntrypointCommand = async (
  entrypoint: string,
  task: string
): Promise<void> => {
  await execute(task, { entrypoint });
};

const isPackageVersionRecord = (value: unknown): value is { version: string } =>
  typeof value === "object" &&
  value !== null &&
  "version" in value &&
  typeof value.version === "string";

const readPackageVersion = (): string => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
  );
  if (!isPackageVersionRecord(packageJson)) {
    throw new Error("Unable to read @oisincoveney/pipeline package version.");
  }
  return packageJson.version;
};

const loadConfiguredEntrypoints = (cwd: string): PipelineConfig =>
  loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });

const createApplicationCommands = (options: CliProgramOptions) => {
  const runCommands = createRunCommands({
    runCommand: options.runCommand,
  });
  return {
    commands: [
      ...runCommands.commands,
      ...createRunControlCommands(),
      ...createPlanCommands(),
      ...createBootstrapCommands(),
      createMcpGatewayCommand(),
      createSubmitCommand(),
      ...createLoopCommands(),
      ...createFactoryCommands(),
      ...createRunnerCommandCommands(),
      createBenchCommand(),
      createTicketCommand({
        ...options.ticketCommand,
        runCommand: options.ticketCommand?.runCommand ?? runCommands.runCommand,
      }),
    ],
    runCommand: runCommands.runCommand,
  };
};

export const createCliCommand = (options: CliProgramOptions = {}) => {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const configuredPipeline = loadConfiguredEntrypoints(cwd);
  const application = createApplicationCommands(options);
  const reservedCommands = new Set(
    application.commands.map((command) => command.name)
  );
  const configured = createConfiguredEntrypointCommands(
    configuredPipeline,
    runEntrypointCommand,
    reservedCommands
  );

  return Command.make("moka").pipe(
    Command.withDescription("Submit work to Momokaya"),
    Command.withSubcommands([...application.commands, ...configured.commands])
  );
};

export const createCliProgram = createCliCommand;

const hasCommandModeFlag = (argv: readonly string[]): boolean =>
  argv.some((arg) => arg === "--command" || arg === "--command=true");

const preserveTrailingCommandArgs = (argv: readonly string[]): string[] => {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1) {
    return [...argv];
  }

  const beforeSeparator = argv.slice(0, separatorIndex);
  const [commandName] = beforeSeparator;
  if (
    commandName === undefined ||
    !commandModeCommands.has(commandName) ||
    !hasCommandModeFlag(beforeSeparator)
  ) {
    return [...argv];
  }

  return [
    ...beforeSeparator,
    ...argv
      .slice(separatorIndex + 1)
      .map((arg) => `--${literalArgFlagName}=${encodeLiteralCliArg(arg)}`),
  ];
};

const normalizeCliArgs = (argv: readonly string[]): string[] =>
  expandValueOptionalFlags(
    preserveTrailingCommandArgs(argv.slice(2)),
    valueOptionalFlags
  );

export const runCliEffect = (
  argv: string[],
  options: CliProgramOptions = {}
): Effect.Effect<void, unknown> =>
  Command.runWith(createCliCommand(options), {
    version: readPackageVersion(),
  })(normalizeCliArgs(argv)).pipe(Effect.provide(mokaCliRuntimeLayer));

export const runCli = async (
  argv: string[],
  options: CliProgramOptions = {}
): Promise<void> => {
  await Effect.runPromise(runCliEffect(argv, options));
};
