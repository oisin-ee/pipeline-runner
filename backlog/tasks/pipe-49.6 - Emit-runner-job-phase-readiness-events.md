---
id: PIPE-49.6
title: Emit runner-job phase readiness events
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
labels:
  - runner-job
  - events
  - observability
dependencies:
  - PIPE-49.2
  - PIPE-49.4
references:
  - src/runner-event-sink.ts
  - src/runner-job-contract.ts
modified_files:
  - src/runner-job/events.ts
  - src/runner-event-sink.ts
  - src/runner-job-contract.ts
parent_task_id: PIPE-49
priority: high
ordinal: 122000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Emit event records for runner-job environment phases so Pipeline Console can show where a clean Job failed without requiring pod log inspection.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Events cover checkout started, checkout finished, checkout failed, devspace readiness, pipeline config readiness, MCP auth readiness, and workspace prepared.
- [ ] #2 Events redact clone credentials and secret values.
- [ ] #3 Event mapping remains in runner-job contract/event modules, not pipeline runtime.
- [ ] #4 Existing runtime events still flow unchanged after bootstrap.
- [ ] #5 Tests assert event type/payload shape for success and failure phases.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add runner-job phase event helpers and extend event sink/contract mapping only where needed for Console-readable records.
<!-- SECTION:PLAN:END -->
