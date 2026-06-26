import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CreateRunRequest } from "../run-control-store";
import {
  migratePostgresRunControlStore,
  type PostgresRunControlStore,
  postgresRunControlStore,
} from "./postgres-run-control-store";

// PIPE-91.11: integration test against the REAL cluster Postgres (no
// testcontainer, no tunnel). Set MOKA_PG_TEST_URL to the (port-forwarded)
// cluster db.url to run it; unset skips the suite so the default test run stays
// infra-free.
const PG_URL = process.env.MOKA_PG_TEST_URL ?? "";
const describePg = PG_URL ? describe : describe.skip;

const RUN_MISSING = /does not exist/;
const NODE_MISSING = /does not exist in run/;

function nowIso(): string {
  return new Date().toISOString();
}

function createRequest(runId: string, nodeIds: string[]): CreateRunRequest {
  return { effort: "normal", mode: "write", nodeIds, runId, target: "local" };
}

describePg("postgresRunControlStore (live cluster PG)", () => {
  const dbUrl = PG_URL;
  // Namespace every runId under a unique per-suite prefix so concurrent test
  // workers and prior runs never collide on (run_id, node_id), and cleanup is a
  // set of prefix-scoped deletes.
  const suitePrefix = `rctest-${randomUUID()}`;
  const openStores: PostgresRunControlStore[] = [];
  let admin: postgres.Sql;

  function runId(label: string): string {
    return `${suitePrefix}-${label}-${randomUUID()}`;
  }

  function newStore(): PostgresRunControlStore {
    const store = postgresRunControlStore(dbUrl);
    openStores.push(store);
    return store;
  }

  beforeAll(async () => {
    // Every op is a real round-trip over the port-forwarded cluster DB, so the
    // 5s default is too tight for the multi-statement cases.
    vi.setConfig({ hookTimeout: 30_000, testTimeout: 20_000 });
    await migratePostgresRunControlStore(dbUrl);
    admin = postgres(dbUrl, { max: 1 });
  });

  afterAll(async () => {
    for (const store of openStores) {
      await store.close();
    }
    const like = `${suitePrefix}%`;
    await admin`delete from moka_run_control_node_artifact where run_id like ${like}`;
    await admin`delete from moka_run_control_node_session where run_id like ${like}`;
    await admin`delete from moka_run_control_event where run_id like ${like}`;
    await admin`delete from moka_run_control_run where run_id like ${like}`;
    await admin.end();
  });

  it("createRun writes a queued base manifest read back from PG (AC1)", async () => {
    const id = runId("create");
    const store = newStore();
    const created = await Effect.runPromise(
      store.createRun(createRequest(id, ["build", "test"]))
    );
    expect(created.status).toBe("queued");
    expect(created.nodes).toEqual({ build: "queued", test: "queued" });
    expect(created.events).toEqual([]);

    const reader = newStore();
    const got = await Effect.runPromise(reader.readRun({ runId: id }));
    expect(got?.status).toBe("queued");
    expect(got?.nodes).toEqual({ build: "queued", test: "queued" });
  });

  it("readRun returns undefined for an unknown run", async () => {
    const store = newStore();
    const got = await Effect.runPromise(
      store.readRun({ runId: runId("missing") })
    );
    expect(got).toBeUndefined();
  });

  it("recordEvent appends and readRun replays the event log (AC1, AC2)", async () => {
    const id = runId("replay");
    const writer = newStore();
    await Effect.runPromise(writer.createRun(createRequest(id, ["a", "b"])));
    await Effect.runPromise(
      writer.updateRunStatus({ at: nowIso(), runId: id, status: "running" })
    );
    await Effect.runPromise(
      writer.updateNodeStatus({
        at: nowIso(),
        nodeId: "a",
        runId: id,
        status: "passed",
      })
    );
    await Effect.runPromise(
      writer.recordEvent({
        event: {
          at: nowIso(),
          heartbeatIntervalMs: 30_000,
          type: "run.heartbeat",
        },
        runId: id,
      })
    );
    await Effect.runPromise(
      writer.updateNodeStatus({
        at: nowIso(),
        nodeId: "b",
        runId: id,
        status: "failed",
      })
    );

    // A fresh instance replays the log from PG — proves event-sourced read.
    const reader = newStore();
    const got = await Effect.runPromise(reader.readRun({ runId: id }));
    expect(got?.status).toBe("running");
    expect(got?.nodes).toEqual({ a: "passed", b: "failed" });
    // Heartbeats are dropped from the manifest's events; only status events fold.
    expect(got?.events).toHaveLength(3);
    expect(got?.events.map((event) => event.type)).toEqual([
      "run.status",
      "node.status",
      "node.status",
    ]);
  });

  it("recordEvent rejects an event for a missing run", async () => {
    const store = newStore();
    await expect(
      Effect.runPromise(
        store.recordEvent({
          event: { at: nowIso(), status: "running", type: "run.status" },
          runId: runId("absent"),
        })
      )
    ).rejects.toThrow(RUN_MISSING);
  });

  it("updateRunController patches the manifest controller via PG", async () => {
    const id = runId("controller");
    const store = newStore();
    await Effect.runPromise(store.createRun(createRequest(id, ["n"])));
    const controller = {
      argv: ["moka", "loop"],
      cwd: "/workspace",
      paths: store.statusPaths({ runId: id }),
      pid: 4242,
      startedAt: nowIso(),
    };
    const updated = await Effect.runPromise(
      store.updateRunController({ controller, runId: id })
    );
    expect(updated.controller).toEqual(controller);

    const reader = newStore();
    const got = await Effect.runPromise(reader.readRun({ runId: id }));
    expect(got?.controller).toEqual(controller);
  });

  it("updateNodeSession stores a session id keyed (runId, nodeId)", async () => {
    const id = runId("session");
    const store = newStore();
    await Effect.runPromise(store.createRun(createRequest(id, ["only"])));
    await Effect.runPromise(
      store.updateNodeSession({
        nodeId: "only",
        runId: id,
        sessionId: "sess-1",
      })
    );
    const rows = await admin<{ session_id: string }[]>`
      select session_id from moka_run_control_node_session
      where run_id = ${id} and node_id = ${"only"}
    `;
    expect(rows.map((row) => row.session_id)).toEqual(["sess-1"]);

    // Re-recording overwrites (upsert on the composite key).
    await Effect.runPromise(
      store.updateNodeSession({
        nodeId: "only",
        runId: id,
        sessionId: "sess-2",
      })
    );
    const after = await admin<{ session_id: string }[]>`
      select session_id from moka_run_control_node_session
      where run_id = ${id} and node_id = ${"only"}
    `;
    expect(after.map((row) => row.session_id)).toEqual(["sess-2"]);
  });

  it("updateNodeSession rejects an unknown node", async () => {
    const id = runId("session-missing");
    const store = newStore();
    await Effect.runPromise(store.createRun(createRequest(id, ["known"])));
    await expect(
      Effect.runPromise(
        store.updateNodeSession({
          nodeId: "ghost",
          runId: id,
          sessionId: "x",
        })
      )
    ).rejects.toThrow(NODE_MISSING);
  });

  it("writeNodeArtifact persists and upserts artifact bytes via PG", async () => {
    const id = runId("artifact");
    const store = newStore();
    await Effect.runPromise(store.createRun(createRequest(id, ["node"])));
    const ref = await Effect.runPromise(
      store.writeNodeArtifact({
        content: "first",
        name: "log.txt",
        nodeId: "node",
        runId: id,
      })
    );
    expect(ref.path).toContain(id);

    await Effect.runPromise(
      store.writeNodeArtifact({
        content: "second",
        contentType: "text/plain",
        name: "log.txt",
        nodeId: "node",
        runId: id,
      })
    );
    const rows = await admin<
      { content: string; content_type: string | null }[]
    >`
      select content, content_type from moka_run_control_node_artifact
      where run_id = ${id} and node_id = ${"node"} and name = ${"log.txt"}
    `;
    expect(rows).toEqual([{ content: "second", content_type: "text/plain" }]);
  });

  it("listRuns replays each run's manifest from PG (AC1, AC2)", async () => {
    const idA = runId("list-A");
    const idB = runId("list-B");
    const store = newStore();
    await Effect.runPromise(store.createRun(createRequest(idA, ["x"])));
    await Effect.runPromise(store.createRun(createRequest(idB, ["y"])));
    await Effect.runPromise(
      store.updateNodeStatus({
        at: nowIso(),
        nodeId: "x",
        runId: idA,
        status: "passed",
      })
    );

    const reader = newStore();
    const all = await Effect.runPromise(reader.listRuns());
    const mine = all.filter((run) => run.runId.startsWith(suitePrefix));
    const byId = new Map(mine.map((run) => [run.runId, run]));
    expect(byId.get(idA)?.nodes).toEqual({ x: "passed" });
    expect(byId.get(idB)?.nodes).toEqual({ y: "queued" });
  });

  it("applies migrations idempotently on the live DB (AC3)", async () => {
    // beforeAll migrated once; re-running must be a no-op.
    await expect(
      migratePostgresRunControlStore(dbUrl)
    ).resolves.toBeUndefined();

    const tables = await admin<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_name in (
        'moka_durable_run',
        'moka_durable_node_record',
        'moka_run_control_run',
        'moka_run_control_event',
        'moka_run_control_node_session',
        'moka_run_control_node_artifact'
      )
      order by table_name
    `;
    // A single migrate provisions BOTH the durable and run-control stores.
    expect(tables.map((row) => row.table_name)).toEqual([
      "moka_durable_node_record",
      "moka_durable_run",
      "moka_run_control_event",
      "moka_run_control_node_artifact",
      "moka_run_control_node_session",
      "moka_run_control_run",
    ]);
  });

  it("concurrent runs isolate by runId namespace (AC5)", async () => {
    const idA = runId("par-A");
    const idB = runId("par-B");
    const storeA = newStore();
    const storeB = newStore();
    await Promise.all([
      Effect.runPromise(storeA.createRun(createRequest(idA, ["shared"]))),
      Effect.runPromise(storeB.createRun(createRequest(idB, ["shared"]))),
    ]);
    // Identical nodeId "shared" across two distinct runId namespaces, advanced
    // concurrently through two separate stores to opposite states.
    await Promise.all([
      Effect.runPromise(
        storeA.updateNodeStatus({
          at: nowIso(),
          nodeId: "shared",
          runId: idA,
          status: "passed",
        })
      ),
      Effect.runPromise(
        storeB.updateNodeStatus({
          at: nowIso(),
          nodeId: "shared",
          runId: idB,
          status: "failed",
        })
      ),
    ]);

    const reader = newStore();
    const [runA, runB] = await Promise.all([
      Effect.runPromise(reader.readRun({ runId: idA })),
      Effect.runPromise(reader.readRun({ runId: idB })),
    ]);
    // Each run reads only its own state.
    expect(runA?.nodes).toEqual({ shared: "passed" });
    expect(runB?.nodes).toEqual({ shared: "failed" });
  });
});
