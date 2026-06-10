---
id: PIPE-56.1
title: Rename public Moka submit event transport to eventSink
status: To Do
assignee: []
created_date: '2026-06-10 22:12'
labels:
  - api
  - momokaya
  - console
dependencies: []
references:
  - README.md
  - docs/operator-guide.md
modified_files:
  - src/moka-submit.ts
  - src/index.ts
  - tests/moka-submit.test.ts
  - tests/package-public-api.test.ts
parent_task_id: PIPE-56
priority: high
ordinal: 179000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Rename the public Moka submit transport option from the vague events field to eventSink so Pipeline Console callers can distinguish runner event delivery from lifecycle hook behavior. Keep runner payload internals unchanged unless the payload contract deliberately changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Moka submit accepts eventSink with url, authHeader, and authTokenFile and maps it to the existing runner payload event destination.
- [ ] #2 The legacy events submit option is either rejected with a clear migration error or accepted as a documented compatibility alias; if both eventSink and events are supplied, validation fails.
- [ ] #3 CLI flag handling and existing Moka submit behavior continue to produce the same event sink URL, auth header, and auth token file path.
- [ ] #4 Focused tests cover eventSink, legacy events compatibility or rejection, and the both-fields conflict.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update src/moka-submit.ts schema and option normalization first. Keep runner-command-contract payload events unchanged unless this ticket explicitly updates all docs/tests for a contract rename. Update README/operator wording to use eventSink for the public API.
<!-- SECTION:PLAN:END -->
