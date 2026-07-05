---
id: PIPE-88.8
title: moka loop CLI + cloud submission of the controller
status: Done
assignee: []
created_date: "2026-06-21 19:27"
updated_date: "2026-07-04 19:43"
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
Scope: src/cli/program.ts (register loop command), src/moka-submit.ts (submit controller as a cloud workflow, sibling of submit), new src/loop/loop-command.ts. Flags: --strategy priority|bfs|dfs (reuse TicketSelectionStrategy), --root <epic-id> (scoped traversal), --max-remediation-attempts, --merge-timeout. Packages the controller into a long-running cloud workflow that emits loop.\* events to the console event sink.
Dependencies: T7 (controller core)
Escalation: report Met/Unmet with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 moka loop submits a cloud controller workflow and returns its workflow name -- Evidence: test asserts submitMoka-style submission with controller entrypoint
- [x] #2 --strategy/--root/--max-remediation-attempts/--merge-timeout parsed + forwarded -- Evidence: CLI parse test
- [x] #3 cyclic or empty backlog refuses to start with a clear error -- Evidence: test asserts non-zero exit + message
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

DONE. moka loop CLI + cloud submission of the controller.

Evidence (commit bad3902 "feat(loop): moka loop CLI, cloud submission, and production ControllerDeps"):

- CLI registration: src/cli/loop-commands.ts registerLoopCommand adds `moka loop` (public) and `moka loop-controller` (hidden in-cluster entrypoint), wired into src/cli/program.ts. Flags: --strategy priority|bfs|dfs (Option.choices, reuses selection strategy), --root <epic-id>, --max-remediation-attempts <n>, --merge-timeout <n> — all parsed and forwarded.
- Cloud submission: src/loop/loop-command.ts runLoopSubmit packages the controller as a long-running cloud workflow (submitMoka-style) and returns { workflowName, namespace }; entrypoint src/loop/loop-controller-entrypoint.ts.
- Cyclic/empty backlog refuses to start with a clear non-zero error (loop-command.ts:112-118: cycle fails graph construction surfaced verbatim; empty/fully-blocked backlog has no ready ticket and is refused).
- Tests green: src/loop/loop-command.test.ts (10 passed) + loop-command-registration.test.ts (1 passed) — cover submission returns workflow name, flag parse/forward, and cyclic/empty refusal.

AC1/2/3 all met.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run feature-implementation workflow in order
- [x] #2 pnpm test on loop-command + CLI; record output
<!-- DOD:END -->
