---
id: doc-1
title: "Incident: moka changed-files gate fails on .pipeline run-state (TOVA-767 run)"
type: guide
created_date: "2026-06-17 14:24"
---

# Incident: moka changed-files gate fails on `.pipeline/` run-state

**Date:** 2026-06-17
**Reporter:** stack-review session (consumer repo `~/dev/tova`)
**Severity:** High — `moka run --effort thorough` cannot complete _any_ write-mode multi-node run in a repo where run-state lives in the worktree; the failure is deterministic, not flaky.
**Status:** Diagnosed; fixes filed as tickets (see bottom).

## Summary

A supervised `moka run --effort thorough "TOVA-767"` (local target, write mode) in the `tova` repo **failed at the `red-*` test-writing phase**: all four red nodes and all four remediation retries failed the **`changed-files` gate** with `changed-file policy failed`, citing **only `.pipeline/` run-state files** as "changes outside allow list." No `green-*` implementation node ever ran. A secondary, transient `opencode session failed: fetch failed` also killed one node's agent.

The decisive cause is a **gate-configuration bug in the pipeline itself**: the `changed_files` gate's ignore globs exclude _some_ `.pipeline/` subpaths but **not** the run-control state directories the supervisor writes during the run. So the supervisor's own bookkeeping writes are attributed to the node under test and fail its gate — every time, in any repo where `.pipeline/runs` is inside the worktree.

## Environment

- **Run id:** `run-4a0f183d-2776-4828-a86b-4b89e969c6cd`
- **Command:** `moka run --effort thorough "TOVA-767"` (`moka` 2.10.0), target `local`, mode `write`
- **Consumer repo:** `~/dev/tova` (epic `TOVA-767`, 25 child tickets, 46-node schedule)
- **Runner:** `opencode`; model selection `openai/gpt-5.5-high`
- **Schedule:** generated OK → `backlog-intake` PASS → `research` PASS → `red-*` phase FAILED → pipeline aborted before any `green-*`.

## Root cause #1 (primary, deterministic) — changed-files gate does not exclude `.pipeline/` run-state

The `changed_files` gate compares the worktree's changed files against each node's allow list. The supervisor writes its **own** run-state into the worktree under `.pipeline/runs/<run-id>/…` and `.pipeline/journal/…` _while nodes execute_. Those writes are not on any node's allow list, so the gate fails the node.

Evidence — every red gate failed with the same shape (run log):

```
Gate failed: red-app-quality-tests:remediate:red-app-test-files:1/red-app-test-files
  reason=changed-file policy failed
  evidence=changes outside allow list:
    .pipeline/journal/run-4a0f183d-…jsonl,
    .pipeline/runs/run-4a0f183d-…/events.jsonl,
    .pipeline/runs/run-4a0f183d-…/runtime-events.jsonl,
    .pipeline/runs/run-4a0f183d-…/status.json,
    .pipeline/runs/run-4a0f183d-…/nodes/<node>/stdout.jsonl, …
```

The gate **already** ignores some `.pipeline/` paths but not the run-state ones:

- `src/gates.ts:337-338` ignore list contains `**/.pipeline/host-resources/**` and `**/.pipeline/skills/**` — but **not** `**/.pipeline/runs/**`, `**/.pipeline/journal/**`, or top-level run-state files.
- The run-control store writes exactly those uncovered paths: `src/run-control/store.ts:112` `RUNS_DIRECTORY = ".pipeline/runs"` (also `src/run-control/commands.ts:45`, `src/run-control/runtime-reporter.ts:31`). The journal writer (`src/runtime/run-journal.ts`, via `fileRunJournal`) writes `.pipeline/journal/…`.
- Gate logic that emits the failure: `src/runtime/gates/gates.ts:632` (`policy = gate.changed_files`), `:650` (`changes outside allow list: …`), `:671` (`reason: "changed-file policy failed"`).
- Precedent that `.pipeline` is meant to be invisible to repo scanning: `src/context/repo-map.ts:78` already lists `.pipeline` in `SKIP_DIRS`.

**Why it's deterministic:** the run-state files change continuously during the run and are never in any node's allow list, so _any_ write-mode node gate fails regardless of whether the agent produced correct output. The remediation retries fail identically.

## Root cause #2 (secondary, transient) — opencode runner dies on `fetch failed`

`red-backend-resilience-tests` (profile `moka-test-writer`, runner `opencode`, model `openai/gpt-5.5-high`) failed its agent with:

```
stderr: opencode session failed: fetch failed
Node: status=failed attempts=1 exit=1   (agent exit=70)
```

This is a network/model-gateway transient (the session ran during a window of upstream API overload — the same window produced repeated `529 Overloaded` errors for other agents). The node failed after a single attempt with no transient-aware retry/backoff at the runner boundary. This compounded #1 but is not the primary blocker (the gate would have failed every node anyway).

## Impact

- **Zero tickets implemented.** The run aborted before any `green-*` node.
- **Consumer working tree left dirty (mode=write, local).** The red phase wrote partial, unvalidated edits directly into `~/dev/tova` before failing:
  - `apps/app/features/pay/__tests__/picker.test.tsx` (+51/−4)
  - `apps/backend/cmd/server/main_test.go` (+177)
  - `apps/backend/internal/server/payments_test.go` (+85)
    These were never validated (never reached green) and should be reverted in the consumer repo.
- `.pipeline/runs/<run-id>/` and `.pipeline/journal/` left untracked in the consumer repo; **`.pipeline/` is not gitignored** in `tova`.

## Recommended fixes

1. **(P1) Exclude run-state from the `changed_files` gate.** Add `**/.pipeline/runs/**`, `**/.pipeline/journal/**`, `**/.pipeline/runtime-events.jsonl`, and `**/.pipeline/**/status.json` to the gate ignore globs at `src/gates.ts:337` — or, simplest and most robust, ignore `**/.pipeline/**` wholesale in the changed-files gate (consistent with `repo-map.ts` `SKIP_DIRS`). Run-state is supervisor output, never node-authored content under test.
   - Alternative/again-more-robust: write run-state **outside the worktree** (e.g. an OS state/cache dir keyed by run-id) so it can never appear in a worktree diff. Heavier change.
2. **(P2) Make the runner resilient to transient `fetch failed`.** Add bounded retry/backoff at the `opencode` runner boundary for network/gateway errors (`fetch failed`, connection reset, 429/5xx) before marking the node failed, distinct from gate failures. Consider honoring the existing run effort to bound total retry time.
3. **(P3, consumer-side, advisory)** Recommend consumers gitignore `.pipeline/` (or the pipeline `init` adds it), so leftover run-state isn't mistaken for source changes.

## Verification for the fix

- A `moka run --effort thorough` write-mode run in a repo with `.pipeline/runs` inside the worktree reaches `green-*` nodes without any node failing the changed-files gate on `.pipeline/` paths.
- A unit test for the `changed_files` gate asserts that paths under `.pipeline/runs/**` and `.pipeline/journal/**` are excluded from the allow-list comparison.
- A runner-boundary test asserts a transient `fetch failed` is retried (bounded) rather than immediately failing the node.

## Related tickets

- **PIPE-85** — changed-files gate must exclude `.pipeline/` run-state from the allow-list comparison (P1; fixes root cause #1).
- **PIPE-86** — opencode runner: retry transient `fetch failed` before failing the node (P2; root cause #2).
