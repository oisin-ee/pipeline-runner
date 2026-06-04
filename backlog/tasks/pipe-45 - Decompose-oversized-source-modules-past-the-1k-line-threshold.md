---
id: PIPE-45
title: Decompose oversized source modules past the 1k-line threshold
status: To Do
assignee: []
created_date: '2026-06-04 14:40'
labels:
  - tech-debt
  - maintainability
  - decomposition
  - thermo-review
milestone: m-1
dependencies: []
references:
  - src/config.ts
  - src/index.ts
  - src/install-commands.ts
  - src/schedule-planner.ts
  - package.json
priority: high
ordinal: 112000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The codebase has multiple source files over the maintainability threshold: `src/config.ts`, `src/index.ts`, `src/install-commands.ts`, and `src/schedule-planner.ts`. These files mix schemas, validation, CLI registration, formatting, planning policy, and generation concerns. Split these modules along natural ownership boundaries while preserving public package exports and CLI behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No non-generated source module remains over 1,000 lines unless the task records a specific structural justification in code or docs.
- [ ] #2 Config schema construction and config reference validation are separated into clearer modules without changing parsed config behavior.
- [ ] #3 CLI command registration, runtime execution helpers, output formatting, and doctor/gateway helpers are separated enough that `src/index.ts` is no longer a mixed-purpose module.
- [ ] #4 Schedule planning baseline generation, planner prompting, artifact validation, and backlog context loading have clearer ownership boundaries.
- [ ] #5 Public package exports, CLI commands, and existing config compatibility are preserved.
<!-- AC:END -->
