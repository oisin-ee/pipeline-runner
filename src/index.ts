#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";
import { execa } from "execa";
import {
  type CommandHostSelection,
  formatInstallCommandsResult,
  installCommands,
  parseCommandHost,
} from "./install-commands.js";
import {
  applyPhaseLifecycle,
  createSwarmTasks,
  markPhase,
  type PipelineLifecycleResult,
} from "./mastra/backlog.js";
import { parseTicketAndDescription } from "./mastra/config.js";
import {
  type PipelinePrimitiveInput,
  runPipelinePrimitive,
} from "./mastra/pipeline-primitive.js";
import { hardAgentAdapter } from "./mastra/runner.js";

const SUPPORTED_HARNESSES = ["claude", "codex", "opencode", "pi"] as const;
const DEFAULT_HARNESS: PipelineHarness = "codex";
const PATH_SEPARATOR_RE = /[\\/]/;
type PipelineHarness = (typeof SUPPORTED_HARNESSES)[number];

function parseHarnessFlag(value: string): PipelineHarness {
  if (SUPPORTED_HARNESSES.includes(value as PipelineHarness)) {
    return value as PipelineHarness;
  }
  throw new Error(
    `Unsupported --harness "${value}". Supported values: ${SUPPORTED_HARNESSES.join(", ")}.`
  );
}

interface PipeOptions {
  /** Harness binary to dispatch (claude | codex | opencode | pi). Default `codex`. */
  harness?: PipelineHarness;
  /** Override the strict-mode pipeline runner (used by tests). */
  pipelineRunner?: (
    input: PipelinePrimitiveInput
  ) => Promise<PipelineLifecycleResult>;
  /** Override the soft-mode interactive spawn (used by tests). */
  spawnInteractive?: (
    command: string,
    args: string[],
    options: { cwd: string }
  ) => Promise<{ exitCode: number }>;
  /** If true, dispatch the deterministic Mastra workflow per phase via specialized profiles. */
  strict?: boolean;
}

/**
 * `pipe` entrypoint. Two modes:
 *
 * - **soft** (default): spawn `orchestrator <harness>` interactively with an
 *   initial prompt that asks the orchestrator to drive phases via native
 *   subagent delegation. User can interrupt.
 * - **strict** (`--strict`): run the Mastra workflow with `hardAgentAdapter`;
 *   per phase, dispatch a subprocess with the role-specific specialized
 *   profile applied (researcher / frontend / backend / verifier).
 */
export function pipe(
  description: string,
  options: PipeOptions = {}
): Promise<void> {
  try {
    if (!description.trim()) {
      throw new Error("Task description is required");
    }

    const harness = options.harness ?? DEFAULT_HARNESS;
    const worktreePath = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
    const { ticketId, description: trimmedDescription } =
      parseTicketAndDescription(description);

    if (options.strict) {
      return runStrict({
        ticketId,
        task: description,
        harness,
        worktreePath,
        pipelineRunner: options.pipelineRunner,
      });
    }

    return runSoft({
      ticketId,
      task: description,
      trimmedDescription,
      harness,
      worktreePath,
      spawnInteractive: options.spawnInteractive,
    });
  } catch (err) {
    return Promise.reject(err as Error);
  }
}

interface RunInputs {
  harness: PipelineHarness;
  task: string;
  ticketId: string | null;
  worktreePath: string;
}

async function runSoft(
  inputs: RunInputs & {
    trimmedDescription: string;
    spawnInteractive?: PipeOptions["spawnInteractive"];
  }
): Promise<void> {
  const { harness, worktreePath, ticketId, trimmedDescription } = inputs;
  const ticketLabel = ticketId ?? "(no ticket id detected)";
  const initialPrompt =
    `Run the oisin-pipeline for ticket ${ticketLabel}.\n\n` +
    `Task description: ${trimmedDescription}\n\n` +
    "Drive the phases (research → RED → GREEN → VERIFY → LEARN) by " +
    "delegating each to the appropriate subagent via the Task tool. " +
    "Follow your orchestrator rules. Pause if I interrupt.";

  console.log(`Starting interactive orchestrator session for: ${inputs.task}`);

  const spawn =
    inputs.spawnInteractive ??
    (async (command: string, args: string[], opts: { cwd: string }) => {
      const result = await execa(command, args, {
        cwd: opts.cwd,
        stdio: "inherit",
      });
      return { exitCode: result.exitCode ?? 0 };
    });

  const { exitCode } = await spawn("orchestrator", [harness, initialPrompt], {
    cwd: worktreePath,
  });

  if (exitCode !== 0) {
    throw Object.assign(
      new Error(`orchestrator ${harness} exited with code ${exitCode}`),
      { exitCode }
    );
  }
}

