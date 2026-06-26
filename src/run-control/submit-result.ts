import type { Command } from "commander";
import { Effect } from "effect";
import { loadMokaDbUrl } from "../moka-global-config";
import type { DurableRunStore } from "../runtime/durable-store/durable-store";
import { parseSubmitResult } from "../runtime/node-protocol/node-protocol";
import { resolveDurableStore } from "./next-node";

/**
 * PIPE-91.7: input to {@link recordSubmitResult}. Callers provide the routing
 * key (`runId`, `nodeId`), the `RuntimeNodeResult` as a raw JSON string (the
 * process boundary — this is what arrives from the debug human plug), and the
 * store to persist into.
 */
export interface SubmitResultInput {
  readonly nodeId: string;
  readonly resultJson: string;
  readonly runId: string;
  readonly store: DurableRunStore;
}

/**
 * PIPE-91.7: validate and persist a node's terminal result into the durable
 * store. Throws a {@link z.ZodError} on malformed payload or a
 * `result.nodeId !== nodeId` mismatch; throws a {@link SyntaxError} on
 * invalid JSON.
 *
 * Decision #7 (read-only criteria): the submit shape carries no criteria — the
 * criteria are owned by the schedule/planner, not the submitter. This function
 * always records `criteria: []`; a future read of stored criteria for
 * gate evaluation must look up the schedule artifact, not this store entry.
 * `inputs` are opaque and `undefined` until a future lane pins the schema.
 */
export function recordSubmitResult(input: SubmitResultInput): void {
  const raw: unknown = JSON.parse(input.resultJson);
  const assembled = { nodeId: input.nodeId, result: raw, runId: input.runId };
  const parsed = parseSubmitResult(assembled);
  input.store.record(parsed.runId, parsed.nodeId, {
    criteria: [],
    inputs: undefined,
    result: parsed.result,
  });
}

/**
 * PIPE-91.7: register `moka submit-result <run-id> <node-id> --json <payload>`.
 * A distinct top-level command (NOT a `submit` group — `moka submit` already
 * exists for job submission). `--json` carries the `RuntimeNodeResult` as a JSON
 * string; `(runId, nodeId)` are the positional routing keys — mirroring
 * `moka next node <run-id> --schedule-file <path>` (PIPE-91.6).
 */
export function registerSubmitResultSubcommand(program: Command): void {
  program
    .command("submit-result")
    .description("Persist a node's terminal result into the durable run store")
    .argument("<run-id>", "the run id to persist the result under")
    .argument("<node-id>", "the node id whose result is being submitted")
    .requiredOption(
      "--json <payload>",
      "the RuntimeNodeResult as a JSON string"
    )
    .action(async (runId: string, nodeId: string, flags: { json: string }) => {
      await Effect.runPromise(submitResultEffect(runId, nodeId, flags.json));
    });
}

function submitResultEffect(
  runId: string,
  nodeId: string,
  resultJson: string
): Effect.Effect<void, unknown> {
  // Scoped so the store's release runs before the process exits: for the
  // Postgres branch that flushes the enqueued write-through and closes the
  // connection pool, persisting the record durably. Without that flush the
  // write is lost at process exit (the PIPE-91.15 dogfood failure).
  return Effect.scoped(
    Effect.gen(function* () {
      const dbUrl = loadMokaDbUrl();
      const store = yield* resolveDurableStore(dbUrl, runId);
      yield* Effect.try({
        catch: (error) => error,
        try: () => recordSubmitResult({ nodeId, resultJson, runId, store }),
      });
      process.stdout.write(
        `Recorded result for run ${runId} node ${nodeId}.\n`
      );
    })
  );
}
