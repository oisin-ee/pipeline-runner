---
id: PIPE-61
title: Add live terminal rendering for hands-on local runs
status: To Do
assignee: []
created_date: '2026-06-11 20:40'
labels:
  - feature
  - cli
  - ux
dependencies:
  - PIPE-60
priority: medium
ordinal: 193000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4: the hands-on mode for the owner to pair with an agent at a desk. The runtime already emits a full event stream (workflow.planned, node.start/finish, gate.*, output.recorded, hook.*, etc.). Add a terminal renderer to the CLI that consumes those events and shows: (1) live per-node status (running, passed, failed, gate-blocked, retrying), (2) streamed agent output per node (live stdout from opencode), (3) gate pass/fail verdicts, (4) workflow summary on completion. The owner calls `moka run quick` or `moka run inspect` locally and watches progress in the terminal instead of waiting for end-of-run summary. This is rendering an existing contract, not new semantics. Two sub-variants of hands-on: local CLI (this ticket) and devspace runner pod (separate ticket PIPE-62).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The CLI (index.ts or new cli/render.ts) consumes runtime events and emits formatted per-node status updates to stdout.
- [ ] #2 Agent output (node.output.recorded events) is streamed live as it arrives, not buffered.
- [ ] #3 Gate verdicts, retry decisions, and final result are rendered with context (node ID, attempt number, evidence).
- [ ] #4 Local runs (`moka run ...` on the owner machine) use this renderer by default; Argo submission still uses end-of-run summary.
- [ ] #5 Test: run a small locally-executed plan and verify terminal output includes the key status updates.
<!-- AC:END -->
