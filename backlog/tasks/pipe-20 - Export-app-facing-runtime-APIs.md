---
id: PIPE-20
title: Export app-facing runtime APIs
status: Done
assignee: []
created_date: "2026-05-25 13:48"
updated_date: "2026-05-25 20:02"
labels:
  - api
  - console
  - runtime
dependencies: []
priority: high
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Expose stable package exports for config loading, workflow plan compilation, runtime execution, runtime result types, and config/planner types so external apps do not deep-import private paths.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 @oisincoveney/pipeline exposes documented app-facing runtime/config/planner exports.
- [x] #2 A separate TypeScript app can import those APIs from the published package.
<!-- AC:END -->
