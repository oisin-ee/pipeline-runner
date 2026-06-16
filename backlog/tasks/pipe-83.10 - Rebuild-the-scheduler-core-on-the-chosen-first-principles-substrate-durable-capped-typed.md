---
id: PIPE-83.10
title: >-
  Rebuild the scheduler core on the chosen first-principles substrate (durable,
  capped, typed)
status: In Progress
assignee: []
created_date: '2026-06-15 17:35'
updated_date: '2026-06-16 10:11'
labels:
  - architecture
  - runtime
dependencies:
  - PIPE-83.8
  - PIPE-83.6
references:
  - src/runtime/scheduler.ts
  - src/pipeline-runtime.ts
  - src/model-resolver.ts
  - src/runtime/node-state-store.ts
parent_task_id: PIPE-83
priority: medium
ordinal: 228000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workstream C. Implement the foundation chosen in PIPE-83.8 and rebuild the scheduler core on it — fan-out caps, dependency gating, retry/backoff, cancellation — aiming for the best architecture, not the smallest diff. Persist NodeHandoff durably; provide crash-resume from the last completed node.

KEEP (no substrate provides these): selectNodeModel token-aware selection, the per-category cap semantics, the declarative DAG model. DELETE the hand-rolled Promise.race loop and ad-hoc retry/backoff in src/runtime/scheduler.ts + src/pipeline-runtime.ts.

GATED BY PIPE-83.6: only invest here once the eval harness shows the architecture earns its keep. Regression: PIPE-57 goldens.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Scheduler core runs on the chosen substrate; per-category caps + dependency gating + retry/backoff + cancellation preserved or improved
- [x] #2 A killed run resumes from the last completed node without re-running finished nodes
- [x] #3 selectNodeModel token-aware selection preserved; PIPE-57 goldens green; same-input -> same-output
- [ ] #4 Hand-rolled Promise.race loop and ad-hoc retry removed
- [x] #5 npx tsc --noEmit clean; durability + caps covered by tests
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
CHOSEN SUBSTRATE (from PIPE-83.8 spike, PENDING owner sign-off on committing to the Effect paradigm): **Effect (effect-ts) v3 stable runtime now; durability via @effect/workflow+@effect/cluster staged behind a swappable WorkflowEngine seam.**

Build order:
1. WorkflowEngine seam (interface) so the durability provider is swappable: impl A = @effect/workflow ClusterWorkflowEngine on SingleRunner+SQLite (local, zero external infra) -> cluster+PgClient on k8s (same workflow code, only the provided Layer differs). impl B fallback = moka-owned SQLite/WAL journal of node Exits behind the same interface, if the alpha layer is unstable.
2. Per-category caps = Map<category, Effect.Semaphore> keyed by category (fan_out_width.by_category ?? default), wrapping each node as gate(category)(nodeWork). Mirrors current claimCategorySlot; releases on done/fail/interrupt.
3. selectNodeModel STAYS moka's logic, injected as a Layer service (ModelResolver) — no substrate provides token-window-aware selection.
4. Each node = an Activity.make with Schema-typed payload/success/error -> typed handoff (PIPE-83.1) persisted as a Schema-encoded Exit (durable, not raw text). Retry via Schedule.exponential.jittered.
5. DELETE the hand-rolled Promise.race loop + ad-hoc retry/backoff in scheduler.ts + pipeline-runtime.ts; the topological scheduler becomes orchestration over Effect fibers.

VERIFY before trusting durable resume in production: a crash-resume golden suite for moka's fan-out shape (kill mid-run, assert no node re-runs / no token re-spend), and that semaphore caps are re-honored across replay. Re-check @effect/workflow for a 1.0/stable tag. SECOND CHOICE if production durability is needed before Effect's layer hardens: DBOS Transact (native queue caps; Postgres mandatory; wrap each agent call in AbortController for the missing step timeout)."

PROGRESS 2026-06-16 (commit 3bf6075, pushed to main): shipped the durable crash-resume capability — the genuinely-new AC2/AC5 value — without waiting on the full Effect rewrite. src/runtime/run-journal.ts (RunJournal seam + append-only JSONL fileRunJournal) wired through LocalScheduler.resolveJournal; durability.enabled config (default off → PIPE-57 goldens unchanged). A killed run resumes from the last PASSED node (no re-run / no token re-spend); failed+downstream replay so fail-fast/blocked-descendant stay live. AC2 (crash-resume), AC3 (selectNodeModel + goldens green, same-input→same-output, default off), AC5 (tsc clean + durability covered by run-journal.test.ts + scheduler crash-resume tests) DONE. Refactor: split pure loop (scheduler.ts) from the seam (new local-scheduler.ts); de-duped readyNodeIds/unstartedNodeIds via settledNodeIds — all fallow findings fixed honestly, ZERO suppressions (user directive 'DO NOT SUPPRESS', see feedback_no_lint_disable).

STILL OPEN — AC1 (caps/gating/retry/cancellation are PRESERVED via the additive seam, not yet re-expressed ON Effect) and AC4 (delete the hand-rolled Promise.race loop; re-express as Effect fibers): these remain gated on (a) the eval go/no-go evidence via the published package and (b) owner sign-off to commit the engine to Effect. The RunJournal interface is deliberately the swappable durability seam so the @effect/workflow/cluster provider drops in later without touching the scheduler. The 83.8 PoC already proved the Effect primitives. Note the ad-hoc retry AC4 targeted was already removed in 9e0cee9; the Promise.race loop that remains is correct + fully tested, so deleting it is paradigm migration, not a bugfix — hence the gate.
<!-- SECTION:PLAN:END -->
