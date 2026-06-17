import { type Command, Option } from "commander";
import type { Layer } from "effect";
import { Data, Effect } from "effect";
import type { RunCommand } from "../cli/run-command";
import {
  MOKA_RUN_EFFORTS,
  MOKA_RUN_TARGETS,
  type MokaRunEffort,
  type MokaRunTarget,
  type RunResolverFlags,
  resolveMokaRun,
} from "../cli/run-resolver";
import { loadPipelineConfig } from "../config";
import {
  type AgentResult,
  createRunnerLaunchPlan,
  type RunnerExecutionOptions,
  type RunnerLaunchPlan,
  runLaunchPlan,
} from "../runner";
import { normalizeRunnerOutput } from "../runner-output";
import {
  BacklogService,
  BacklogServiceLive,
} from "../runtime/services/backlog-service";
import type { RepoIoService } from "../runtime/services/repo-io-service";
import { RepoIoServiceLive } from "../runtime/services/repo-io-service";
import {
  type AppliedTicketPlan,
  applyTicketPlanEffect,
} from "../tickets/apply-ticket-plan";
import {
  type BacklogTaskRecord,
  loadBacklogTaskStoreEffect,
} from "../tickets/backlog-task-store";
import {
  buildTicketGraphEffect,
  scopedTicketIds,
  sequenceTicketBatchesEffect,
  type TicketGraph,
} from "../tickets/ticket-graph";
import { parseTicketPlanEffect } from "../tickets/ticket-plan";
import { renderTicketPlanDryRun } from "../tickets/ticket-plan-render";
import {
  selectNextTicket,
  selectReadyTickets,
  type TicketSelectionOptions,
  type TicketSelectionStrategy,
} from "../tickets/ticket-selection";

interface TicketRootFlags {
  root?: string;
}

interface TicketSequenceFlags extends TicketRootFlags {
  plain?: boolean;
}

interface TicketNextFlags extends TicketRootFlags {
  claim?: boolean;
  includeParents?: boolean;
  json?: boolean;
  strategy?: string;
}

interface TicketStartFlags extends TicketRootFlags {
  dryRun?: boolean;
  effort?: MokaRunEffort;
  includeParents?: boolean;
  readOnly?: boolean;
  strategy?: string;
  target?: MokaRunTarget;
}

interface TicketSelectionFlags extends TicketRootFlags {
  includeParents?: boolean;
  strategy?: string;
}

interface TicketCreateFlags {
  apply?: boolean;
  dryRun?: boolean;
  parent?: string;
}

export type TicketPlanExecutor = (
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
) => Promise<AgentResult>;

export interface TicketCommandOptions {
  readonly backlogLayer?: Layer.Layer<BacklogService>;
  readonly runCommand?: RunCommand;
  readonly ticketPlanExecutor?: TicketPlanExecutor;
}

interface LoadedTicketGraph {
  readonly graph: TicketGraph;
  readonly scopedIds: readonly string[];
}

interface RunnerFailureResult {
  readonly exitCode: number;
  readonly stderr?: string;
  readonly stdout: string;
  readonly timedOut?: boolean;
}

class TicketCommandError extends Data.TaggedError("TicketCommandError")<{
  readonly message: string;
}> {}

const TICKET_SCOPER_PROFILE = "moka-ticket-scoper";
const TICKET_SELECTION_STRATEGIES = new Set<TicketSelectionStrategy>([
  "priority",
  "bfs",
  "dfs",
]);
const TICKET_CREATE_FLAG_RULES: readonly {
  readonly invalid: (flags: TicketCreateFlags) => boolean;
  readonly message: string;
}[] = [
  {
    invalid: (flags) => Boolean(flags.dryRun && flags.apply),
    message: "moka ticket create accepts only one of --dry-run or --apply",
  },
  {
    invalid: (flags) => !(flags.dryRun || flags.apply),
    message: "moka ticket create requires --dry-run or --apply",
  },
  {
    invalid: (flags) => Boolean(flags.parent && !flags.apply),
    message: "moka ticket create --parent is only valid with --apply",
  },
];

