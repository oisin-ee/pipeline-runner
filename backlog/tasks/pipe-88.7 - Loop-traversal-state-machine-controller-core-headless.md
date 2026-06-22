---
id: PIPE-88.7
title: 'Loop traversal state machine (controller core, headless)'
status: To Do
assignee: []
created_date: '2026-06-21 19:27'
updated_date: '2026-06-21 19:27'
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
Scope: new src/loop/controller.ts. Headless, testable orchestration: dynamic topological traversal using selectNextTicket(graph,{strategy,root}); node lifecycle enum queued->running->merging->passed|blocked owned in one place; in-memory passed-set overlay so a passed ticket is never re-selected even if .md status stale; strict sequential idle-wait; per-ticket inner loop: submit child run (update-PR mode for remediation) -> pollWorkflowPhase -> on PASS enableAutoMerge -> poll PR + classifyRequiredCheck -> fixable: bounded remediation runs until merged; infra-down: adminMerge; indeterminate: wait bounded then block -> on merge mark passed, git-refresh backlog from main, recompute ready set; bounded remediation attempts then block + continue next independent ready subtree; emit loop.* events each transition. Cyclic backlog (findCycles) -> refuse to start. Reuse buildTicketGraphEffect/ticket-selection.
Dependencies: T1 (update-PR contract), T2 (events), T3 (poller), T4 (classifier), T5 (merge)
Escalation: report Met/Unmet with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Traversal drains a 3-node chain in dependency order, marking each passed on merge -- Evidence: test with faked submit/poll/merge asserts order + final all-passed
- [ ] #2 fixable CI failure triggers a bounded remediation loop on the same PR until merged -- Evidence: test: first CI failure then green merges; attempts capped
- [ ] #3 infra-down admin-merges; indeterminate waits then blocks (never merges) -- Evidence: separate tests per branch
- [ ] #4 exhausted remediation parks node blocked and continues to next independent ready ticket; blocked node's dependents unreached -- Evidence: test asserts blocked + downstream skipped + independent subtree still drained
- [ ] #5 node lifecycle is one enum/dispatch table, not nested conditionals -- Evidence: critique/type review; readiness derived from graph + passed-set
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 pnpm test on controller; record output
<!-- DOD:END -->
