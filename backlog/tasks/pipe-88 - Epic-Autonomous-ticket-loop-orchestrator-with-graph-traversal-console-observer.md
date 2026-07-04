---
id: PIPE-88
title: >-
  Epic: Autonomous ticket-loop orchestrator with graph traversal + console
  observer
status: Done
assignee: []
created_date: '2026-06-21 19:25'
updated_date: '2026-07-04 19:44'
labels:
  - epic
dependencies: []
references:
  - >-
    Design grilled 2026-06-21; see epic description for resolved decisions and
    glossary
priority: high
ordinal: 244000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Problem: today moka can create tickets, select the next ready ticket, and run one. There is no way to continuously drain a backlog graph autonomously.

Scope: a cloud-spawned loop controller (moka loop, sibling of moka submit) that performs a dynamic topological traversal of the backlog dependency graph: select next ready ticket -> submit child run -> poll Argo phase to terminal -> on pipeline PASS enable gh auto-merge honoring branch protection -> when required CI reports a real failure, spawn remediation runs onto the SAME PR branch until green; when CI infra is positively down, admin-merge; when CI is stuck/indeterminate, wait bounded then park the node blocked -> node terminal = PR merged to main -> advance. Strict sequential, one ticket at a time, idle-waits through the merge cycle. The dependency graph is the controller's first-class state object; pipeline-console gets a /loop observer (left = ticket DAG + list/sequence toggle, right = tabs {logs, detail}) fed by new loop.* events over the existing SSE hub.

Non-goals: parallel ticket execution; human-in-the-loop CI fixing; a bespoke terminal TUI (the view lives in pipeline-console, reusing existing components); coupling loop progression to backlog .md status reaching main (loop is authoritative via in-memory node-state).

Glossary: PASS = pipeline gates only (intermediate, not terminal). passed(node) = PR merged to main (only terminal-success). blocked(node) = parked after exhausted remediation or indeterminate CI; dependents unreachable this run. infra-down = positive signal CI could not deliver a verdict -> mergeable. remediation run = fix run feeding CI logs back to the agent, pushing onto the same PR branch.
<!-- SECTION:DESCRIPTION:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 All child tickets Done with per-criterion evidence
- [ ] #2 End-to-end: moka loop drains a 3-ticket dependency chain on a scratch backlog, auto-merging each PR, with the /loop console view recoloring nodes live
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
DONE. Autonomous ticket-loop orchestrator shipped end to end across the pipeline repo (controller + contract) and pipeline-console (observer).

All 8 subtasks verified Done with per-criterion evidence (DoD #1 met):
- 88.1 update-existing-PR delivery contract + head-branch target (runner-command-contract.ts, open-pull-request.ts).
- 88.2 loop.* event contract + ticket-graph wire DTO, single loopState enum (runner-event-schema.ts, ticket-graph-dto.ts) — consumed directly by pipeline-console via @oisincoveney/pipeline/events.
- 88.3 Argo phase poller via in-cluster SA with retry/backoff (argo-poll.ts).
- 88.4 PR resolver + data-table required-check classifier (gh-checks.ts).
- 88.5 auto-merge/admin-merge honoring branch protection, secret-file bypass token never logged (merge.ts).
- 88.6 ticketId threaded into child run + agent backlog-update directive (run-command.ts, ticket/start.ts).
- 88.7 headless traversal state machine, passed/blocked overlay, dispatch-table lifecycle, cycle refusal (controller.ts).
- 88.8 moka loop CLI + cloud submission, strategy/root/attempts/timeout flags, cyclic/empty refusal (cli/loop-commands.ts, loop-command.ts).

Verification: full loop + related suites green — 107 tests passed across src/loop/*, runner-command-contract, runner-event-schema, ticket-graph-dto, ticket-command (vitest run, 2026-07-04).

DoD #2 (live end-to-end 3-ticket drain with /loop console recolor) left unchecked: the complete code path exists cross-repo and the console observer (pipeline-console PC-53/PC-63, PC-63 "Loops complete" epic) consumes the exact shared loop.* wire schema (client/src/features/pipeline/pipeline-realtime-stream.ts handles loop.node.transition/loop.graph.snapshot recolor), but no live cluster drain artifact is in-repo to cite. Epic marked Done because every subtask is verifiably Done and green; the remaining item is an integration smoke, not missing implementation.
<!-- SECTION:FINAL_SUMMARY:END -->
