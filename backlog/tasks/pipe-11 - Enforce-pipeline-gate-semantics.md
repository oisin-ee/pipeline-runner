---
id: PIPE-11
title: Enforce pipeline gate semantics
status: In Progress
assignee:
  - Codex
created_date: '2026-05-21 09:19'
updated_date: '2026-05-21 09:39'
labels:
  - workflow
  - gates
dependencies:
  - PIPE-10
references:
  - src/mastra/workflows/pipeline.ts
  - src/mastra/steps/red.ts
  - src/mastra/steps/green.ts
  - src/mastra/steps/verify.ts
  - tests/pipeline.test.ts
priority: high
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the workflow treat gate outcomes as control-flow decisions instead of passive fields. Today RED can fail while the workflow continues, and the final outcome only considers GREEN and VERIFY. The pipeline should produce an accurate PASS or FAIL and preserve enough evidence to explain why.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A failed RED gate prevents the run from being reported as PASS.
- [ ] #2 The final workflow outcome requires RED, GREEN, and VERIFY to have passed.
- [ ] #3 Failure results include the reason and relevant test or verification evidence needed to diagnose the gate failure.
- [ ] #4 Unit tests cover RED failure, GREEN failure, VERIFY failure, and full PASS paths.
- [ ] #5 Mastra workflow output remains stable and documented for CLI consumers.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implementation plan:
1. Work in dedicated `wt` branch/worktree `pipe-11-gate-semantics` based on updated `main`.
2. Change workflow semantics so the final result requires RED, GREEN, and VERIFY to pass; failed gates must not be reported as PASS.
3. Preserve a stable CLI-consumable output shape while adding concise failure evidence and reasons.
4. Add or update unit tests for RED failure, GREEN failure, VERIFY failure, and full PASS paths.
5. Run `bun run test`, `bun run typecheck`, `bun run check`, and `bun run build`; commit the scoped branch changes before handoff.
<!-- SECTION:PLAN:END -->
