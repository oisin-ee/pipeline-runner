---
id: PIPE-88.7
title: "Loop traversal state machine (controller core, headless)"
status: Done
assignee: []
created_date: "2026-06-21 19:27"
updated_date: "2026-07-04 19:43"
labels: []
dependencies:
  - PIPE-88.1
  - PIPE-88.2
  - PIPE-88.3
  - PIPE-88.4
  - PIPE-88.5
modified_files:
  - src/loop/controller.ts
parent_task_id: PIPE-88
priority: high
ordinal: 251000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: new src/loop/controller.ts. Headless, testable orchestration: dynamic topological traversal using selectNextTicket(graph,{strategy,root}); node lifecycle enum queued->running->merging->passed|blocked owned in one place; in-memory passed-set overlay so a passed ticket is never re-selected even if .md status stale; strict sequential idle-wait; per-ticket inner loop: submit child run (update-PR mode for remediation) -> pollWorkflowPhase -> on PASS enableAutoMerge -> poll PR + classifyRequiredCheck -> fixable: bounded remediation runs until merged; infra-down: adminMerge; indeterminate: wait bounded then block -> on merge mark passed, git-refresh backlog from main, recompute ready set; bounded remediation attempts then block + continue next independent ready subtree; emit loop.\* events each transition. Cyclic backlog (findCycles) -> refuse to start. Reuse buildTicketGraphEffect/ticket-selection.
Dependencies: T1 (update-PR contract), T2 (events), T3 (poller), T4 (classifier), T5 (merge)
Escalation: report Met/Unmet with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Traversal drains a 3-node chain in dependency order, marking each passed on merge -- Evidence: test with faked submit/poll/merge asserts order + final all-passed
- [x] #2 fixable CI failure triggers a bounded remediation loop on the same PR until merged -- Evidence: test: first CI failure then green merges; attempts capped
- [x] #3 infra-down admin-merges; indeterminate waits then blocks (never merges) -- Evidence: separate tests per branch
- [x] #4 exhausted remediation parks node blocked and continues to next independent ready ticket; blocked node's dependents unreached -- Evidence: test asserts blocked + downstream skipped + independent subtree still drained
- [x] #5 node lifecycle is one enum/dispatch table, not nested conditionals -- Evidence: critique/type review; readiness derived from graph + passed-set
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

DONE. Headless loop traversal state machine (controller core).

Evidence (src/loop/controller.ts, commit 017ea4f):

- Outer drain: strict sequential dynamic topological traversal via selectNextTicket(graph,{strategy,root}) with an in-memory passed-set + blocked-set overlay (controller.ts:211-225) so a passed ticket is never re-selected even if backlog .md is stale, and a blocked node's dependents stay unreachable.
- Node lifecycle owned in ONE place as a LoopState enum + dispatch tables (POLL_ACTION at :161, PollAction/NodeResolution at :156-176), not nested conditionals; readiness derived from current task records + passed-set.
- Inner per-node loop: submit child run (update-PR mode for remediation) -> pollWorkflowPhaseUntilTerminal -> on PASS enableAutoMerge -> poll PR + classifyRequiredChecks -> fixable: bounded remediation runs until merged; infra-down: adminMerge; indeterminate: bounded wait then block; on merge mark passed + emit loop.\* transition.
- Cyclic backlog refused (dependencyCycleIds via buildTicketGraph; refusal surfaced in loop-command.ts:112-118).
- Tests green: src/loop/controller.test.ts (11 passed) + controller-deps.test.ts (8 passed) — cover 3-node chain drain in dependency order (all-passed), fixable remediation loop capped, infra-down admin-merge, indeterminate wait-then-block, exhausted remediation parks blocked + downstream skipped while independent subtree still drains.

AC1-5 all met.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run feature-implementation workflow in order
- [x] #2 pnpm test on controller; record output
<!-- DOD:END -->
