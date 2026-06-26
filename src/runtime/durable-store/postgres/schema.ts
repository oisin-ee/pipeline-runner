import { sql } from "drizzle-orm";
import {
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { AcceptanceCriterion, RuntimeNodeResult } from "../../contracts";

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
 * Table names are prefixed (`moka_`) because the cluster Postgres is shared.
 */
export const durableRun = pgTable("moka_durable_run", {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  runId: text("run_id").primaryKey(),
});

export const durableNodeRecord = pgTable(
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
