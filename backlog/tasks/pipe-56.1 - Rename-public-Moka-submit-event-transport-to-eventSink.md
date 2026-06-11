---
id: PIPE-56.1
title: Rename public Moka submit event transport to eventSink
status: Done
assignee:
  - '@codex'
created_date: '2026-06-10 22:12'
updated_date: '2026-06-10 22:46'
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
- [x] #1 Moka submit accepts eventSink with url, authHeader, and authTokenFile and maps it to the existing runner payload event destination.
- [x] #2 The legacy events submit option is either rejected with a clear migration error or accepted as a documented compatibility alias; if both eventSink and events are supplied, validation fails.
- [x] #3 CLI flag handling and existing Moka submit behavior continue to produce the same event sink URL, auth header, and auth token file path.
- [x] #4 Focused tests cover eventSink, legacy events compatibility or rejection, and the both-fields conflict.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update src/moka-submit.ts schema and option normalization first. Keep runner-command-contract payload events unchanged unless this ticket explicitly updates all docs/tests for a contract rename. Update README/operator wording to use eventSink for the public API.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented eventSink as the public Moka submit transport with legacy events compatibility and explicit conflict rejection. Verification: bun test tests/moka-submit.test.ts tests/package-public-api.test.ts tests/runner-command-contract.test.ts --runInBand passed; bun run typecheck passed; bun run build:cli passed. bun run check is blocked by pre-existing format drift in src/install-commands.ts and unrelated tests.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added public eventSink support to moka-submit while preserving legacy events as a compatibility alias and rejecting mixed eventSink/events input. Updated public API compile coverage and docs to distinguish eventSink transport from hooks. Verification: focused Moka/public API/runner contract tests passed, typecheck passed, build:cli passed. Full check still fails on unrelated pre-existing formatting drift outside this slice.
<!-- SECTION:FINAL_SUMMARY:END -->
