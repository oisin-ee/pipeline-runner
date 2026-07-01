import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import postgres from "postgres";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  MokaRunController,
  MokaRunEvent,
} from "../src/run-control/contracts";
import {
  migratePostgresRunControlStore,
  type PostgresRunControlStore,
  postgresRunControlStore,
} from "../src/run-control/postgres/postgres-run-control-store";
import {
  type CreateRunRequest,
  fileRunControlStore,
  type RunControlStore,
} from "../src/run-control/run-control-store";

/**
 * C2 — the single `RunControlStore` contract suite. The interface IS the test
 * surface: every backend behind the PIPE-91.10 seam must agree on the
 * event-sourced semantics, so the same behavioural spec runs against EACH
 * adapter via the `backends` table below.
 *
 * The filesystem adapter always runs (it holds no infra), so the seam invariant
 * is checked on every default test run — not only when a database is reachable.
 * The Postgres row runs when `MOKA_PG_TEST_URL` points at a (port-forwarded)
 * cluster db.url, exactly like the standalone Postgres suite; otherwise it skips
 * so the default run stays infra-free.
 *
 * Backend-specific concerns (the `.pipeline/runs` on-disk layout, the SQL
 * tables) stay in their own suites — `run-control-store-seam.test.ts` and
 * `postgres/postgres-run-control-store.test.ts`. This suite asserts only what
 * the seam promises to every consumer of `RunControlStore`.
 */

