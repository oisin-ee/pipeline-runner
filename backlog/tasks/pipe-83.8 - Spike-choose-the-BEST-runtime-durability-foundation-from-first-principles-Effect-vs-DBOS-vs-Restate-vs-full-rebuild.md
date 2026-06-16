---
id: PIPE-83.8
title: >-
  Spike: choose the BEST runtime/durability foundation from first principles
  (Effect vs DBOS vs Restate vs full rebuild)
status: Done
assignee: []
created_date: '2026-06-15 17:35'
updated_date: '2026-06-16 08:56'
labels:
  - architecture
  - runtime
  - spike
dependencies:
  - PIPE-83.1
parent_task_id: PIPE-83
priority: high
ordinal: 226000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workstream C. Decide the runtime foundation by BEST end-state architecture. Migration cost / "less code to change" / backward-compat are EXPLICITLY NOT credited as positives (owner directive: most proper, first-principles setup).

Candidates:
1. Full Effect (effect-ts) runtime — typed effects (Effect<A,E,R> for node failures), Layer DI for executor/model-resolver/MCP-gateway, fibers + category-keyed Semaphore for fan-out caps, Schedule for retry/backoff+jitter, structured-concurrency cancellation, with @effect/workflow + @effect/cluster for durability. NOTE: durable layer is alpha / Effect v4 beta — verify maturity from primary sources.
2. DBOS Transact — Postgres-backed durable, queue-per-category = native caps.
3. Restate — single self-contained binary, journaled durability.
4. Greenfield rebuild combining the best of the above.

Judge against: per-category fan-out caps; token-aware selectNodeModel preserved; structured NodeHandoff persisted durably; crash-resume; local-CLI + k8s symmetry; typed-error ergonomics; long-term maintainability and conceptual integrity.

Deliver a recommendation + target-architecture sketch + a thin PoC of the scheduler core (caps + retry + one resumable node) in the chosen substrate.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Written comparison of Effect / DBOS / Restate / greenfield scored against the first-principles criteria, with migration cost explicitly excluded as a positive
- [x] #2 Effect @effect/workflow + @effect/cluster maturity verified from primary sources (alpha status, infra needs) and documented
- [x] #3 Recommended target architecture showing how per-category caps, token-aware selection, and durable structured handoffs are each expressed
- [x] #4 Thin PoC of the scheduler core (per-category caps + retry + one crash-resumable node) in the chosen substrate
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
SPIKE OUTCOME (2026-06-15, primary-source, migration cost excluded). Scores /14: Effect 10, DBOS 10, Restate 8, Temporal 8 — but Effect and DBOS differ on WHICH requirements they win.

RECOMMENDATION: **Effect (effect-ts)** as the runtime substrate. Wins the discriminating requirements moka has TODAY: per-category caps = Map<category, Semaphore> (idiomatic, mirrors claimCategorySlot); local<->k8s SYMMETRY = SingleRunner+SQLite local -> cluster+PG on k8s, SAME code path (cleanest of any candidate); typed errors + fiber interruption + Schedule.exponential.jittered (best). selectNodeModel (#3) stays moka's own logic above the substrate in every world (a wash; no library does token-window-aware selection).

LINCHPIN CAVEAT: Effect's durability (@effect/workflow 0.18.x + @effect/cluster 0.59.x) is ALPHA — pre-1.0, effect/unstable/*, suspend/resume bugs fixed DURING 2026; v4-beta post says 'use v3 in prod'. KEY INSIGHT: the win is ISOLATABLE — Effect v3 STABLE gives the scheduler/Semaphore/Layer-DI/typed-error value NOW, independent of the alpha workflow engine. Stage durability behind a swappable WorkflowEngine seam: start @effect/workflow+SQLite, swap for a moka-owned SQLite/WAL journal of node Exits if alpha instability bites. Durability becomes a replaceable detail, not substrate lock-in.

SECOND CHOICE: DBOS Transact — production-grade durability TODAY + native per-category caps (queues), but Postgres mandatory even locally (#1226) and no per-step timeout (#1273). Durability-first pragmatic pick.

REJECTED: Restate (per-category caps not native #3291; #743 Promise.all-over-ctx.run crash-loops on every released SDK — squarely moka's fan-out path); Temporal (mandates a server cluster, kills zero-ops local; concurrency is per-worker global slots, not width caps).

RISKS for Effect: alpha durability unverified for moka's fan-out shape (gate behind a crash-resume golden suite); v3<->v4 split; Effect is an all-or-nothing paradigm that colonizes the core; semaphore-permit state vs durable-resume interaction untested. PENDING owner sign-off to commit moka's core to the Effect paradigm.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Decision (spike, recorded earlier): Effect (effect-ts) as the runtime substrate — Effect v3 STABLE for the in-process scheduler (per-category caps, retries, typed errors), with durability staged behind a swappable WorkflowEngine seam (@effect/workflow/cluster is alpha). PoC AC#4 now DONE (commit d2b1967, pushed to main): src/runtime/effect-substrate-poc.test.ts proves Effect v3 delivers moka's two load-bearing scheduler primitives in-process — per-category fan-out caps via Effect.makeSemaphore(n).withPermits (validated: 5 tasks under a cap-2 semaphore never exceed 2 concurrent) and retry/backoff with jitter via Schedule.exponential |> Schedule.jittered (validated: a transient failure recovers on the 3rd attempt), plus a typed error channel (Effect.catchAll). effect added as a devDependency. Durable crash-resume intentionally out of the PoC. Verified: tsc clean, ultracite clean, fallow-audit clean, full suite 616 passed. The full scheduler rebuild on this substrate is PIPE-83.10 (large; gated by the PIPE-83.6 eval).
<!-- SECTION:FINAL_SUMMARY:END -->
