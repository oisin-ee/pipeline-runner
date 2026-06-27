import { Effect } from "effect";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  buildNextNodeEnvelope,
  type NodeEnvelopeMetadata,
} from "../src/run-control/next-node";
import { recordSubmitResult } from "../src/run-control/submit-result";
import type { RuntimeNodeResult } from "../src/runtime/contracts";
import { resolveDurableStore } from "../src/runtime/durable-store/acquisition";
import type { DurableRunStore } from "../src/runtime/durable-store/durable-store";
import type { WorkflowScheduleNode } from "../src/runtime/scheduler";
import { setupLivePgDurableSuite } from "./live-pg-durable-suite";

// PIPE-91.15: the `moka next node` / `moka submit-result` CLIs must persist to
// Postgres when db.url is set so a result submitted in one process survives and
// is read back by a FRESH next-node in another process (cross-process stepping).
// Set MOKA_PG_TEST_URL to the (port-forwarded) cluster db.url to run the live
// suite; unset skips it so the default test run stays infra-free.
const PG_URL = process.env.MOKA_PG_TEST_URL ?? "";
const describePg = PG_URL ? describe : describe.skip;

// Two-node graph: plan → implement (implement depends on plan).
const nodes: WorkflowScheduleNode[] = [
  { dependents: ["implement"], id: "plan", index: 0, needs: [] },
  { dependents: [], id: "implement", index: 1, needs: ["plan"] },
];

const nodeMetadata: ReadonlyMap<string, NodeEnvelopeMetadata> = new Map([
  ["plan", { criteria: [], prompt: "Plan the work" }],
  ["implement", { criteria: [], prompt: "Implement" }],
]);

function passedResult(nodeId: string): RuntimeNodeResult {
  return {
    attempts: 1,
    evidence: ["exit 0"],
    exitCode: 0,
    nodeId,
    output: `output of ${nodeId}`,
    status: "passed",
  };
}

// Run one unit of work inside a freshly-resolved durable store scope. The store
// is acquired and (for the Postgres branch) flushed + closed when this Effect's
// scope exits — exactly the per-process lifecycle a `moka next node` / `moka
// submit-result` invocation has.
function withStore<A>(
  dbUrl: string | undefined,
  runId: string,
  use: (store: DurableRunStore) => A
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* resolveDurableStore(dbUrl, runId);
        return use(store);
      })
    )
  );
}

describe("resolveDurableStore selection (no infra)", () => {
  it("yields the in-memory store when db.url is absent (no close lifecycle)", async () => {
    const store = await Effect.runPromise(
      Effect.scoped(resolveDurableStore(undefined, "run-1"))
    );
    // The in-memory store is a bare DurableRunStore with no close()/flush()
    // lifecycle (nothing to release); the Postgres store carries both.
    expect("close" in store).toBe(false);
  });
});

describePg(
  "next-node ⇆ submit-result cross-process stepping (live cluster PG)",
  () => {
    const dbUrl = PG_URL;
    const { runId } = setupLivePgDurableSuite(dbUrl, "pgstep");

    it("submit-result persists across a process boundary so a fresh next-node advances (AC2)", async () => {
      const id = runId("step");

      // Process 1 — next node: with nothing persisted, the first ready node is
      // "plan". This read alone persists nothing.
      const first = await withStore(dbUrl, id, (store) =>
        buildNextNodeEnvelope({ nodeMetadata, nodes, runId: id, store })
      );
      expect(first?.nodeId).toBe("plan");

      // Process 2 — submit-result for "plan": the scope exit flushes the
      // write-through and closes the client, persisting the record to Postgres.
      await withStore(dbUrl, id, (store) =>
        recordSubmitResult({
          nodeId: "plan",
          resultJson: JSON.stringify(passedResult("plan")),
          runId: id,
          store,
        })
      );

      // Process 3 — next node again: a brand-new store hydrates from Postgres and
      // must read back "plan" as settled, advancing to the dependent "implement"
      // with plan's output threaded through upstreamOutputs.
      const second = await withStore(dbUrl, id, (store) =>
        buildNextNodeEnvelope({ nodeMetadata, nodes, runId: id, store })
      );
      expect(second?.nodeId).toBe("implement");
      expect(second?.upstreamOutputs).toEqual([
        { nodeId: "plan", output: "output of plan" },
      ]);

      // The row physically exists in moka_durable_node_record for this run.
      const admin = postgres(dbUrl, { max: 1 });
      try {
        const rows = await admin<{ node_id: string; status: string }[]>`
        select node_id, status
        from moka_durable_node_record
        where run_id = ${id}
      `;
        expect(rows).toEqual([{ node_id: "plan", status: "passed" }]);
      } finally {
        await admin.end();
      }
    });
  }
);
