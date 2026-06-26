import type { Command } from "commander";
import { Effect } from "effect";
import type { CompletionClaim, UnmetCriterion } from "../../runtime/contracts";
import type { BacklogService } from "../../runtime/services/backlog-service";
import { BacklogServiceLive } from "../../runtime/services/backlog-service";
import type { RepoIoService } from "../../runtime/services/repo-io-service";
import {
  backlogTicketCompletionStoreEffect,
  completeTicket,
  conservativeLayerAJudge,
  type TicketCompletionOutcome,
} from "../../tickets/completion/complete-ticket";
import type { TicketCommandOptions } from "./shared";
import {
  currentWorktreePath,
  runTicketProgramWithBacklog,
  TicketCommandError,
  writeLineEffect,
} from "./shared";

interface TicketCompleteFlags {
  evidence?: string[];
  json?: boolean;
}

interface EvidenceEntry {
  readonly id: string;
  readonly text: string;
}

function collectEvidence(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseEvidenceEntryEffect(
  raw: string
): Effect.Effect<EvidenceEntry, TicketCommandError> {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    return Effect.fail(
      new TicketCommandError({
        message: `Invalid --evidence '${raw}'; expected <criterionId>=<evidence text>`,
      })
    );
  }
  return Effect.succeed({
    id: raw.slice(0, separator).trim(),
    text: raw.slice(separator + 1),
  });
}

function buildCompletionClaim(
  entries: readonly EvidenceEntry[]
): CompletionClaim {
  const evidenceById = new Map<string, string[]>();
  for (const entry of entries) {
    const evidence = evidenceById.get(entry.id) ?? [];
    evidence.push(entry.text);
    evidenceById.set(entry.id, evidence);
  }
  return {
    criteria: [...evidenceById].map(([criterion, evidence]) => ({
      criterion,
      evidence,
    })),
  };
}

function formatUnmet(unmet: readonly UnmetCriterion[]): string {
  return unmet
    .map((entry) => {
      const evidence =
        entry.evidence.length > 0 ? entry.evidence.join("; ") : "(none)";
      return `  - [${entry.criterion}] ${entry.reason}\n      evidence: ${evidence}`;
    })
    .join("\n");
}

function formatOutcome(
  outcome: TicketCompletionOutcome,
  json: boolean | undefined
): string {
  if (json) {
    return JSON.stringify(outcome);
  }
  if (outcome.status === "completed") {
    return `Ticket ${outcome.ticketId} completed: all acceptance criteria met. Status set to Done.`;
  }
  const count = outcome.unmet.length;
  const header = `Ticket ${outcome.ticketId} NOT completed: ${count} acceptance criteri${count === 1 ? "on" : "a"} unmet.`;
  return [header, formatUnmet(outcome.unmet)].join("\n");
}

function completeTicketCommandEffect(
  worktreePath: string,
  ticketId: string,
  flags: TicketCompleteFlags
): Effect.Effect<void, unknown, RepoIoService | BacklogService> {
  return Effect.gen(function* () {
    const entries = yield* Effect.all(
      (flags.evidence ?? []).map(parseEvidenceEntryEffect)
    );
    const store = yield* backlogTicketCompletionStoreEffect(worktreePath);
    const outcome = yield* completeTicket({
      claim: buildCompletionClaim(entries),
      judge: conservativeLayerAJudge,
      store,
      ticketId,
    });
    yield* writeLineEffect(formatOutcome(outcome, flags.json));
    if (outcome.status === "refused") {
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }
  });
}

export function registerCompleteSubcommand(
  ticketCommand: Command,
  options: TicketCommandOptions
): void {
  ticketCommand
    .command("complete")
    .description(
      "Adjudicate a completion claim and set a Backlog ticket to Done only if it passes"
    )
    .argument("<ticket-id>", "Backlog ticket id to complete")
    .option(
      "--evidence <criterionId=text>",
      "per-criterion completion evidence; repeat to add more",
      collectEvidence,
      []
    )
    .option("--json", "print machine-readable completion outcome")
    .action((ticketId: string, flags: TicketCompleteFlags) =>
      runTicketProgramWithBacklog(
        completeTicketCommandEffect(currentWorktreePath(), ticketId, flags),
        options.backlogLayer ?? BacklogServiceLive
      )
    );
}
