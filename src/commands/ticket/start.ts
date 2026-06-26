import { type Command, Option } from "commander";
import { Effect } from "effect";
import type { RunCommand } from "../../cli/run-command";
import {
  MOKA_RUN_EFFORTS,
  MOKA_RUN_TARGETS,
  type MokaRunEffort,
  type MokaRunTarget,
  type RunResolverFlags,
  resolveMokaRun,
} from "../../cli/run-resolver";
import type { BacklogService } from "../../runtime/services/backlog-service";
import { BacklogServiceLive } from "../../runtime/services/backlog-service";
import type { RepoIoService } from "../../runtime/services/repo-io-service";
import type { BacklogTaskRecord } from "../../tickets/backlog-task-store";
import { selectNextTicket } from "../../tickets/ticket-selection";
import type { TicketCommandOptions } from "./shared";
import {
  claimTicketEffect,
  currentWorktreePath,
  errorMessage,
  formatNextTicket,
  loadTicketSelectionEffect,
  readyTicketEffect,
  runTicketProgramWithBacklog,
  TicketCommandError,
  writeLineEffect,
} from "./shared";

interface TicketStartFlags {
  dryRun?: boolean;
  effort?: MokaRunEffort;
  includeParents?: boolean;
  readOnly?: boolean;
  root?: string;
  strategy?: string;
  target?: MokaRunTarget;
}

interface TicketRunDescriptor {
  readonly task: string;
  readonly ticketId: string;
}

const BACKLOG_STATUS_DIRECTIVE = `\
## Backlog ticket management

Your first action must be to set this ticket to "In Progress":
  backlog task edit <TICKET_ID> --status "In Progress" --plain

Your final action on completion must be to set this ticket to "Done" and update \
its acceptance criteria through the backlog tools:
  backlog task edit <TICKET_ID> --status "Done" --plain

Use backlog tools on your working branch. Do not hand-edit the task markdown file.`;

function ticketRunTask(ticket: BacklogTaskRecord): TicketRunDescriptor {
  const title = formatNextTicket(ticket);
  const description = ticket.description?.trim();
  const body = description ? `${title}\n\n${description}` : title;
  const directive = BACKLOG_STATUS_DIRECTIVE.replaceAll(
    "<TICKET_ID>",
    ticket.id
  );
  const task = `${body}\n\n${directive}`;
  return { task, ticketId: ticket.id };
}

function validateTicketStartFlagsEffect(
  flags: TicketStartFlags
): Effect.Effect<void, TicketCommandError> {
  return flags.readOnly && flags.target === "remote"
    ? Effect.fail(
        new TicketCommandError({
          message:
            "moka ticket start --read-only cannot be combined with --target remote.",
        })
      )
    : Effect.void;
}

function ticketStartRunFlags(flags: TicketStartFlags): RunResolverFlags {
  return {
    effort: flags.effort ?? "normal",
    readOnly: flags.readOnly,
    target: flags.target ?? "local",
  };
}

function ticketStartRunFlagsEffect(
  flags: TicketStartFlags
): Effect.Effect<RunResolverFlags, TicketCommandError> {
  return Effect.gen(function* () {
    yield* validateTicketStartFlagsEffect(flags);
    return ticketStartRunFlags(flags);
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatTicketStartDryRun(
  flags: RunResolverFlags,
  task: string
): string {
  return [
    "moka run",
    `--effort ${flags.effort ?? "normal"}`,
    `--target ${flags.target ?? "local"}`,
    flags.readOnly ? "--read-only" : "",
    shellQuote(task),
  ]
    .filter(Boolean)
    .join(" ");
}

function startTicketEffect(
  worktreePath: string,
  flags: TicketStartFlags,
  runCommand: RunCommand | undefined
): Effect.Effect<void, unknown, RepoIoService | BacklogService> {
  return Effect.gen(function* () {
    const { loaded, selectionOptions } = yield* loadTicketSelectionEffect(
      worktreePath,
      flags
    );
    const selected = yield* readyTicketEffect(
      selectNextTicket(loaded.graph, selectionOptions)
    );

    const { task, ticketId } = ticketRunTask(selected);
    const descriptionParts = [task];
    const runFlags = yield* ticketStartRunFlagsEffect(flags);
    const resolution = yield* Effect.try({
      catch: (error) =>
        new TicketCommandError({
          message: `Could not resolve moka run for ticket '${selected.id}': ${errorMessage(error)}`,
        }),
      try: () => resolveMokaRun({ flags: runFlags, task }),
    });

    yield* writeLineEffect(`Selected ticket: ${formatNextTicket(selected)}`);
    if (flags.dryRun) {
      yield* writeLineEffect(formatTicketStartDryRun(runFlags, task));
      return;
    }
    if (!runCommand) {
      return yield* Effect.fail(
        new TicketCommandError({
          message: "Could not start moka run: no run dispatcher configured.",
        })
      );
    }

    yield* claimTicketEffect(worktreePath, selected);
    yield* Effect.tryPromise({
      catch: (error) =>
        new TicketCommandError({
          message: `Could not start moka run for ticket '${selected.id}': ${errorMessage(error)}`,
        }),
      try: async () => {
        await runCommand({
          descriptionParts,
          flags: runFlags,
          resolution,
          task,
          ticketId,
        });
      },
    });
  });
}

export function registerStartSubcommand(
  ticketCommand: Command,
  options: TicketCommandOptions
): void {
  ticketCommand
    .command("start")
    .description("Claim the next ready Backlog ticket and run moka")
    .option("--root <ticket-id>", "select from one ticket tree")
    .option("--include-parents", "allow parent tickets in selection results")
    .option(
      "--strategy <strategy>",
      "selection strategy: priority, bfs, or dfs"
    )
    .option("--dry-run", "print the selected moka run command without claiming")
    .addOption(
      new Option("--effort <effort>", "run effort")
        .choices([...MOKA_RUN_EFFORTS])
        .default("normal")
    )
    .addOption(
      new Option("--target <target>", "execution target")
        .choices([...MOKA_RUN_TARGETS])
        .default("local")
    )
    .option("--read-only", "run the read-only inspect workflow")
    .action((flags: TicketStartFlags) =>
      runTicketProgramWithBacklog(
        startTicketEffect(currentWorktreePath(), flags, options.runCommand),
        options.backlogLayer ?? BacklogServiceLive
      )
    );
}