const run = <A>(fx: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(fx);

const DIFFERENT_PUBLISHED_SCHEDULE_ERROR =
  /already has a different published schedule/;

/**
 * A per-test isolated world over one backend. `make()` opens a FRESH handle over
 * the SAME backing store, so a handle opened after writes proves durable replay
 * (the manifest is reconstructed from persisted events, not in-memory state).
 */
interface StoreWorld {
  cleanup(): Promise<void>;
  make(): RunControlStore;
  runId(label: string): string;
}

interface Backend {
  enabled: boolean;
  name: string;
  openWorld(): StoreWorld;
  setupSuite(): Promise<void>;
}

const fileBackend: Backend = {
  enabled: true,
  name: "file",
  setupSuite: () => Promise.resolve(),
  openWorld: () => {
    const root = mkdtempSync(join(tmpdir(), "rc-contract-file-"));
    return {
      make: () => fileRunControlStore(root),
      // The workspace is isolated per test, so a bare label is already unique.
      runId: (label) => label,
      cleanup: () =>
        Promise.resolve(rmSync(root, { force: true, recursive: true })),
    };
  },
};

const PG_URL = process.env.MOKA_PG_TEST_URL ?? "";

const postgresBackend: Backend = {
  enabled: Boolean(PG_URL),
  name: "postgres",
  setupSuite: () => migratePostgresRunControlStore(PG_URL),
  openWorld: () => {
    // Namespace every runId under a per-test prefix so concurrent workers and
    // prior runs never collide on (run_id, node_id); cleanup is a set of
    // prefix-scoped deletes. The label keeps its position in the prefix so
    // runIds sort by label (e.g. "...-run-a-<uuid>" < "...-run-b-<uuid>").
    const prefix = `rccontract-${randomUUID()}`;
    const opened: PostgresRunControlStore[] = [];
    return {
      make: () => {
        const store = postgresRunControlStore(PG_URL);
        opened.push(store);
        return store;
      },
      runId: (label) => `${prefix}-${label}-${randomUUID()}`,
      cleanup: async () => {
        for (const store of opened) {
          await store.close();
        }
        const admin = postgres(PG_URL, { max: 1 });
        const like = `${prefix}%`;
        await admin`delete from moka_run_control_node_artifact where run_id like ${like}`;
        await admin`delete from moka_run_control_node_session where run_id like ${like}`;
        await admin`delete from moka_run_control_event where run_id like ${like}`;
        await admin`delete from moka_run_control_run where run_id like ${like}`;
        await admin.end();
      },
    };
  },
};

const backends: Backend[] = [fileBackend, postgresBackend];

for (const backend of backends) {
  const describeBackend = backend.enabled ? describe : describe.skip;

  describeBackend(`RunControlStore contract · ${backend.name}`, () => {
    let world: StoreWorld;

    beforeAll(async () => {
      if (backend.name === "postgres") {
        // Every op is a real round-trip over the port-forwarded cluster DB, so
        // the 5s default is too tight for migrate + multi-statement cases.
        vi.setConfig({ hookTimeout: 30_000, testTimeout: 20_000 });
      }
      await backend.setupSuite();
    });

    beforeEach(() => {
      world = backend.openWorld();
    });

    afterEach(async () => {
      await world.cleanup();
    });

    it("initialises a queued manifest readable through a fresh handle", async () => {
      const id = world.runId("create");
      const create: CreateRunRequest = {
        effort: "thorough",
        mode: "write",
        nodeIds: ["planner", "writer"],
        runId: id,
        target: "remote",
      };

      const created = await run(world.make().createRun(create));
      expect(created).toMatchObject({
        effort: "thorough",
        events: [],
        mode: "write",
        nodes: { planner: "queued", writer: "queued" },
        runId: id,
        status: "queued",
        target: "remote",
      });

      const replayed = await run(world.make().readRun({ runId: id }));
      expect(replayed).toMatchObject({
        nodes: { planner: "queued", writer: "queued" },
        runId: id,
        status: "queued",
      });
    });

    it("reconstructs the manifest by replaying recorded events", async () => {
      const id = world.runId("replay");
      await run(
        world.make().createRun({
          effort: "thorough",
          mode: "write",
          nodeIds: ["planner", "writer"],
          runId: id,
          target: "remote",
        })
      );

      const events: MokaRunEvent[] = [
        {
          at: "2026-06-26T10:00:00.000Z",
          status: "running",
          type: "run.status",
        },
        {
          at: "2026-06-26T10:00:01.000Z",
          nodeId: "planner",
          status: "passed",
          type: "node.status",
        },
        {
          at: "2026-06-26T10:00:02.000Z",
          nodeId: "writer",
          status: "failed",
          type: "node.status",
        },
        {
          at: "2026-06-26T10:00:03.000Z",
          status: "failed",
          type: "run.status",
        },
      ];

      const writer = world.make();
      for (const event of events) {
        await run(writer.recordEvent({ event, runId: id }));
      }

      // A fresh handle proves replay reads from the persisted event log.
      const replayed = await run(world.make().readRun({ runId: id }));
      expect(replayed).toMatchObject({
        nodes: { planner: "passed", writer: "failed" },
        runId: id,
        status: "failed",
      });
      expect(replayed?.events).toEqual(events);
    });

    it("applies the convenience run-status, node-status and session writers", async () => {
      const id = world.runId("writers");
      await run(
        world.make().createRun({
          effort: "quick",
          mode: "read-only",
          nodeIds: ["writer"],
          runId: id,
          target: "local",
        })
      );

      const writer = world.make();
      await run(
        writer.updateRunStatus({
          at: "2026-06-26T11:00:00.000Z",
          runId: id,
          status: "running",
        })
      );
      await run(
        writer.updateNodeStatus({
          at: "2026-06-26T11:00:01.000Z",
          nodeId: "writer",
          runId: id,
          status: "passed",
        })
      );
      // The session id is persisted alongside the node but is not part of the
      // reconstructed manifest, so the contract asserts only that it is accepted
      // and leaves the surfaced node status intact.
      await run(
        writer.updateNodeSession({
          nodeId: "writer",
          runId: id,
          sessionId: "session-123",
        })
      );

      const replayed = await run(world.make().readRun({ runId: id }));
      expect(replayed).toMatchObject({
        nodes: { writer: "passed" },
        runId: id,
        status: "running",
      });
    });

    it("persists the supervising controller onto the manifest", async () => {
      const id = world.runId("controller");
      const writer = world.make();
      await run(
        writer.createRun({
          effort: "normal",
          mode: "write",
          nodeIds: ["writer"],
          runId: id,
          target: "local",
        })
      );

      const controller: MokaRunController = {
        argv: ["moka", "run"],
        cwd: "/workspace",
        paths: writer.statusPaths({ runId: id }),
        pid: 4242,
        startedAt: "2026-06-26T12:00:00.000Z",
      };

      const updated = await run(
        writer.updateRunController({ controller, runId: id })
      );
      expect(updated.controller).toEqual(controller);

      const replayed = await run(world.make().readRun({ runId: id }));
      expect(replayed?.controller).toEqual(controller);
    });

    it("writes a node artifact and returns its locator", async () => {
      const id = world.runId("artifact");
      const writer = world.make();
      await run(
        writer.createRun({
          effort: "normal",
          mode: "write",
          nodeIds: ["writer"],
          runId: id,
          target: "local",
        })
      );

      const artifact = await run(
        writer.writeNodeArtifact({
          content: '{"result":"ok"}\n',
          name: "summary.json",
          nodeId: "writer",
          runId: id,
        })
      );
      expect(artifact.path).toContain("nodes/writer/summary.json");
    });

    it("lists runs ordered by runId", async () => {
      const idB = world.runId("run-b");
      const idA = world.runId("run-a");
      const writer = world.make();
      for (const runId of [idB, idA]) {
        await run(
          writer.createRun({
            effort: "normal",
            mode: "write",
            nodeIds: ["writer"],
            runId,
            target: "local",
          })
        );
      }

      const runs = await run(world.make().listRuns());
      // listRuns spans the whole backing store, so scope the assertion to the
      // two runs this test created; both backends must return them sorted.
      const ours = runs
        .map((manifest) => manifest.runId)
        .filter((runId) => runId === idA || runId === idB);
      expect(ours).toEqual([idA, idB]);
    });

    it("returns undefined for an unknown run", async () => {
      const missing = await run(
        world.make().readRun({ runId: world.runId("missing") })
      );
      expect(missing).toBeUndefined();
    });

    // AC1: createRun is idempotent — second call returns the same manifest and
    // does not reset the event log accumulated between the two calls.
    it("createRun is idempotent — second call returns the existing manifest without resetting events", async () => {
      const id = world.runId("idempotent");
      const create: CreateRunRequest = {
        effort: "normal",
        mode: "write",
        nodeIds: ["a", "b"],
        runId: id,
        target: "local",
      };

      const first = await run(world.make().createRun(create));

      // Record an event between the two createRun calls.
      await run(
        world.make().recordEvent({
          event: {
            at: "2026-06-28T00:00:00.000Z",
            status: "running",
            type: "run.status",
          },
          runId: id,
        })
      );

      // Second call — must not error, must not reset the event log.
      const second = await run(world.make().createRun(create));
      expect(second.runId).toBe(first.runId);
      expect(second.nodes).toEqual(first.nodes);
      expect(second.status).toBe(first.status);

      // Events appended between the two createRun calls survive.
      const replayed = await run(world.make().readRun({ runId: id }));
      expect(replayed?.status).toBe("running");
    });

    // AC2: createRun persists manifest.schedule when provided; readRun returns it.
    it("createRun persists manifest.schedule; readRun returns it round-trip", async () => {
      const id = world.runId("schedule");
      const scheduleYaml =
        "kind: pipeline-schedule\nversion: 1\nschedule_id: ac2-test\ngenerated_at: 2026-06-28T00:00:00.000Z\nsource_entrypoint: quick\nroot_workflow: root\ntask: test";

      await run(
        world.make().createRun({
          effort: "normal",
          mode: "write",
          nodeIds: ["a"],
          runId: id,
          schedule: scheduleYaml,
          target: "local",
        })
      );

      // Fresh handle — proves durable round-trip, not in-memory state.
      const replayed = await run(world.make().readRun({ runId: id }));
      expect(replayed?.schedule).toBe(scheduleYaml);
    });

    it("publishSchedule adds final nodes, preserves phase status, and is idempotent for the same schedule", async () => {
      const id = world.runId("publish-schedule");
      const scheduleYaml =
        "kind: pipeline-schedule\nversion: 1\nschedule_id: published\ngenerated_at: 2026-06-28T00:00:00.000Z\nsource_entrypoint: quick\nroot_workflow: root\ntask: test";
      const writer = world.make();

      await run(
        writer.createRun({
          effort: "normal",
          mode: "write",
          nodeIds: ["pre-research", "pre-planning"],
          runId: id,
          target: "remote",
        })
      );
      await run(
        writer.updateNodeStatus({
          at: "2026-06-28T00:00:00.000Z",
          nodeId: "pre-research",
          runId: id,
          status: "passed",
        })
      );

      const published = await run(
        writer.publishSchedule({
          nodeIds: ["implement", "verify"],
          runId: id,
          schedule: scheduleYaml,
        })
      );
      const republished = await run(
        world.make().publishSchedule({
          nodeIds: ["implement", "verify"],
          runId: id,
          schedule: scheduleYaml,
        })
      );

      expect(published.schedule).toBe(scheduleYaml);
      expect(republished.schedule).toBe(scheduleYaml);
      expect(republished.nodes).toEqual({
        implement: "queued",
        "pre-planning": "queued",
        "pre-research": "passed",
        verify: "queued",
      });
    });

    it("publishSchedule rejects a different schedule for an already-published run", async () => {
      const id = world.runId("publish-reject");
      const writer = world.make();
      await run(
        writer.createRun({
          effort: "normal",
          mode: "write",
          nodeIds: ["pre-research"],
          runId: id,
          target: "remote",
        })
      );
      await run(
        writer.publishSchedule({
          nodeIds: ["implement"],
          runId: id,
          schedule: "schedule: one",
        })
      );

      await expect(
        run(
          writer.publishSchedule({
            nodeIds: ["implement"],
            runId: id,
            schedule: "schedule: two",
          })
        )
      ).rejects.toThrow(DIFFERENT_PUBLISHED_SCHEDULE_ERROR);
    });
  });
}