export function registerTicketCommand(
  program: Command,
  options: TicketCommandOptions = {}
): void {
  const ticketCommand = program
    .command("ticket")
    .description("Scope, inspect, and select Backlog tickets for moka runs");

  const graphCommand = ticketCommand
    .command("graph")
    .description("Inspect the Backlog ticket dependency graph");

  graphCommand
    .command("check")
    .description("Validate Backlog ticket dependency references and cycles")
    .option("--root <ticket-id>", "limit validation summary to one ticket tree")
    .action((flags: TicketRootFlags) =>
      runTicketProgram(checkTicketGraphEffect(currentWorktreePath(), flags))
    );

  ticketCommand
    .command("sequence")
    .description("Print dependency execution batches for Backlog tickets")
    .option("--root <ticket-id>", "sequence one ticket tree")
    .option("--plain", "print plain text output")
    .action((flags: TicketSequenceFlags) =>
      runTicketProgram(printTicketSequenceEffect(currentWorktreePath(), flags))
    );

  ticketCommand
    .command("next")
    .description("Select the next ready Backlog ticket deterministically")
    .option("--root <ticket-id>", "select from one ticket tree")
    .option("--claim", "mark the selected ticket In Progress through Backlog")
    .option("--include-parents", "allow parent tickets in selection results")
    .option("--json", "print machine-readable selection output")
    .option(
      "--strategy <strategy>",
      "selection strategy: priority, bfs, or dfs"
    )
    .action((flags: TicketNextFlags) =>
      runTicketProgramWithBacklog(
        printNextTicketEffect(currentWorktreePath(), flags),
        options.backlogLayer ?? BacklogServiceLive
      )
    );

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

  ticketCommand
    .command("create")
    .description("Create a validated Backlog ticket plan")
    .argument("<request...>", "ticket planning request")
    .option("--dry-run", "render Backlog commands without writing tasks")
    .option("--apply", "apply the validated ticket plan through Backlog")
    .option("--parent <task-id>", "existing parent task for applied children")
    .action((requestParts: string[], flags: TicketCreateFlags) =>
      Effect.runPromise(
        Effect.provide(
          printTicketCreateEffect(
            currentWorktreePath(),
            requestParts.join(" "),
            flags,
            options.ticketPlanExecutor ?? runLaunchPlan
          ),
          options.backlogLayer ?? BacklogServiceLive
        )
      )
    );
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

    const task = ticketRunTask(selected);
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
        });
      },
    });
  });
}

function ticketRunTask(ticket: BacklogTaskRecord): string {
  const title = formatNextTicket(ticket);
  const description = ticket.description?.trim();
  return description ? `${title}\n\n${description}` : title;
}

function ticketStartRunFlagsEffect(
  flags: TicketStartFlags
): Effect.Effect<RunResolverFlags, TicketCommandError> {
  return Effect.gen(function* () {
    yield* validateTicketStartFlagsEffect(flags);
    return ticketStartRunFlags(flags);
  });
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printTicketCreateEffect(
  worktreePath: string,
  request: string,
  flags: TicketCreateFlags,
  executor: TicketPlanExecutor
): Effect.Effect<void, unknown, BacklogService> {
  return Effect.gen(function* () {
    yield* validateTicketCreateFlagsEffect(flags);
    const launchPlan = yield* ticketScoperLaunchPlanEffect(
      worktreePath,
      request
    );
    const rawPlan = yield* runTicketScoperEffect(launchPlan, executor);
    const ticketPlan = yield* parseTicketPlanEffect(rawPlan);
    if (flags.dryRun) {
      yield* writeLineEffect(renderTicketPlanDryRun(ticketPlan));
      return;
    }
    const applied = yield* applyTicketPlanEffect(ticketPlan, worktreePath, {
      parentId: flags.parent,
    });
    yield* writeLineEffect(formatAppliedTicketPlan(applied));
  });
}

function validateTicketCreateFlagsEffect(
  flags: TicketCreateFlags
): Effect.Effect<void, TicketCommandError> {
  const message = ticketCreateFlagErrorMessage(flags);
  return message
    ? Effect.fail(new TicketCommandError({ message }))
    : Effect.void;
}

function ticketCreateFlagErrorMessage(
  flags: TicketCreateFlags
): string | undefined {
  return TICKET_CREATE_FLAG_RULES.find((rule) => rule.invalid(flags))?.message;
}

function ticketScoperLaunchPlanEffect(
  worktreePath: string,
  request: string
): Effect.Effect<RunnerLaunchPlan, TicketCommandError> {
  return Effect.gen(function* () {
    const config = yield* Effect.try({
      catch: (error) =>
        new TicketCommandError({
          message: `Could not load pipeline config: ${errorMessage(error)}`,
        }),
      try: () =>
        loadPipelineConfig(worktreePath, {
          allowMissingLintFileReferences: true,
        }),
    });
    return yield* Effect.try({
      catch: (error) =>
        new TicketCommandError({
          message: `Could not create ticket scoper launch plan: ${errorMessage(error)}`,
        }),
      try: () =>
        createRunnerLaunchPlan(config, {
          nodeId: "ticket-plan",
          profileId: TICKET_SCOPER_PROFILE,
          prompt: ticketPlanPrompt(request),
          worktreePath,
        }),
    });
  });
}

function runTicketScoperEffect(
  launchPlan: RunnerLaunchPlan,
  executor: TicketPlanExecutor
): Effect.Effect<string, TicketCommandError> {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      catch: (error) =>
        new TicketCommandError({
          message: `Ticket scoper failed: ${errorMessage(error)}`,
        }),
      try: () => executor(launchPlan, {}),
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new TicketCommandError({
          message: ticketScoperFailureMessage(result),
        })
      );
    }
    return normalizeRunnerOutput(launchPlan, result.stdout).output.trim();
  });
}

