---
id: PIPE-95.6
title: Clear runtime core strict lint for PIPE-95
status: Done
assignee: []
created_date: '2026-07-05 19:19'
updated_date: '2026-07-06 04:26'
labels:
  - migration
dependencies:
  - PIPE-95.5
references:
  - >-
    backlog/tasks/pipe-95.5 -
    Stabilize-post-autofix-strict-lint-baseline-for-PIPE-95.md
  - /tmp/pipe95-controller-oxlint-after-format.json
  - oxlint.config.ts
modified_files:
  - src/runtime
  - tests/runtime-actor-contract-boundary.test.ts
  - tests/runtime-actor-docs.test.ts
  - tests/runtime-actor-ids-contract.test.ts
  - tests/runtime-node-state-tracker.test.ts
parent_task_id: PIPE-95
priority: medium
ordinal: 351000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What to build: Clear strict/type-aware/Effect lint diagnostics owned by runtime core modules without touching runner, run-control, CLI/config, planning/schedule, tickets, or package metadata.
Scope: src/runtime/** plus directly paired runtime tests only. Own absence/boolean, service IO/env/clock/process, tagged-error, JSON/schema, collection, Effect.run, and unsafe-type diagnostics inside this domain lane.
Dependencies / Blocked by: PIPE-95.5.
Likely modified files: src/runtime/**, tests/runtime-actor-\*.test.ts, tests/runtime-node-state-tracker.test.ts, and runtime-adjacent tests named by the fresh lint JSON.
Research required: inspect @oisin-ee/oxlint-config Effect guidance, existing runtime services, local Schema/TaggedError patterns, and @effect/platform services before edits.
Model recommendation:

- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-high -- broad runtime lane with behavioural risk; current host exposes gpt-5.5.
- OpenCode: moka-code-writer/default -- dispatch must revalidate live availability.
  Escalation:
- Met: runtime-core diagnostics clear with focused tests and typecheck.
- Unmet: record exact runtime file/rule/count and missing service/schema/error contract.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Runtime-core diagnostics are cleared. -- Evidence: parsed oxlint JSON filtered to this lane write boundary shows zero errors except transferred residuals with rule/file/count.
- [x] #2 Runtime behaviour remains covered. -- Evidence: focused tests for touched runtime files pass and nub run typecheck exits 0.
- [x] #3 Write boundary is respected. -- Evidence: review lists any non-runtime file touched and why it was required, otherwise no out-of-bound source/test edits.
- [x] #4 No shortcut suppressions or type escapes are introduced. -- Evidence: git diff --check exits 0 and added-line escape scan exits 1.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Start from /tmp/pipe95-controller-oxlint-after-format.json, filter diagnostics to the runtime lane, group by runtime service/schema/error seam, fix one seam at a time, run focused runtime tests, then rerun filtered counts and typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Final evidence 2026-07-06: full repo gate passed. nub run check exit 0; nub run typecheck exit 0; nub run test exit 0 (158 files passed, 6 skipped; 1220 tests passed, 51 skipped); nubx fallow audit --fail-on-issues --format compact exit 0 with no introduced issues; git diff --check exit 0; strict forbidden-token scan for as any, ts-ignore, ts-expect-error, TODO: fix later, effectMigration exited 1. Exact allow/rules scan hits reviewed as domain/config vocabulary.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 The ticket global-rules feature-implementation workflow was run in order.
- [x] #2 Focused proof ran fresh and output was recorded.
- [x] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
