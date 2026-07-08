import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import type { CompletionClaim, UnmetCriterion } from "../../runtime/contracts";
import type { BacklogService } from "../../runtime/services/backlog-service";
import { BacklogServiceLive } from "../../runtime/services/backlog-service";
import type { RepoIoService } from "../../runtime/services/repo-io-service";
import { RepoIoServiceLive } from "../../runtime/services/repo-io-service";
import {
  backlogTicketCompletionStoreEffect,
  completeTicket,
  conservativeLayerAJudge,
} from "../../tickets/completion/complete-ticket";
import type { TicketCompletionOutcome } from "../../tickets/completion/complete-ticket";
import type { TicketCommandOptions } from "./shared";
import {
  currentWorktreePath,
  TicketCommandError,
  writeLineEffect,
} from "./shared";

interface TicketCompleteFlags {
  evidence?: string[];
  json?: boolean;
}

const ticketCompleteFlags = {
  evidence: Flag.string("evidence").pipe(
    Flag.withDescription(
      "per-criterion completion evidence; repeat to add more"
    ),
    Flag.atLeast(0)
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("print machine-readable completion outcome")
  ),
  ticketId: Argument.string("ticket-id").pipe(
    Argument.withDescription("Backlog ticket id to complete")
  ),
};

interface EvidenceEntry {
  readonly id: string;
  readonly text: string;
}

const normalizeTicketCompleteFlags = (
  flags: Command.Command.Config.Infer<typeof ticketCompleteFlags>
): {
  readonly flags: TicketCompleteFlags;
  readonly ticketId: string;
} => ({
  flags: {
    evidence: [...flags.evidence],
    json: flags.json,
  },
  ticketId: flags.ticketId,
});

const parseEvidenceEntryEffect = (
  raw: string
): Effect.Effect<EvidenceEntry, TicketCommandError> => {
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
};

const buildCompletionClaim = (
  entries: readonly EvidenceEntry[]
): CompletionClaim => {
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
};

const formatUnmet = (unmet: readonly UnmetCriterion[]): string =>
  unmet
    .map((entry) => {
      const evidence =
        entry.evidence.length > 0 ? entry.evidence.join("; ") : "(none)";
      return `  - [${entry.criterion}] ${entry.reason}\n      evidence: ${evidence}`;
    })
    .join("\n");

const formatOutcome = (
  outcome: TicketCompletionOutcome,
  json = false
): string => {
  if (json) {
    return JSON.stringify(outcome);
  }
  if (outcome.status === "completed") {
    return `Ticket ${outcome.ticketId} completed: all acceptance criteria met. Status set to Done.`;
  }
  const count = outcome.unmet.length;
  const header = `Ticket ${outcome.ticketId} NOT completed: ${count} acceptance criteri${count === 1 ? "on" : "a"} unmet.`;
  return [header, formatUnmet(outcome.unmet)].join("\n");
};

const completeTicketCommandEffect = (
  worktreePath: string,
  ticketId: string,
  flags: TicketCompleteFlags
): Effect.Effect<void, unknown, RepoIoService | BacklogService> =>
  Effect.gen(function* effectBody() {
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
    yield* writeLineEffect(formatOutcome(outcome, flags.json === true));
    if (outcome.status === "refused") {
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }
  });

export const createCompleteSubcommand = (options: TicketCommandOptions) =>
  Command.make("complete", ticketCompleteFlags, (rawFlags) => {
    const { flags, ticketId } = normalizeTicketCompleteFlags(rawFlags);
    return completeTicketCommandEffect(currentWorktreePath(), ticketId, flags);
  }).pipe(
    Command.provide(RepoIoServiceLive),
    Command.provide(options.backlogLayer ?? BacklogServiceLive),
    Command.withDescription(
      "Adjudicate a completion claim and set a Backlog ticket to Done only if it passes"
    )
  );