function checkTicketGraphEffect(worktreePath: string, flags: TicketRootFlags) {
  return Effect.gen(function* () {
    const loaded = yield* loadTicketGraphEffect(worktreePath, flags.root);
    yield* writeLineEffect(
      `OK: ticket graph valid (${loaded.scopedIds.length} tickets)`
    );
  });
}

function printTicketSequenceEffect(
  worktreePath: string,
  flags: TicketSequenceFlags
) {
  return Effect.gen(function* () {
    const loaded = yield* loadTicketGraphEffect(worktreePath, flags.root);
    const batches = yield* sequenceTicketBatchesEffect(
      loaded.graph,
      loaded.scopedIds
    );
    yield* writeLineEffect(formatSequence(batches));
  });
}

function printNextTicketEffect(worktreePath: string, flags: TicketNextFlags) {
  return Effect.gen(function* () {
    const { loaded, selectionOptions } = yield* loadTicketSelectionEffect(
      worktreePath,
      flags
    );
    const selected = selectNextTicket(loaded.graph, selectionOptions);
    if (flags.claim) {
      const ticket = yield* readyTicketEffect(selected);
      yield* claimTicketEffect(worktreePath, ticket);
      yield* writeLineEffect(`Claimed ${formatNextTicket(ticket)}`);
      return;
    }
    const ready = selectReadyTickets(loaded.graph, selectionOptions);
    yield* writeLineEffect(
      flags.json
        ? JSON.stringify({
            ready: ready.map(ticketJson),
            selected: ticketJson(selected),
          })
        : formatNextTicket(selected)
    );
  });
}

function claimTicketEffect(
  worktreePath: string,
  ticket: BacklogTaskRecord
): Effect.Effect<void, TicketCommandError, BacklogService> {
  return Effect.gen(function* () {
    const backlog = yield* BacklogService;
    yield* backlog
      .run(
        ["task", "edit", ticket.id, "--status", "In Progress", "--plain"],
        worktreePath
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new TicketCommandError({
              message: `Could not claim ticket '${ticket.id}': ${errorMessage(error)}`,
            })
        )
      );
  });
}

function loadTicketGraphEffect(
  worktreePath: string,
  rootId: string | undefined
) {
  return Effect.gen(function* () {
    const store = yield* loadBacklogTaskStoreEffect(worktreePath);
    const graph = yield* buildTicketGraphEffect(store.tasks);
    const scopedIds = scopedTicketIds(graph, rootId);
    if (rootId && scopedIds.length === 0) {
      return yield* Effect.fail(
        new TicketCommandError({
          message: `Unknown Backlog ticket '${rootId}'`,
        })
      );
    }
    return { graph, scopedIds } satisfies LoadedTicketGraph;
  });
}

function loadTicketSelectionEffect(
  worktreePath: string,
  flags: TicketSelectionFlags
) {
  return Effect.gen(function* () {
    const strategy = yield* parseSelectionStrategyEffect(flags.strategy);
    const loaded = yield* loadTicketGraphEffect(worktreePath, flags.root);
    return {
      loaded,
      selectionOptions: {
        includeParents: flags.includeParents,
        rootId: flags.root,
        strategy,
      } satisfies TicketSelectionOptions,
    };
  });
}

function parseSelectionStrategyEffect(
  strategy: string | undefined
): Effect.Effect<TicketSelectionStrategy | undefined, TicketCommandError> {
  return strategy === undefined || isTicketSelectionStrategy(strategy)
    ? Effect.succeed(strategy)
    : Effect.fail(
        new TicketCommandError({
          message: `Unknown ticket selection strategy '${strategy}'; expected priority, bfs, or dfs`,
        })
      );
}

function isTicketSelectionStrategy(
  strategy: string
): strategy is TicketSelectionStrategy {
  return TICKET_SELECTION_STRATEGIES.has(strategy as TicketSelectionStrategy);
}

