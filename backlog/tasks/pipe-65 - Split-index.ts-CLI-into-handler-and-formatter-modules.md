---
id: PIPE-65
title: Split index.ts CLI into handler and formatter modules
status: To Do
assignee: []
created_date: '2026-06-11 20:40'
labels:
  - refactor
  - cli
dependencies:
  - PIPE-60
priority: low
ordinal: 197000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5: decompose the 1,341-line src/index.ts into: thin command routing (index.ts, ~150 lines), src/cli/format.ts (result formatters: formatConfigError, formatRuntimeResult, formatDoctorResult, etc., ~250 lines), src/cli/submit-options.ts (submit flag parsing and option normalization, ~200 lines). This is mechanical - just grouping responsibilities. Public CLI behavior unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/cli/{format,submit-options}.ts exist; index.ts wiring is thin.
- [ ] #2 No behavior changes; CLI invocation is identical.
<!-- AC:END -->
