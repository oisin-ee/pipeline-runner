import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { migratePostgresRunControlStore } from "../src/run-control/postgres/postgres-run-control-store";
import { resolveRunControlStore } from "../src/run-control/run-control-store";
import type {
  CreateRunRequest,
  RunControlStore,
} from "../src/run-control/run-control-store";

// PIPE-91.12: cutover integration against the REAL cluster Postgres (no
// testcontainer, no tunnel). Set MOKA_PG_TEST_URL to the (port-forwarded)
// cluster db.url to run the Postgres cases; unset skips them so the default
// test run stays infra-free. The filesystem-selection case always runs.
const PG_URL = process.env.MOKA_PG_TEST_URL ?? "";
const describePg = PG_URL ? describe : describe.skip;
const DB_URL_REQUIRED_RE = /db\.url-required.*momokaya\.db\.url/u;

const nowIso = (): string => new Date().toISOString();

const createRequest = (runId: string, nodeIds: string[]): CreateRunRequest => ({
  effort: "normal",
  mode: "write",
  nodeIds,
  runId,
  target: "local",
});

// Resolve the store through the PIPE-91.12 seam inside a scope so the Postgres
// connection is acquired and released exactly once per use — the close()
// lifecycle the cutover owns. Every call is a fresh resolution, modelling a
// fresh process reading the run back.
const withStore = async <A>(
  dbUrl: Parameters<typeof resolveRunControlStore>[0],
  workspaceRoot: string,
  use: (store: RunControlStore) => Effect.Effect<A, unknown>
): Promise<A> =>
  await Effect.runPromise(
    Effect.scoped(
      resolveRunControlStore(dbUrl, workspaceRoot).pipe(Effect.flatMap(use))
    )
  );

describe("resolveRunControlStore required DB policy", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "run-control-cutover-fs-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("db.url absent fails before selecting or creating a filesystem store (AC1, AC3)", async () => {
    const runId = "run-file-select";
    await expect(
      withStore(undefined, workspaceRoot, (store) =>
        store.createRun(createRequest(runId, ["only"]))
      )
    ).rejects.toThrow(DB_URL_REQUIRED_RE);

    expect(existsSync(join(workspaceRoot, ".pipeline", "runs", runId))).toBe(
      false
    );
    expect(existsSync(join(workspaceRoot, ".pipeline"))).toBe(false);
  });

  it("db.url absent fails before any caller can read the legacy filesystem store (AC3)", async () => {
    await expect(
      withStore(undefined, workspaceRoot, (store) =>
        store.readRun({ runId: "run-missing-db" })
      )
    ).rejects.toThrow(DB_URL_REQUIRED_RE);

    expect(existsSync(join(workspaceRoot, ".pipeline"))).toBe(false);
  });
});

describe("legacy filesystem run-control adapter (explicit only)", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "run-control-cutover-fs-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("can still be used by explicit legacy/test fixtures (AC3)", async () => {
    const { fileRunControlStore } =
      await import("../src/run-control/run-control-store");
    const runId = "run-explicit-file-store";
    const store = fileRunControlStore(workspaceRoot);
    await Effect.runPromise(store.createRun(createRequest(runId, ["only"])));

    const manifest: unknown = JSON.parse(
      readFileSync(
        join(workspaceRoot, ".pipeline/runs", runId, "manifest.json"),
        "utf-8"
      )
    );
    expect(manifest).toMatchObject({ nodes: { only: "queued" }, runId });
    const got = await Effect.runPromise(store.readRun({ runId }));
    expect(got?.nodes).toEqual({ only: "queued" });
  });
});

describePg("resolveRunControlStore Postgres cutover (live cluster PG)", () => {
  const dbUrl = PG_URL;
  // Namespace every runId under a unique per-suite prefix so concurrent workers
  // and prior runs never collide on (run_id, node_id); cleanup is a set of
  // prefix-scoped deletes.
  const suitePrefix = `rccut-${randomUUID()}`;
  let workspaceRoot: string;
  let admin: postgres.Sql;

  const runId = (label: string): string =>
    `${suitePrefix}-${label}-${randomUUID()}`;

  beforeAll(async () => {
    // Every op is a real round-trip over the port-forwarded cluster DB, so the
    // 5s default is too tight for the multi-statement cases.
    vi.setConfig({ hookTimeout: 30_000, testTimeout: 20_000 });
    await migratePostgresRunControlStore(dbUrl);
    admin = postgres(dbUrl, { max: 1 });
    workspaceRoot = mkdtempSync(join(tmpdir(), "run-control-cutover-pg-"));
  });

  afterAll(async () => {
    const like = `${suitePrefix}%`;
    await admin`delete from moka_run_control_node_artifact where run_id like ${like}`;
    await admin`delete from moka_run_control_node_session where run_id like ${like}`;
    await admin`delete from moka_run_control_event where run_id like ${like}`;
    await admin`delete from moka_run_control_run where run_id like ${like}`;
    await admin.end();
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  it("db.url set persists + rehydrates through the seam in a fresh resolved store (AC1)", async () => {
    const id = runId("cutover");
    await withStore(dbUrl, workspaceRoot, (store) =>
      store.createRun(createRequest(id, ["build", "test"]))
    );
    await withStore(dbUrl, workspaceRoot, (store) =>
      store.updateRunStatus({ at: nowIso(), runId: id, status: "running" })
    );
    await withStore(dbUrl, workspaceRoot, (store) =>
      store.updateNodeStatus({
        at: nowIso(),
        nodeId: "build",
        runId: id,
        status: "passed",
      })
    );

    // The select chose Postgres, so NOTHING was written to the filesystem store.
    expect(existsSync(join(workspaceRoot, ".pipeline/runs", id))).toBe(false);

    // A fresh resolution (its own connection) replays the event log from PG.
    const got = await withStore(dbUrl, workspaceRoot, (store) =>
      store.readRun({ runId: id })
    );
    expect(got?.status).toBe("running");
    expect(got?.nodes).toEqual({ build: "passed", test: "queued" });
  });

  it("concurrent cutover resolutions isolate by runId namespace (AC5)", async () => {
    const idA = runId("par-A");
    const idB = runId("par-B");
    await Promise.all([
      withStore(dbUrl, workspaceRoot, (store) =>
        store.createRun(createRequest(idA, ["shared"]))
      ),
      withStore(dbUrl, workspaceRoot, (store) =>
        store.createRun(createRequest(idB, ["shared"]))
      ),
    ]);
    // Identical nodeId "shared" across two distinct runId namespaces, advanced
    // concurrently through separately resolved stores to opposite states.
    await Promise.all([
      withStore(dbUrl, workspaceRoot, (store) =>
        store.updateNodeStatus({
          at: nowIso(),
          nodeId: "shared",
          runId: idA,
          status: "passed",
        })
      ),
      withStore(dbUrl, workspaceRoot, (store) =>
        store.updateNodeStatus({
          at: nowIso(),
          nodeId: "shared",
          runId: idB,
          status: "failed",
        })
      ),
    ]);

    const [runA, runB] = await Promise.all([
      withStore(dbUrl, workspaceRoot, (store) => store.readRun({ runId: idA })),
      withStore(dbUrl, workspaceRoot, (store) => store.readRun({ runId: idB })),
    ]);
    expect(runA?.nodes).toEqual({ shared: "passed" });
    expect(runB?.nodes).toEqual({ shared: "failed" });
  });
});
