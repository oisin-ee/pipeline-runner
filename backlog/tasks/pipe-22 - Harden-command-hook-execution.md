---
id: PIPE-22
title: Harden command hook execution
status: To Do
assignee: []
created_date: '2026-05-25 13:48'
labels:
  - hooks
  - security
dependencies: []
priority: high
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make pipeline hooks safe enough for UI-triggered dispatch across multiple repositories.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Hooks support explicit enablement/trust policy, timeouts, output limits, and sanitized env.
- [ ] #2 Hooks receive structured payloads without relying on unsafe string templating for complex data.
<!-- AC:END -->
