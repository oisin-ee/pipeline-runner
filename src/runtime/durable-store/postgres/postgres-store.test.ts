import { randomUUID } from "node:crypto";

import { Option } from "effect";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AcceptanceCriterion, RuntimeNodeResult } from "../../contracts";
import {
  migratePostgresDurableStore,
  postgresDurableRunStore,
} from "./postgres-store";
import type { PostgresDurableRunStore } from "./postgres-store";
import { MOKA_POSTGRES_SCHEMA } from "./schema";

// PIPE-91.4: integration test against the REAL cluster Postgres (no
// testcontainer, no tunnel). Set MOKA_PG_TEST_URL to the (port-forwarded)
// cluster db.url to run it; unset skips the suite so the default test run stays
// infra-free.
const PG_URL = process.env.MOKA_PG_TEST_URL ?? "";
const describePg = PG_URL ? describe : describe.skip;

const passedResult = (nodeId: string): RuntimeNodeResult => ({
  attempts: 1,
  evidence: ["exit 0"],
  exitCode: 0,
  nodeId,
  output: `output of ${nodeId}`,
  status: "passed",
});

const failedResult = (nodeId: string): RuntimeNodeResult => ({
  attempts: 1,
  evidence: ["exit 1"],
  exitCode: 1,
  nodeId,
  output: `output of ${nodeId}`,
  status: "failed",
});

describePg("postgresDurableRunStore (live cluster PG)", () => {
  const dbUrl = PG_URL;
  // Namespace every runId under a unique per-suite prefix so concurrent test
  // workers and prior runs never collide on (run_id, node_id), and cleanup is a
  // single prefix-scoped delete.
  const suitePrefix = `pgtest-${randomUUID()}`;
  const openStores: PostgresDurableRunStore[] = [];
  let admin: postgres.Sql;

  const runId = (label: string): string =>
    `${suitePrefix}:${label}:${randomUUID()}`;

  const newStore = async (): Promise<PostgresDurableRunStore> => {
    const store = await postgresDurableRunStore(dbUrl);
    openStores.push(store);
    return store;
  };

  beforeAll(async () => {
    await migratePostgresDurableStore(dbUrl);
    admin = postgres(dbUrl, { max: 1 });
  });

  afterAll(async () => {
    for (const store of openStores) {
      await store.close();
    }
    await admin`
      delete from ${admin(MOKA_POSTGRES_SCHEMA)}.moka_durable_node_record
      where run_id like ${`${suitePrefix}%`}
    `;
    await admin`
      delete from ${admin(MOKA_POSTGRES_SCHEMA)}.moka_durable_run
      where run_id like ${`${suitePrefix}%`}
    `;
    await admin.end();
  });

  it("round-trips a node record through Postgres across instances (AC1, AC4)", async () => {
    const id = runId("roundtrip");
    const result = passedResult("build");
    const criteria: AcceptanceCriterion[] = [{ id: "ac1", text: "must build" }];
    const inputs = { task: "build the project" };

    const writer = await newStore();
    writer.record(id, "build", { criteria, inputs, result });
    await writer.flush();

    // A fresh instance hydrates from Postgres — proves the read came through PG.
    const reader = await newStore();
    const got = Option.getOrThrow(reader.get(id, "build"));
    expect(got.result).toEqual(result);
    expect(got.criteria).toEqual(criteria);
    expect(got.inputs).toEqual(inputs);
    expect(typeof got.recordedAt).toBe("string");
  });

  it("returns undefined for an unrecorded (runId, nodeId) pair", async () => {
    const store = await newStore();
    expect(Option.isNone(store.get(runId("missing"), "nope"))).toBe(true);
  });

  it("overwrites an existing record on re-record (ON CONFLICT DO UPDATE)", async () => {
    const id = runId("overwrite");
    const writer = await newStore();
    writer.record(id, "node", {
      criteria: [],
      inputs: undefined,
      result: passedResult("node"),
    });
    writer.record(id, "node", {
      criteria: [],
      inputs: undefined,
      result: { ...passedResult("node"), output: "second run" },
    });
    await writer.flush();

    const reader = await newStore();
    expect(Option.getOrThrow(reader.get(id, "node")).result.output).toBe(
      "second run"
    );
  });

  it("resumeCompleted returns only passed results, read back from PG (AC1)", async () => {
    const id = runId("resume");
    const writer = await newStore();
    writer.record(id, "a", {
      criteria: [],
      inputs: undefined,
      result: passedResult("a"),
    });
    writer.record(id, "b", {
      criteria: [],
      inputs: undefined,
      result: passedResult("b"),
    });
    writer.record(id, "c", {
      criteria: [],
      inputs: undefined,
      result: failedResult("c"),
    });
    await writer.flush();

    const reader = await newStore();
    const resumed = reader.resumeCompleted(id);
    expect(resumed).toHaveLength(2);
    expect(resumed.map((r) => r.nodeId).toSorted()).toEqual(["a", "b"]);
    expect(resumed.every((r) => r.status === "passed")).toBe(true);
  });

  it("toRunJournal records and resumes through PG", async () => {
    const id = runId("journal");
    const writer = await newStore();
    const journal = writer.toRunJournal(id);
    journal.record(passedResult("x"));
    journal.record(failedResult("y"));
    await writer.flush();

    const reader = await newStore();
    const resumed = reader.toRunJournal(id).resumeCompleted();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.nodeId).toBe("x");
    expect(Option.getOrThrow(reader.get(id, "x")).result.status).toBe("passed");
  });

  it("applies migrations idempotently on the live DB (AC2)", async () => {
    // beforeAll already migrated once; running again must be a no-op.
    await expect(migratePostgresDurableStore(dbUrl)).resolves.toBeUndefined();

    const tables = await admin<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = ${MOKA_POSTGRES_SCHEMA}
        and table_name in ('moka_durable_run', 'moka_durable_node_record')
      order by table_name
    `;
    expect(tables.map((t) => t.table_name)).toEqual([
      "moka_durable_node_record",
      "moka_durable_run",
    ]);
  });

  it("parallel runs do not collide on (runId, nodeId) (AC5)", async () => {
    const idA = runId("par-A");
    const idB = runId("par-B");
    const [storeA, storeB] = await Promise.all([newStore(), newStore()]);

    // Identical nodeId "shared" across two distinct runId namespaces, written
    // concurrently through two separate stores.
    storeA.record(idA, "shared", {
      criteria: [],
      inputs: { run: "A" },
      result: passedResult("shared"),
    });
    storeB.record(idB, "shared", {
      criteria: [],
      inputs: { run: "B" },
      result: passedResult("shared"),
    });
    await Promise.all([storeA.flush(), storeB.flush()]);

    const reader = await newStore();
    expect(Option.getOrThrow(reader.get(idA, "shared")).inputs).toEqual({
      run: "A",
    });
    expect(Option.getOrThrow(reader.get(idB, "shared")).inputs).toEqual({
      run: "B",
    });
    // Each run reads only its own records.
    expect(reader.resumeCompleted(idA).map((r) => r.nodeId)).toEqual([
      "shared",
    ]);
    expect(reader.resumeCompleted(idB).map((r) => r.nodeId)).toEqual([
      "shared",
    ]);
    expect(Option.isNone(reader.get(idA, "absent"))).toBe(true);
  });
});
