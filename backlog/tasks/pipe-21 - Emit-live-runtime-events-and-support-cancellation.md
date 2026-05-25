---
id: PIPE-21
title: Emit live runtime events and support cancellation
status: To Do
assignee: []
created_date: '2026-05-25 13:48'
labels:
  - runtime
  - observability
  - cancellation
dependencies: []
priority: high
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add event callbacks or JSONL event output plus AbortSignal cancellation to the config-driven runtime so UIs can observe and stop runs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Runtime emits structured workflow, node, agent, gate, hook, and artifact lifecycle events.
- [ ] #2 Runtime cancellation terminates subprocesses and returns a structured cancelled outcome.
<!-- AC:END -->
