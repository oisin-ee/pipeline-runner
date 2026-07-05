---
id: PIPE-84.10
title: Add ticket next claim-only flow
status: Done
assignee: []
created_date: "2026-06-17 13:15"
updated_date: "2026-06-17 13:56"
labels:
  - moka
  - ticket
  - cli
  - backlog
  - mutation
dependencies:
  - PIPE-84.6
references:
  - src/commands/ticket-command.ts
  - src/runtime/services/backlog-service.ts
  - tests/ticket-command.test.ts
modified_files:
  - src/commands/ticket-command.ts
  - tests/ticket-command.test.ts
parent_task_id: PIPE-84
priority: high
ordinal: 240200
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Add the explicit claim mutation for the currently selected ready ticket without invoking moka run. This keeps Backlog ownership of status changes and preserves read-only ticket next behavior unless --claim is present.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 moka ticket next --claim selects exactly one ready ticket and marks it In Progress through BacklogService; evidence: tests/ticket-command.test.ts asserts BacklogService receives task edit <id> --status In Progress --plain.
- [x] #2 moka ticket next without --claim remains read-only and repeatable; evidence: existing ticket next fixture snapshot test still asserts unchanged Backlog task files.
- [x] #3 If no ready ticket exists, --claim exits with a clear no ready tickets message and does not call BacklogService; evidence: CLI test covers an empty-ready graph with zero service calls.
- [x] #4 The claim path uses BacklogService only and never direct markdown writes; evidence: tests assert service calls and grep/code review finds no backlog/tasks writes in ticket-command.ts.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Extend the existing ticket next command with --claim. Reuse selectNextTicket for deterministic selection, invoke BacklogService.run(["task", "edit", id, "--status", "In Progress", "--plain"], cwd), and keep the read-only path untouched.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Added moka ticket next --claim using deterministic ready-ticket selection and BacklogService task edit --status In Progress --plain. Verified claim service calls, no-ready no-mutation path, read-only next regression, broader ticket suite, typecheck, style check, verifier PASS, acceptance PASS, and final code review PASS.

<!-- SECTION:FINAL_SUMMARY:END -->
