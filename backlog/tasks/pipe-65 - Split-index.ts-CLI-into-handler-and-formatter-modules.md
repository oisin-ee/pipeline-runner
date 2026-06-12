---
id: PIPE-65
title: Split index.ts CLI into handler and formatter modules
status: Done
assignee: []
created_date: '2026-06-11 20:40'
updated_date: '2026-06-12 10:28'
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
- [x] #1 src/cli/{format,submit-options}.ts exist; index.ts wiring is thin.
- [x] #2 No behavior changes; CLI invocation is identical.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed during PIPE-69 parent reconciliation on 2026-06-12. MoKa Acceptance Reviewer verified the implemented source state and focused tests for the one-engine refactor: xstate/runtime-machines removed, plain async scheduler and shared lifecycle in place, Argo exit-70 retryStrategy and parity covered, hands-on terminal/devspace flow present, config/schedule/CLI splits present, and decision notes retained. See PIPE-69 final summary for cross-phase evidence.
<!-- SECTION:FINAL_SUMMARY:END -->