async function runStrict(
  inputs: RunInputs & {
    pipelineRunner?: PipeOptions["pipelineRunner"];
  }
): Promise<void> {
  const { harness, worktreePath, ticketId, task } = inputs;
  const runner =
    inputs.pipelineRunner ??
    ((input: PipelinePrimitiveInput) =>
      runPipelinePrimitive(input, { agentAdapter: hardAgentAdapter }));

  const swarm = await createSwarmTasks(task, worktreePath);

  console.log(`Starting pipeline (--strict) for: ${task}`);
  await markPhase(swarm.phases.R, "In Progress", worktreePath);

  let pipelineResult: PipelineLifecycleResult;
  try {
    pipelineResult = await runner({
      harness,
      task,
      worktreePath,
      ticketId,
    });
  } catch (err) {
    await applyPhaseLifecycle(
      swarm,
      { outcome: "FAIL", failureDetails: [] },
      worktreePath,
      { alreadyStarted: ["R"] }
    );
    throw err;
  }

  await applyPhaseLifecycle(swarm, pipelineResult, worktreePath, {
    alreadyStarted: ["R"],
  });
  console.log(`Pipeline complete: ${pipelineResult.outcome}`);
}

interface InstallCommandFlags {
  check?: boolean;
  dryRun?: boolean;
  force?: boolean;
  host?: CommandHostSelection;
}

export function createCliProgram(): Command {
  const program = new Command();
  program
    .name("@oisincoveney/pipeline")
    .description("Run and install the oisin pipeline")
    .exitOverride();

  program
    .command("pipe")
    .description("Run the oisin-pipeline for a task")
    .argument("<description...>", "ticket id or task description")
    .option(
      "--strict",
      "run the deterministic headless pipeline instead of the interactive orchestrator",
      false
    )
    .addOption(
      new Option(
        "--harness <harness>",
        "harness binary to dispatch (claude | codex | opencode | pi)"
      )
        .choices([...SUPPORTED_HARNESSES])
        .default(DEFAULT_HARNESS)
        .argParser(parseHarnessFlag)
    )
    .action(
      async (
        descriptionParts: string[],
        flags: { strict?: boolean; harness?: PipelineHarness }
      ) => {
        await pipe(descriptionParts.join(" "), {
          strict: flags.strict ?? false,
          harness: flags.harness ?? DEFAULT_HARNESS,
        });
      }
    );

  program
    .command("install-commands")
    .description(
      "Install generated slash-command adapters into this repository"
    )
    .addOption(
      new Option("--host <host>", "host command set to install")
        .choices(["all", "claude", "opencode", "codex", "pi"])
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
  if (scriptName === "pipe" || scriptName === "work-next") {
    await program.parseAsync(
      [argv[0] ?? "node", argv[1] ?? "pipe", "pipe", ...argv.slice(2)],
      { from: "node" }
    );
    return;
  }
  await program.parseAsync(argv, { from: "node" });
}

function scriptName(argv: string[]): string {
  return argv[1]?.split(PATH_SEPARATOR_RE).pop() ?? "";
}

function isCliEntrypoint(argv: string[]): boolean {
  const name = scriptName(argv);
  return (
    argv[1] === fileURLToPath(import.meta.url) ||
    name === "pipe" ||
    name === "work-next" ||
    name === "oisin-pipeline"
  );
}

if (isCliEntrypoint(process.argv)) {
  runCli(process.argv).catch((err: unknown) => {
    if (err instanceof CommanderError) {
      process.exit(err.exitCode);
    }
    if (err instanceof Error) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(String(err));
    process.exit(1);
  });
}
