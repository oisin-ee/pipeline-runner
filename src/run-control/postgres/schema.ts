import {
  bigserial,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { MokaRunControlEvent, MokaRunManifest } from "../contracts";

/**
 * PIPE-91.11: Drizzle schema backing the Postgres {@link RunControlStore}. The
 * run-control store is EVENT-SOURCED, so the shape differs from the PIPE-91.4
 * durable store: a base manifest plus an append-only event log that `readRun`
 * replays into the live manifest.
 *
 * - `moka_run_control_run` — one row per run, holding the base manifest
 *   (`createRun` output, `events: []`) that updates layer onto. `recordEvent`
 *   never mutates it; `updateRunController` patches only the `controller` field.
 * - `moka_run_control_event` — append-only log, one row per recorded event,
 *   globally ordered by the `seq` identity column. Replay reads a run's events
 *   in `seq` order and folds them onto the base manifest.
 * - `moka_run_control_node_session` — one row per `(run_id, node_id)`, the
 *   session id the file store keeps in `status.json`.
 * - `moka_run_control_node_artifact` — one row per `(run_id, node_id, name)`,
 *   the artifact bytes the file store keeps under `nodes/<nodeId>/<name>`.
 *
 * Table names are prefixed (`moka_run_control_`) because the cluster Postgres is
 * shared with the durable store (`moka_durable_*`) and other tenants.
 */
export const runControlRun = pgTable("moka_run_control_run", {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  manifest: jsonb("manifest").$type<MokaRunManifest>().notNull(),
  runId: text("run_id").primaryKey(),
});

export const runControlEvent = pgTable("moka_run_control_event", {
  event: jsonb("event").$type<MokaRunControlEvent>().notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  runId: text("run_id")
    .notNull()
    .references(() => runControlRun.runId),
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
});

export const runControlNodeSession = pgTable(
  "moka_run_control_node_session",
  {
    nodeId: text("node_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runControlRun.runId),
    sessionId: text("session_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.nodeId] })]
);

export const runControlNodeArtifact = pgTable(
  "moka_run_control_node_artifact",
  {
    content: text("content").notNull(),
    contentType: text("content_type"),
    name: text("name").notNull(),
    nodeId: text("node_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runControlRun.runId),
  },
  (table) => [primaryKey({ columns: [table.runId, table.nodeId, table.name] })]
);
