---
id: PIPE-88
title: >-
  Epic: Autonomous ticket-loop orchestrator with graph traversal + console
  observer
status: To Do
assignee: []
created_date: '2026-06-21 19:25'
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
- [ ] #1 All child tickets Done with per-criterion evidence
- [ ] #2 End-to-end: moka loop drains a 3-ticket dependency chain on a scratch backlog, auto-merging each PR, with the /loop console view recoloring nodes live
<!-- DOD:END -->
