---
id: PIPE-91
title: 'Epic: moka Layer B — durable substrate + node-stepping CLI'
status: Done
assignee: []
created_date: '2026-06-26 17:20'
updated_date: '2026-06-26 23:13'
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
1. Durable Postgres substrate — ONE store, a single global db.url setting, schema/migrations; record node inputs+outputs+criteria keyed (runId,nodeId), queryable + resumable across invocations. BOTH on-disk stores move to Postgres: the ephemeral per-run JSONL journal (src/runtime/run-journal.ts) AND the run-control store (src/run-control/store.ts — manifests/events/node-status). Borrow PERSISTENCE only (pg/postgres.js + Drizzle/Kysely; steal DBOS's step-keyed-checkpoint idea), NOT an orchestration engine. KEEP the Effect scheduler (one-engine intact).
2. Node-execution protocol — the exact NextNodeEnvelope emitted by 'moka next node' and the submit-result input; executor-agnostic (same contract for the spawn plug and the human/debug plug). Resolves the design OPEN RISK 'node-execution protocol shape unspecified'.
3. CLI node-stepping — 'moka next node' (emit a node's prompt+criteria+upstream outputs), submit-result (feed a RuntimeNodeResult back), and 'moka resume' (rehydrate from Postgres + continue) — the debug plug over the existing runNode seam (src/runtime/scheduler.ts).

LOCKED DECISIONS folded in (2026-06-26):
- CONSOLIDATED db.url: a single global db.url in ~/.config/moka/config.yaml; its PRESENCE means durability is enabled. The per-repo pipeline.yaml durability block is REMOVED/superseded (PIPE-91.3).
- SHARED CLUSTER DB for dev + tests: integration tests and local stepping point db.url at a real cluster Postgres — no testcontainers, no tunnel. Run-state must be isolated so parallel runs/tests never collide on (runId,nodeId).
- BOTH stores migrate: run-control store migration was previously a non-goal; it is now IN scope (PIPE-91.10/91.11/91.12).

Shape: cut the shared CONTRACTS first (durable run-store interface PIPE-91.1, node-execution-protocol types PIPE-91.2, run-control store seam PIPE-91.10) so downstream lanes parallelize, exactly as Layer A cut unmet[]/CompletionClaim/GateVerdict first. Modules follow the src/runtime/<capability>/{name.ts,name.test.ts,index.ts} convention.

GATE BLAST RADIUS: the changed-files gate special-cases .pipeline/ run-state (SUPERVISOR_RUN_STATE_GLOBS in src/runtime/gates/kinds/changed-files/changed-files.ts excludes .pipeline/runs/**, .pipeline/journal/**, etc.). Moving run-state out of .pipeline/ into Postgres changes what touches the worktree, so each store cutover carries a verify AC that the gate still excludes run-state (and still gates genuine node output under .pipeline/).

Non-goals (NOT this epic): one-shot planner + re-plan escalation (design decisions #3/#4 — adjacent Layer B/C, not prerequisite to substrate+stepping); the structured-refusal gate (Layer A / PIPE-90). The run-control-store migration is NO LONGER a non-goal — it is in scope this epic.

Open questions for the user (surface before build): (a) cluster test-DB provisioning — which cluster Postgres + credentials do dev + CI integration tests use, how are creds delivered to the runner, and is a dedicated test database/schema provisioned; (b) durability.enabled deprecation path — confirm the legacy pipeline.yaml durability block should warn-and-ignore (vs hard-error) on load; (c) run-state isolation mechanism — per-test runId prefix vs test-scoped schema as the contention guard on the shared DB. Design: docs/moka-orchestrator-design.md.
<!-- SECTION:DESCRIPTION:END -->
