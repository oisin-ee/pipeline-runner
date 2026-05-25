---
id: PIPE-24
title: Add first-class entrypoint aliases
status: To Do
assignee: []
created_date: '2026-05-25 13:48'
labels:
  - config
  - entrypoints
dependencies: []
priority: medium
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Support configured entrypoints such as pipe, quick, and create-ticket/ticket-intake that map to workflows and share runners/profiles.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Pipeline config can declare named entrypoints mapped to workflows.
- [ ] #2 CLI and library APIs can select an entrypoint without hardcoding workflow ids in callers.
<!-- AC:END -->
