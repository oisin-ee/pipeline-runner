---
id: PIPE-88.8
title: moka loop CLI + cloud submission of the controller
status: To Do
assignee: []
created_date: '2026-06-21 19:27'
updated_date: '2026-06-21 19:27'
labels: []
dependencies:
  - PIPE-88.7
modified_files:
  - src/cli/program.ts
  - src/moka-submit.ts
  - src/loop/loop-command.ts
parent_task_id: PIPE-88
priority: high
ordinal: 252000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: src/cli/program.ts (register loop command), src/moka-submit.ts (submit controller as a cloud workflow, sibling of submit), new src/loop/loop-command.ts. Flags: --strategy priority|bfs|dfs (reuse TicketSelectionStrategy), --root <epic-id> (scoped traversal), --max-remediation-attempts, --merge-timeout. Packages the controller into a long-running cloud workflow that emits loop.* events to the console event sink.
Dependencies: T7 (controller core)
Escalation: report Met/Unmet with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 moka loop submits a cloud controller workflow and returns its workflow name -- Evidence: test asserts submitMoka-style submission with controller entrypoint
- [ ] #2 --strategy/--root/--max-remediation-attempts/--merge-timeout parsed + forwarded -- Evidence: CLI parse test
- [ ] #3 cyclic or empty backlog refuses to start with a clear error -- Evidence: test asserts non-zero exit + message
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 pnpm test on loop-command + CLI; record output
<!-- DOD:END -->
