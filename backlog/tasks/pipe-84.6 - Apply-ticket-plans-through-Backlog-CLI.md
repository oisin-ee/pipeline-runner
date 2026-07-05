---
id: PIPE-84.6
title: Apply ticket plans through Backlog CLI
status: Done
assignee: []
created_date: "2026-06-17 10:38"
updated_date: "2026-06-17 12:58"
labels:
  - moka
  - ticket
  - backlog
  - mutation
dependencies:
  - PIPE-84.5
references:
  - src/runtime/services/backlog-service.ts
  - src/backlog.ts
modified_files:
  - src/tickets/apply-ticket-plan.ts
  - src/commands/ticket-command.ts
  - tests/ticket-plan-apply.test.ts
  - tests/ticket-command.test.ts
parent_task_id: PIPE-84
priority: high
ordinal: 239000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Implement moka ticket create --apply by converting a validated ticket plan into ordered Backlog CLI mutations. This ticket owns creating the epic parent by default, creating children, resolving local dependency keys to assigned Backlog ids, and surfacing structured failure if any Backlog command cannot be parsed.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 When --parent is absent, create --apply creates an epic parent before child tasks; evidence: tests/ticket-plan-apply.test.ts asserts BacklogService call order.
- [x] #2 When --parent is provided, create --apply creates child tasks under the existing parent and does not create a new epic; evidence: apply test asserts command args.
- [x] #3 Local dependency keys in the plan become real Backlog ids after child creation; evidence: test asserts a dependent child receives --dep with the created prerequisite id.
- [x] #4 All task mutations use backlog task create/edit --plain through BacklogService and never direct markdown writes; evidence: tests assert service calls and code review finds no writes to backlog/tasks.
- [x] #5 If a created task id cannot be parsed, the command reports created ids, failed command context, and blocker instead of claiming success; evidence: malformed stdout test asserts structured failure message.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Add src/tickets/apply-ticket-plan.ts. Reuse or extend the existing BacklogService from src/runtime/services/backlog-service.ts. Parse Backlog ids from --plain output using the existing tolerant task id pattern or a shared parser. Keep apply separate from dry-run rendering.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented ticket plan application through BacklogService-backed backlog task create --plain calls. Verified parent creation, existing-parent apply, dependency id resolution, mutation boundary, malformed stdout failure reporting, source CLI flags, strict config validation, typecheck, style check, and focused test suite.

<!-- SECTION:FINAL_SUMMARY:END -->