function formatSequence(batches: readonly (readonly string[])[]): string {
  return batches
    .map((batch, index) =>
      [`Sequence ${index + 1}:`, ...batch.map((id) => `  ${id}`)].join("\n")
    )
    .join("\n\n");
}

function formatNextTicket(ticket: BacklogTaskRecord | undefined): string {
  return ticket ? `${ticket.id} - ${ticket.title}` : "No ready tickets.";
}

function formatAppliedTicketPlan(applied: AppliedTicketPlan): string {
  return [
    "Created tickets:",
    ...Object.entries(applied.taskIdsByKey).map(
      ([key, taskId]) => `  ${key}: ${taskId}`
    ),
  ].join("\n");
}

function ticketJson(ticket: BacklogTaskRecord | undefined) {
  if (!ticket) {
    return null;
  }
  return {
    acceptanceCriteria: ticket.acceptanceCriteria,
    dependencies: ticket.dependencies,
    description: ticket.description,
    id: ticket.id,
    modifiedFiles: ticket.modifiedFiles,
    ordinal: ticket.ordinal,
    parentTaskId: ticket.parentTaskId,
    priority: ticket.priority,
    references: ticket.references,
    status: ticket.status,
    title: ticket.title,
  };
}

function writeLineEffect(line: string): Effect.Effect<void> {
  return Effect.sync(() => console.log(line));
}

function readyTicketEffect(
  ticket: BacklogTaskRecord | undefined
): Effect.Effect<BacklogTaskRecord, TicketCommandError> {
  return ticket
    ? Effect.succeed(ticket)
    : Effect.fail(new TicketCommandError({ message: "No ready tickets." }));
}

function currentWorktreePath(): string {
  return process.env.PIPELINE_TARGET_PATH ?? process.cwd();
}

function runTicketProgram<A, E>(program: Effect.Effect<A, E, RepoIoService>) {
  return Effect.runPromise(Effect.provide(program, RepoIoServiceLive));
}

function runTicketProgramWithBacklog<A, E>(
  program: Effect.Effect<A, E, RepoIoService | BacklogService>,
  backlogLayer: Layer.Layer<BacklogService>
) {
  return Effect.runPromise(
    Effect.provide(Effect.provide(program, RepoIoServiceLive), backlogLayer)
  );
}

function ticketPlanPrompt(request: string): string {
  return [
    "Use the scope skill contract to produce a complete Backlog ticket plan.",
    "Return only JSON matching this exact snake_case shape. Do not emit Markdown.",
    '{"epic":{"key":"epic","title":"...","description":"...","priority":"high|medium|low","acceptance_criteria":[{"text":"...","evidence":"..."}],"likely_files":["path"],"references":["path-or-url"],"plan":"..."},"tickets":[{"key":"local-key","title":"...","description":"...","priority":"high|medium|low","depends_on":["other-local-key"],"acceptance_criteria":[{"text":"...","evidence":"..."}],"likely_files":["path"],"references":["path-or-url"],"plan":"..."}]}',
    "Omit epic entirely when no epic should be created.",
    "Use depends_on only for local ticket keys from the same tickets array.",
    "Every acceptance_criteria entry must include concrete evidence text.",
    "Do not use epics, type, dependencies, labels, acceptanceCriteria, qualityGate, or camelCase keys.",
    "Do not return partial tickets; if the request is unclear, encode the missing decision in the plan text instead of omitting required fields.",
    "Task request:",
    request,
  ].join("\n");
}

function ticketScoperFailureMessage(result: AgentResult): string {
  return runnerFailureMessage(
    `ticket scoper '${TICKET_SCOPER_PROFILE}'`,
    "timed out waiting for ticket scoper",
    result
  );
}

function runnerFailureMessage(
  label: string,
  timeoutMessage: string,
  result: RunnerFailureResult
): string {
  const details = runnerFailureDetails(timeoutMessage, result);
  const message = `${label} failed with exit ${result.exitCode}`;
  return details.length === 0 ? message : `${message}\n${details.join("\n")}`;
}

function runnerFailureDetails(
  timeoutMessage: string,
  result: RunnerFailureResult
): string[] {
  const details: string[] = [];
  appendDetail(details, result.timedOut ? timeoutMessage : undefined);
  appendDetail(details, labelledOutput("stderr", result.stderr));
  appendDetail(details, labelledOutput("stdout", result.stdout));
  return details;
}

function labelledOutput(
  label: string,
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? `${label}:\n${trimmed}` : undefined;
}

function appendDetail(details: string[], detail: string | undefined): void {
  if (detail) {
    details.push(detail);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
