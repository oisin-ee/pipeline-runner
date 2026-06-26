import { Data, Effect } from "effect";
import type {
  AcceptanceCriterion,
  CompletionClaim,
  UnmetCriterion,
} from "../../runtime/contracts";
import type { LlmJudge } from "../../runtime/gates/adjudication/llm-judge";
import type { DeterministicGate } from "../../runtime/gates/adjudicator";
import { adjudicate } from "../../runtime/gates/adjudicator";
import { BacklogService } from "../../runtime/services/backlog-service";
import { RepoIoService } from "../../runtime/services/repo-io-service";
import {
  type BacklogTaskStore,
  loadBacklogTaskStoreEffect,
} from "../backlog-task-store";

/**
 * A failure raised by the ticket-completion use-case: the ticket could not be
 * loaded, the adjudicator threw, or the status write failed. A refusal is NOT
 * an error — it is an explicit {@link TicketCompletionOutcome} the use-case
 * succeeds with, so a refused completion is always surfaced, never swallowed.
 */
export class TicketCompletionError extends Data.TaggedError(
  "TicketCompletionError"
)<{
  readonly message: string;
}> {}

/**
 * The completion-relevant projection of a Backlog ticket: its id and the
 * acceptance criteria the claim is adjudicated against. `id` "N" ids are
 * positional over the ticket's declared criteria (the store strips any `#N`
 * label) — the stable handle the agent references in its claim.
 */
export interface TicketCompletionTarget {
  readonly criteria: readonly AcceptanceCriterion[];
  readonly id: string;
}

/**
 * The two operations the use-case needs from the backlog, kept as an injected
 * interface so {@link completeTicket} is pure and unit-testable with a plain
 * stub — no RepoIoService/BacklogService, no CLI.
 */
export interface TicketCompletionStore {
  readonly loadTarget: (
    ticketId: string
  ) => Effect.Effect<TicketCompletionTarget, TicketCompletionError>;
  readonly markDone: (
    ticketId: string
  ) => Effect.Effect<void, TicketCompletionError>;
}

/**
 * The single input to {@link completeTicket}. `claim` is the agent-authored
 * completion claim; `judge` is the injected adjudication dependency (default
 * {@link conservativeLayerAJudge} for Layer A); `store` is the injected backlog
 * seam; `deterministicGates` is optional (Layer A wires none).
 */
export interface CompleteTicketInput {
  readonly claim: CompletionClaim;
  readonly deterministicGates?: readonly DeterministicGate[];
  readonly judge: LlmJudge;
  readonly store: TicketCompletionStore;
  readonly ticketId: string;
}

/**
 * The structured result of a completion attempt: `completed` means the
 * adjudicator passed and the ticket status was set to Done; `refused` carries
 * every distinct unmet acceptance criterion and leaves the status untouched.
 */
export type TicketCompletionOutcome =
  | { readonly status: "completed"; readonly ticketId: string }
  | {
      readonly status: "refused";
      readonly ticketId: string;
      readonly unmet: readonly UnmetCriterion[];
    };

/**
 * The Layer A default LLM judge: never standalone-authoritative. It refuses
 * every residue criterion (`satisfied: false`, no citations), so a declared
 * criterion is honored only when a passing deterministic gate anchors it —
 * consistent with the adjudicator's anchoring rule (orchestrator-design #5). A
 * pure function: no network/LLM call ever runs. A later layer replaces it with
 * a model-backed judge.
 */
export const conservativeLayerAJudge: LlmJudge = (input) => ({
  citedEvidence: [],
  rationale:
    `Layer A judge does not honor residue criterion '${input.criterion.id}' ` +
    "without anchored deterministic evidence",
  satisfied: false,
});

/**
 * The keystone completion use-case (PIPE-90.11): load the ticket's acceptance
 * criteria, adjudicate the {@link CompletionClaim} through the layered gate, and
 * set the status to Done ONLY on a passing verdict. A refusal returns the
 * structured {@link UnmetCriterion}[] and performs no status write. Pure given
 * the injected store + judge.
 */
export function completeTicket(
  input: CompleteTicketInput
): Effect.Effect<TicketCompletionOutcome, TicketCompletionError> {
  return Effect.gen(function* () {
    const target = yield* input.store.loadTarget(input.ticketId);
    const verdict = yield* Effect.tryPromise({
      catch: (error) =>
        new TicketCompletionError({
          message: `Adjudication failed for ticket '${input.ticketId}': ${errorMessage(error)}`,
        }),
      try: () =>
        adjudicate({
          claim: input.claim,
          criteria: target.criteria,
          deterministicGates: input.deterministicGates,
          judge: input.judge,
        }),
    });
    if (!verdict.passed) {
      return {
        status: "refused",
        ticketId: input.ticketId,
        unmet: verdict.unmet,
      };
    }
    yield* input.store.markDone(input.ticketId);
    return { status: "completed", ticketId: input.ticketId };
  });
}

/**
 * Builds the live {@link TicketCompletionStore} backed by the Backlog task store
 * (read) and the `backlog` CLI (status write). Captures the worktree path and
 * the resolved services so the returned store's methods are service-free,
 * keeping {@link completeTicket} free of an R requirement.
 */
export function backlogTicketCompletionStoreEffect(
  worktreePath: string
): Effect.Effect<TicketCompletionStore, never, RepoIoService | BacklogService> {
  return Effect.gen(function* () {
    const repoIo = yield* RepoIoService;
    const backlog = yield* BacklogService;
    return {
      loadTarget: (ticketId) =>
        loadBacklogTaskStoreEffect(worktreePath).pipe(
          Effect.provideService(RepoIoService, repoIo),
          Effect.mapError(
            (error) => new TicketCompletionError({ message: error.message })
          ),
          Effect.flatMap((store) => resolveTargetEffect(store, ticketId))
        ),
      markDone: (ticketId) =>
        backlog
          .run(
            ["task", "edit", ticketId, "--status", "Done", "--plain"],
            worktreePath
          )
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              (error) =>
                new TicketCompletionError({
                  message: `Could not set ticket '${ticketId}' to Done: ${error.message}`,
                })
            )
          ),
    };
  });
}

function resolveTargetEffect(
  store: BacklogTaskStore,
  ticketId: string
): Effect.Effect<TicketCompletionTarget, TicketCompletionError> {
  const record = store.tasksById.get(ticketId);
  if (!record) {
    return Effect.fail(
      new TicketCompletionError({
        message: `Unknown Backlog ticket '${ticketId}'`,
      })
    );
  }
  return Effect.succeed({
    criteria: record.acceptanceCriteria.map((text, index) => ({
      id: String(index + 1),
      text,
    })),
    id: record.id,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
