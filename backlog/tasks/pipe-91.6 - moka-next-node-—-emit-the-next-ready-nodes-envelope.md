---
id: PIPE-91.6
title: moka next node — emit the next ready node's envelope
status: Done
assignee: []
created_date: "2026-06-26 17:21"
updated_date: "2026-06-26 19:59"
labels: []
dependencies:
  - PIPE-91.2
  - PIPE-91.4
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/run-control/commands.ts
  - src/runtime/scheduler.ts
parent_task_id: PIPE-91
priority: high
ordinal: 280000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: a CLI subcommand (under the existing run-control command group — src/run-control/commands.ts registers runs/status/logs/stop/export; mirror the src/commands/ticket/ per-subcommand registry pattern) that advances ONE step of a persisted run: read run state from the durable store (PIPE-91.4), compute the next ready node, and EMIT its NextNodeEnvelope (PIPE-91.2) WITHOUT running it. This is the pause-and-await-submit debug plug over the runNode seam (decision #1). Requires exposing the scheduler's readiness computation (readyNodeIds in src/runtime/scheduler.ts) as a pure exported query — a small SHAPE-preserving extraction — so it is reused, not duplicated, and the loop need not run.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 moka next node <runId> prints the next ready node's envelope from persisted state -- Evidence: integration test seeds a run in the store, asserts the emitted envelope = the next ready node
- [ ] #2 Readiness is a pure exported function reused by both the command and the scheduler (not duplicated) -- Evidence: unit test on the extracted readiness fn; scheduler still consumes it; pnpm run check green
- [ ] #3 No ready node (all done/blocked) -> a clear terminal signal -- Evidence: test asserts the done-state output + exit code
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + next-node + scheduler tests ran fresh; output recorded
<!-- DOD:END -->
