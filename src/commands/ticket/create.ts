import type { Command } from "commander";
import { Effect } from "effect";
import { loadPipelineConfig } from "../../config";
import type { AgentResult, RunnerLaunchPlan } from "../../runner";
import { createRunnerLaunchPlan } from "../../runner";
import { runLaunchPlan } from "../../runner/subprocess";
import { normalizeRunnerOutput } from "../../runner-output";
import {
  type BacklogService,
  BacklogServiceLive,
} from "../../runtime/services/backlog-service";
import {
  type AppliedTicketPlan,
  applyTicketPlanEffect,
} from "../../tickets/apply-ticket-plan";
import { parseTicketPlanEffect } from "../../tickets/ticket-plan";
import { renderTicketPlanDryRun } from "../../tickets/ticket-plan-render";
import type { TicketCommandOptions, TicketPlanExecutor } from "./shared";
import {
  currentWorktreePath,
  errorMessage,
  TicketCommandError,
  writeLineEffect,
} from "./shared";

interface TicketCreateFlags {
  apply?: boolean;
  dryRun?: boolean;
  parent?: string;
}

interface RunnerFailureResult {
  readonly exitCode: number;
  readonly stderr?: string;
  readonly stdout: string;
  readonly timedOut?: boolean;
}

const TICKET_SCOPER_PROFILE = "moka-ticket-scoper";

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

function ticketCreateFlagErrorMessage(
  flags: TicketCreateFlags
): string | undefined {
  return TICKET_CREATE_FLAG_RULES.find((rule) => rule.invalid(flags))?.message;
}

function validateTicketCreateFlagsEffect(
  flags: TicketCreateFlags
): Effect.Effect<void, TicketCommandError> {
  const message = ticketCreateFlagErrorMessage(flags);
  return message
    ? Effect.fail(new TicketCommandError({ message }))
    : Effect.void;
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

function runnerFailureMessage(
  label: string,
  timeoutMessage: string,
  result: RunnerFailureResult
): string {
  const details = runnerFailureDetails(timeoutMessage, result);
  const message = `${label} failed with exit ${result.exitCode}`;
  return details.length === 0 ? message : `${message}\n${details.join("\n")}`;
}

function ticketScoperFailureMessage(result: AgentResult): string {
  return runnerFailureMessage(
    `ticket scoper '${TICKET_SCOPER_PROFILE}'`,
    "timed out waiting for ticket scoper",
    result
  );
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

function formatAppliedTicketPlan(applied: AppliedTicketPlan): string {
  return [
    "Created tickets:",
    ...Object.entries(applied.taskIdsByKey).map(
      ([key, taskId]) => `  ${key}: ${taskId}`
    ),
  ].join("\n");
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

export function registerCreateSubcommand(
  ticketCommand: Command,
  options: TicketCommandOptions
): void {
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
