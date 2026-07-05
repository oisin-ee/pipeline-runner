---
id: PIPE-45.10
title: Shrink runtime facade dependency result lifecycle
status: Done
assignee: []
created_date: "2026-06-27 14:03"
labels: []
dependencies:
  - PIPE-45.3
  - PIPE-45.4
  - PIPE-45.7
references:
  - src/pipeline-runtime.ts
modified_files:
  - src/pipeline-runtime.ts
  - src/run-control/next-node.ts
  - src/run-control/submit-result.ts
  - src/runtime/config-error.ts
  - src/runtime/durable-store/acquisition.ts
  - src/runtime/journal-acquisition.ts
  - src/runtime/node-execution.ts
  - src/runtime/opencode-runtime.ts
  - src/runtime/runtime-results.ts
  - src/runtime/scheduled-dependencies.ts
  - src/runtime/workflow-execution.ts
  - tests/next-node-submit-result-pg.test.ts
  - tests/runtime-refactor-boundaries.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 305000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: Split src/pipeline-runtime.ts into runtime facade, dependency/result mapping, lifecycle execution, journal acquisition, and public error formatting.
Dependencies: PIPE-45.3, PIPE-45.4, PIPE-45.7
Likely modified files: src/pipeline-runtime.ts, src/runtime/workflow/_, tests/pipeline-runtime.test.ts, tests/runtime-_.test.ts
Reuse: Effect runtime substrate remains; existing scheduler/journal modules stay owners.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Public ./runtime facade stays compatible while internals move behind owned modules -- Evidence: `bun run test tests/runtime-refactor-boundaries.test.ts tests/pipeline-runtime.test.ts tests/runtime-scheduler-workflow.test.ts tests/package-public-api.test.ts tests/moka-resume.test.ts tests/moka-resume-schedule.test.ts tests/durable-resume-postgres.test.ts tests/run-control-runtime-reporter.test.ts tests/supervised-run.test.ts tests/tracer-bullet.test.ts` passed, 97 tests, 6 skipped.
- [x] #2 src/pipeline-runtime.ts falls below 1k lines or records structural justification -- Evidence: `wc -l src/pipeline-runtime.ts` reports 103 lines; `pnpm exec fallow audit --changed-since HEAD --production` passed with no changed-file gate issues.
- [x] #3 No scheduler/runtime semantics drift -- Evidence: focused runtime/API tests passed, including `tests/runtime-scheduler-workflow.test.ts`, `tests/pipeline-runtime.test.ts`, `tests/moka-resume.test.ts`, and `tests/durable-resume-postgres.test.ts`.
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->

## Evidence

- RED: `bun run test tests/runtime-refactor-boundaries.test.ts` initially failed because the runtime owner files were missing and `src/pipeline-runtime.ts` was 1735 lines.
- GREEN/boundary: `bun run test tests/runtime-refactor-boundaries.test.ts` passed.
- GREEN/focused: `bun run test tests/runtime-refactor-boundaries.test.ts tests/pipeline-runtime.test.ts tests/runtime-scheduler-workflow.test.ts tests/package-public-api.test.ts tests/moka-resume.test.ts tests/moka-resume-schedule.test.ts tests/durable-resume-postgres.test.ts tests/run-control-runtime-reporter.test.ts tests/supervised-run.test.ts tests/tracer-bullet.test.ts` passed, 97 tests, 6 skipped.
- GREEN/durable-store focus: `bun run test tests/next-node-submit-result-pg.test.ts tests/durable-resume-postgres.test.ts tests/moka-resume.test.ts tests/pipeline-runtime.test.ts` passed, 65 tests, 6 skipped.
- Static: `bun run typecheck` passed.
- Static: `bun run check` passed.
- Static: `pnpm exec fallow audit --changed-since HEAD --production` passed with no changed-file gate issues; inherited `next-node` warnings remained excluded by the production gate.
- Build: `bun run build` passed.
- Security: `pnpm audit --audit-level high` passed; only low/moderate advisories reported.
- Full suite: `bun run test` passed, 149 files, 1098 tests, 41 skipped.
- Diff: `git diff --check` passed.
