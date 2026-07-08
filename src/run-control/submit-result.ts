import * as Effect from "effect/Effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { loadMokaDbUrl } from "../moka-global-config";
import { resolveDurableStore } from "../runtime/durable-store/acquisition";
import type { DurableRunStore } from "../runtime/durable-store/durable-store";
import { parseSubmitResult } from "../runtime/node-protocol/node-protocol";
import { recordNodeResult } from "../runtime/step/step-node";

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
 * store. Throws an Effect Schema validation error on malformed payload or a
 * `result.nodeId !== nodeId` mismatch; throws a {@link SyntaxError} on
 * invalid JSON.
 *
 * Decision #7 (read-only criteria): the submit shape carries no criteria — the
 * criteria are owned by the schedule/planner, not the submitter. This function
 * always records `criteria: []`; a future read of stored criteria for
 * gate evaluation must look up the schedule artifact, not this store entry.
 * `inputs` are opaque and `undefined` until a future lane pins the schema.
 */
export const recordSubmitResult = (input: SubmitResultInput): void => {
  const raw: unknown = JSON.parse(input.resultJson);
  const assembled = { nodeId: input.nodeId, result: raw, runId: input.runId };
  const parsed = parseSubmitResult(assembled);
  // Delegate the durable write to the shared stepping core's single record path
  // (PIPE-94.2). `parseSubmitResult` validates `result.nodeId === parsed.nodeId`,
  // so keying on `result.nodeId` records under the same `(runId, nodeId)` pair.
  recordNodeResult({
    result: parsed.result,
    runId: parsed.runId,
    store: input.store,
  });
};

const submitResultEffect = (
  runId: string,
  nodeId: string,
  resultJson: string
): Effect.Effect<void, unknown> =>
  // Scoped so the store's release runs before the process exits: for the
  // Postgres branch that flushes the enqueued write-through and closes the
  // connection pool, persisting the record durably. Without that flush the
  // write is lost at process exit (the PIPE-91.15 dogfood failure).
  Effect.scoped(
    Effect.gen(function* effectBody() {
      const dbUrl = loadMokaDbUrl();
      const store = yield* resolveDurableStore(dbUrl, runId);
      yield* Effect.try({
        catch: (error) => error,
        try: () => {
          recordSubmitResult({ nodeId, resultJson, runId, store });
        },
      });
      process.stdout.write(
        `Recorded result for run ${runId} node ${nodeId}.\n`
      );
    })
  );

/**
 * PIPE-91.7: register `moka submit-result <run-id> <node-id> --json <payload>`.
 * A distinct top-level command (NOT a `submit` group — `moka submit` already
 * exists for job submission). `--json` carries the `RuntimeNodeResult` as a JSON
 * string; `(runId, nodeId)` are the positional routing keys — mirroring
 * `moka next node <run-id>` (PIPE-91.6).
 */
export const createSubmitResultCommand = () =>
  Command.make(
    "submit-result",
    // Effect CLI binds positional arguments in config-key order, which sort-keys
    // forces alphabetical. The node argument is keyed targetNodeId (not nodeId)
    // so the required run-id keeps the first position; keying it nodeId would
    // put it first and silently swap the two required positionals.
    {
      json: Flag.string("json").pipe(
        Flag.withDescription("the RuntimeNodeResult as a JSON string")
      ),
      runId: Argument.string("run-id").pipe(
        Argument.withDescription("the run id to persist the result under")
      ),
      targetNodeId: Argument.string("node-id").pipe(
        Argument.withDescription("the node id whose result is being submitted")
      ),
    },
    ({ json, runId, targetNodeId }) =>
      submitResultEffect(runId, targetNodeId, json)
  ).pipe(
    Command.withDescription(
      "Persist a node's terminal result into the durable run store"
    )
  );
