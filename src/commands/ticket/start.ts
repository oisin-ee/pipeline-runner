import { Effect } from "effect";
import { fromUndefinedOr, getOrUndefined, isNone, some } from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

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
import { RepoIoServiceLive } from "../../runtime/services/repo-io-service";
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

const ticketStartFlags = {
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("print the selected moka run command without claiming")
  ),
  effort: Flag.choice("effort", MOKA_RUN_EFFORTS).pipe(
    Flag.withDescription("run effort"),
    Flag.withDefault(MOKA_RUN_EFFORTS[0])
  ),
  includeParents: Flag.boolean("include-parents").pipe(
    Flag.withDescription("allow parent tickets in selection results")
  ),
  readOnly: Flag.boolean("read-only").pipe(
    Flag.withDescription("run the read-only inspect workflow")
  ),
  root: Flag.string("root").pipe(
    Flag.withDescription("select from one ticket tree"),
    Flag.optional
  ),
  strategy: Flag.string("strategy").pipe(
    Flag.withDescription("selection strategy: priority, bfs, or dfs"),
    Flag.optional
  ),
  target: Flag.choice("target", MOKA_RUN_TARGETS).pipe(
    Flag.withDescription("execution target"),
    Flag.withDefault(MOKA_RUN_TARGETS[0])
  ),
};

const normalizeTicketStartFlags = (
  flags: Command.Command.Config.Infer<typeof ticketStartFlags>
): TicketStartFlags => ({
  dryRun: flags.dryRun,
  effort: flags.effort,
  includeParents: flags.includeParents,
  readOnly: flags.readOnly,
  root: getOrUndefined(flags.root),
  strategy: getOrUndefined(flags.strategy),
  target: flags.target,
});

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
      yield* Effect.fail(
        new TicketCommandError({
          message: "Could not start moka run: no run dispatcher configured.",
        })
      );
    } else {
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
    }
  });

export const createStartSubcommand = (options: TicketCommandOptions) =>
  Command.make("start", ticketStartFlags, (rawFlags) =>
    startTicketEffect(
      currentWorktreePath(),
      normalizeTicketStartFlags(rawFlags),
      fromUndefinedOr(options.runCommand)
    )
  ).pipe(
    Command.provide(RepoIoServiceLive),
    Command.provide(options.backlogLayer ?? BacklogServiceLive),
    Command.withDescription("Claim the next ready Backlog ticket and run moka")
  );
