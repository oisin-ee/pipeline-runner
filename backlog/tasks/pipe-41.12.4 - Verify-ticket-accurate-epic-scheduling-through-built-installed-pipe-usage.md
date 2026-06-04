---
id: PIPE-41.12.4
title: Verify ticket-accurate epic scheduling through built installed-pipe usage
status: In Progress
assignee: []
created_date: '2026-06-04 09:28'
updated_date: '2026-06-04 09:44'
labels:
  - pipeline
  - schedules
  - dogfood
  - installed-pipe
  - tests
dependencies:
  - PIPE-41.12.2
  - PIPE-41.12.3
references:
  - tests/dogfood-installed.test.ts
  - tests/cli.test.ts
  - src/index.ts
  - src/schedule-planner.ts
modified_files:
  - tests/dogfood-installed.test.ts
  - tests/cli.test.ts
  - src/index.ts
parent_task_id: PIPE-41.12
priority: high
ordinal: 109000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add the real usage proof for the PC-37 failure class. Once schedule planning understands Backlog dependencies and installed validation accepts `task_context`, the repository must prove that a built or installed `pipe` can generate, validate, and explain a ticket-accurate schedule for a multi-child epic without falling back to generic tracks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A dogfood test creates or uses a PC-37-shaped Backlog fixture with at least six child tickets, including one sequential dependency chain, two independent branches, and one final rollout/verification child.
- [ ] #2 The scheduled epic entrypoint generates a schedule artifact whose root workflow contains explicit nodes assigned to every child ticket id and no generic-only `test/frontend/backend/k8s` implementation plan.
- [ ] #3 The generated schedule preserves Backlog child dependencies in the explained execution plan while independent child branches remain parallelizable.
- [ ] #4 The generated schedule validates with the same built or installed `pipe validate --schedule <schedule.yaml>` command users run, not only by direct unit-level function calls.
- [ ] #5 The dogfood path also runs `pipe explain-plan --schedule <schedule.yaml>` and asserts the relevant child ticket ids and dependency ordering are visible in output.
- [ ] #6 The final verification instructions for this ticket include `bun run typecheck`, `bun run check`, `bun run build`, `bun run test`, `bun run test:dogfood`, and the exact built/installed CLI validate and explain commands used.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Build a PC-37-shaped fixture in the dogfood or CLI test layer, using real Backlog task markdown and the configured scheduled epic entrypoint.
2. Invoke the schedule generation path the same way users do, capturing the generated `.pipeline/runs/<runId>/schedule.yaml` path from CLI output where possible.
3. Run the built or installed `pipe validate --schedule <schedule.yaml>` command against that generated artifact and assert success.
4. Run `pipe explain-plan --schedule <schedule.yaml>` and assert child ticket ids and dependency ordering are visible; independent branches should remain in the same or adjacent parallel batch where graph policy allows.
5. Assert the generated artifact is not generic-only by checking every child id appears as `task_context.id` and that old generic `test/frontend/backend/k8s` track-only shape is absent.
6. Keep this ticket focused on proof and fixture quality. If it reveals a source behavior defect, fix it only if it belongs to `.2` or `.3`; otherwise stop and split a follow-up under `PIPE-41.12`.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Execution started after schedule graph validation and `task_context` CLI/public-package coverage were green. This slice will add the PC-37-shaped dogfood proof through CLI schedule generation, validation, and explain-plan.
<!-- SECTION:NOTES:END -->
