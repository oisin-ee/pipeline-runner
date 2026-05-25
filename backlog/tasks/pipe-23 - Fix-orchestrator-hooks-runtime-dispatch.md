---
id: PIPE-23
title: Fix orchestrator hooks runtime dispatch
status: To Do
assignee: []
created_date: '2026-05-25 13:48'
labels:
  - hooks
  - runtime
  - bug
dependencies: []
priority: medium
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The config schema and command installation path support orchestrator.hooks, but the runtime currently dispatches only workflow and node hooks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Runtime dispatch includes orchestrator.hooks according to documented semantics or the config field is removed/deprecated.
- [ ] #2 Tests cover orchestrator hook dispatch or documented non-dispatch behavior.
<!-- AC:END -->
