---
id: PIPE-29
title: Add acceptance coverage gate
status: Done
assignee: []
created_date: "2026-05-25 20:02"
updated_date: "2026-05-25 20:32"
labels:
  - gates
  - acceptance
  - verification
dependencies:
  - PIPE-27
  - PIPE-28
priority: high
ordinal: 41000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Add a generic acceptance gate that compares expected acceptance criteria from normalized task context against structured verifier or acceptance-review output. This turns "review every AC" from prompt guidance into a runtime-enforced contract.

The gate must only depend on normalized task context from PIPE-28. It must not know where that context came from. Backlog, Beads, Linear, GitHub, or Markdown are resolver concerns, not gate concerns.

Expected verifier output shape should support per-criterion entries with stable IDs, verdicts, and evidence. The gate should fail on missing criteria, duplicate criteria, unknown extra criteria, failed criteria, or empty evidence for passing criteria.

Scope:

- Add `acceptance` gate kind to config.
- Define the expected structured output shape for per-AC coverage.
- Compare configured/normalized expected AC IDs against node output.
- Produce useful gate evidence listing missing, duplicate, extra, failed, or evidence-free criteria.

Non-goals:

- Do not implement task-context resolution here; consume the interface from PIPE-28.
- Do not add RED/GREEN test contracts here.
- Do not hardcode a verifier profile name or a task tool.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Config supports an acceptance gate kind.
- [x] #2 Gate checks every expected acceptance criterion appears exactly once by stable ID.
- [x] #3 Gate fails on missing, duplicate, extra, or failed acceptance criterion entries.
- [x] #4 Gate fails when PASS entries have no concrete evidence.
- [x] #5 Gate does not know about Backlog or any specific task tool.
- [x] #6 Gate emits actionable evidence for each coverage mismatch.
- [x] #7 Tests cover full pass, missing, duplicate, extra, failed, empty evidence, malformed JSON, and no-context cases.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

1. Extend config schema with `acceptance` gate fields: target, optional artifact path, source task context, and required behavior.
2. Define or update verify/acceptance JSON schema to include a per-criterion coverage array.
3. Implement gate evaluation by parsing node output, reading expected ACs from runtime task context, and comparing IDs exactly.
4. Add runtime tests for full pass, missing criterion, duplicate criterion, extra criterion, criterion verdict FAIL, empty evidence, malformed JSON, no task context with required=true, and optional behavior if supported.
5. Add config tests for valid and invalid acceptance gate shapes.
6. Document that this gate is task-tool agnostic and consumes normalized task context only.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Added generic acceptance gate comparing normalized task acceptance criteria against structured review output, with mismatch evidence for missing, duplicate, extra, failed, empty evidence, malformed/no-context cases covered by tests.

<!-- SECTION:FINAL_SUMMARY:END -->
