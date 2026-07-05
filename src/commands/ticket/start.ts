import { Option } from "commander";
import type { Command } from "commander";
import { Effect } from "effect";
import { fromUndefinedOr, isNone, some } from "effect/Option";

import type { RunCommand } from "../../cli/run-command";
import {
  MOKA_RUN_EFFORTS,
  MOKA_RUN_TARGETS,
  resolveMokaRun,
} from "../../cli/run-resolver";
import type {
  MokaRunEffort,
  MokaRunTarget,
  RunResolverFlags,
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

const ticketRunTask = (ticket: BacklogTaskRecord): TicketRunDescriptor => {
  const title = formatNextTicket(some(ticket));
  const description = ticket.description?.trim();
  const body =
    description !== undefined && description.length > 0
      ? `${title}\n\n${description}`
      : title;
  const directive = BACKLOG_STATUS_DIRECTIVE.replaceAll(
    "<TICKET_ID>",
    ticket.id
  );
  const task = `${body}\n\n${directive}`;
  return { task, ticketId: ticket.id };
};

const validateTicketStartFlagsEffect = (
  flags: TicketStartFlags
): Effect.Effect<void, TicketCommandError> =>
  flags.readOnly === true && flags.target === "remote"
    ? Effect.fail(
        new TicketCommandError({
          message:
            "moka ticket start --read-only cannot be combined with --target remote.",
        })
      )
    : Effect.void;

const ticketStartRunFlags = (flags: TicketStartFlags): RunResolverFlags => ({
  effort: flags.effort ?? "normal",
  readOnly: flags.readOnly,
  target: flags.target ?? "local",
});

const ticketStartRunFlagsEffect = (
  flags: TicketStartFlags
): Effect.Effect<RunResolverFlags, TicketCommandError> =>
  Effect.gen(function* effectBody() {
    yield* validateTicketStartFlagsEffect(flags);
    return ticketStartRunFlags(flags);
  });

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const formatTicketStartDryRun = (
  flags: RunResolverFlags,
  task: string
): string =>
  [
    "moka run",
    `--effort ${flags.effort ?? "normal"}`,
    `--target ${flags.target ?? "local"}`,
    flags.readOnly === true ? "--read-only" : "",
    shellQuote(task),
  ]
    .filter((part) => part.length > 0)
    .join(" ");

const startTicketEffect = (
  worktreePath: string,
  flags: TicketStartFlags,
  runCommand: ReturnType<typeof some<RunCommand>>
): Effect.Effect<void, unknown, RepoIoService | BacklogService> =>
  Effect.gen(function* effectBody() {
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

    yield* writeLineEffect(
      `Selected ticket: ${formatNextTicket(some(selected))}`
    );
    if (flags.dryRun === true) {
      yield* writeLineEffect(formatTicketStartDryRun(runFlags, task));
      return;
    }
    if (isNone(runCommand)) {
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
        await runCommand.value({
          descriptionParts,
          flags: runFlags,
          resolution,
          task,
          ticketId,
        });
      },
    });
  });

export const registerStartSubcommand = (
  ticketCommand: Command,
  options: TicketCommandOptions
): void => {
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
    .action(async (flags: TicketStartFlags) => {
      await runTicketProgramWithBacklog(
        startTicketEffect(
          currentWorktreePath(),
          flags,
          fromUndefinedOr(options.runCommand)
        ),
        options.backlogLayer ?? BacklogServiceLive
      );
    });
};
