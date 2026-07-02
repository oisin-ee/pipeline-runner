import { sql } from "drizzle-orm";
import {
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { AcceptanceCriterion, RuntimeNodeResult } from "../../contracts";

export const MOKA_POSTGRES_SCHEMA = "moka";
export const mokaPostgresSchema = pgSchema(MOKA_POSTGRES_SCHEMA);

/**
 * PIPE-91.4: Drizzle schema backing the Postgres {@link DurableRunStore}. Two
 * tables mirror the two-dimensional `(runId, nodeId)` key the in-memory store
 * holds in a nested Map:
 *
 * - `moka_durable_run` — one row per run, the parent the node records reference.
 * - `moka_durable_node_record` — one row per `(run_id, node_id)`, carrying the
 *   node's `inputs`, terminal `result` (RuntimeNodeResult), the `criteria` the
 *   gate evaluated, a denormalised `status` for resume queries, and the
 *   server-authoritative `recorded_at` wall time.
 *
 * Tables live in the dedicated `moka` schema so runner migrations cannot create
 * or mutate pipeline-console application tables in `public`.
 */
export const durableRun = mokaPostgresSchema.table("moka_durable_run", {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  runId: text("run_id").primaryKey(),
});

export const durableNodeRecord = mokaPostgresSchema.table(
  "moka_durable_node_record",
  {
    criteria: jsonb("criteria")
      .$type<AcceptanceCriterion[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    inputs: jsonb("inputs").$type<unknown>(),
    nodeId: text("node_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    result: jsonb("result").$type<RuntimeNodeResult>().notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => durableRun.runId),
    status: text("status").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.nodeId] })]
);
