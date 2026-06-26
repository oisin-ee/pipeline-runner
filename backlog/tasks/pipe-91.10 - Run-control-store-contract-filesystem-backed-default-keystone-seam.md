---
id: PIPE-91.10
title: Run-control store contract + filesystem-backed default (keystone seam)
status: To Do
assignee: []
created_date: '2026-06-26 18:39'
labels: []
dependencies: []
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/run-control/store.ts
  - src/run-control/run-control-store.ts
parent_task_id: PIPE-91
priority: high
ordinal: 284000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: deep module wrapping the run-control store (src/run-control/store.ts) behind a swappable persistence interface, the keystone seam for the run-control Postgres migration. The run-control store's shape DIFFERS from the PIPE-91.1 durable run-store (which records (runId,nodeId) node records with inputs+outputs+criteria): run-control is an event-sourced manifest store — createRun (manifest), append+replay of an event log (events.jsonl -> replayEvents), run status, node status, node sessions, and node artifacts. Because the shape differs, it needs its own contract rather than reusing PIPE-91.1.
Define a RunControlStore interface generalizing the current file-backed functions (createRun / recordEvent / readRun / listRuns / updateRunController / updateNodeSession / writeNodeArtifact / status paths), with the existing filesystem impl kept as the default (back-compat: byte-identical to today). This is the seam the Postgres impl (PIPE-91.11) and the cutover (PIPE-91.12) consume. Cut FIRST so the run-control PG lane parallelizes — mirrors PIPE-91.1 for the journal. KEEP the Effect scheduler and the run-control command surface untouched behind the seam.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 RunControlStore interface generalizes createRun/recordEvent/readRun/listRuns/updateRunController/updateNodeSession/writeNodeArtifact and the status paths; the existing filesystem impl satisfies it -- Evidence: type def + filesystem impl; existing run-control tests pass through the interface unchanged
- [ ] #2 Default filesystem store is byte-identical to today (back-compat) -- Evidence: existing store tests pass unchanged; .pipeline/runs layout unchanged
- [ ] #3 Event-sourced replay (recordEvent then replayEvents) is preserved behind the interface -- Evidence: unit test records events and reads a replayed manifest through the seam
- [ ] #4 Run-control command surface + scheduler untouched (behind the seam) -- Evidence: commands.ts unchanged in diff; pnpm run check green
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + run-control store unit tests ran fresh; output recorded
<!-- DOD:END -->
