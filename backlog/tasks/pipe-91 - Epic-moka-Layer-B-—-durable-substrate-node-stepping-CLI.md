---
id: PIPE-91
title: 'Epic: moka Layer B — durable substrate + node-stepping CLI'
status: To Do
assignee: []
created_date: '2026-06-26 17:20'
labels:
  - epic
dependencies: []
references:
  - docs/moka-orchestrator-design.md
priority: high
ordinal: 274000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make moka own the cross-invocation execution loop on a durable Postgres substrate, and expose a pluggable debug executor that steps a run node-by-node. Layer A (PIPE-90, the refusable 'moka ticket complete' gate) is landing; Layer B is the durable state + stepping that makes moka the cross-invocation state authority.

Three pillars (design decisions #1, #8 + the node-execution-protocol open risk):
1. Durable Postgres substrate — one store, a db.url setting, schema/migrations; record node inputs+outputs+criteria keyed (runId,nodeId), queryable + resumable across invocations. Replaces the ephemeral per-run JSONL journal (src/runtime/run-journal.ts). Borrow PERSISTENCE only (pg/postgres.js + Drizzle/Kysely; steal DBOS's step-keyed-checkpoint idea), NOT an orchestration engine. KEEP the Effect scheduler (one-engine intact).
2. Node-execution protocol — the exact NextNodeEnvelope emitted by 'moka next node' and the submit-result input; executor-agnostic (same contract for the spawn plug and the human/debug plug). Resolves the design OPEN RISK 'node-execution protocol shape unspecified'.
3. CLI node-stepping — 'moka next node' (emit a node's prompt+criteria+upstream outputs), submit-result (feed a RuntimeNodeResult back), and 'moka resume' (rehydrate from Postgres + continue) — the debug plug over the existing runNode seam (src/runtime/scheduler.ts).

Shape: cut the two shared CONTRACTS first (durable-store interface + node-execution-protocol types) so downstream lanes parallelize, exactly as Layer A cut unmet[]/CompletionClaim/GateVerdict first. Modules follow the src/runtime/<capability>/{name.ts,name.test.ts,index.ts} convention.

Non-goals (NOT this epic): one-shot planner + re-plan escalation (design decisions #3/#4 — adjacent Layer B/C, not prerequisite to substrate+stepping); the structured-refusal gate (Layer A / PIPE-90); migrating the run-control store (src/run-control/store.ts) to Postgres (open question, journal-only here per design).

Open questions for the user (surface before build): (a) does the per-run durability toggle stay in pipeline.yaml or consolidate under global db.url; (b) Postgres availability in local dev (testcontainer vs shared cluster vs tunnel); (c) should the run-control store also move to Postgres later. Design: docs/moka-orchestrator-design.md.
<!-- SECTION:DESCRIPTION:END -->
