---
id: PIPE-95.11
title: Clear remote Argo factory and public-surface strict lint for PIPE-95
status: To Do
assignee: []
created_date: "2026-07-05 19:19"
updated_date: "2026-07-05 18:34"
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
  - src/argo-graph.ts
  - src/argo-submit.ts
  - src/argo-workflow.ts
  - src/cluster-doctor.ts
  - src/context
  - src/factory
  - src/remote
  - src/moka-submit.ts
  - src/moka-global-config.ts
  - src/package-assets.ts
  - src/path-refs.ts
  - src/pipeline-init.ts
  - src/pipeline-runtime.ts
  - src/standard-output-schemas.ts
  - src/strings.ts
  - src/task-ref.ts
  - src/token-estimator.ts
  - tests/argo-submit.test.ts
  - tests/argo-workflow.test.ts
  - tests/dogfood-installed.test.ts
  - tests/dogfood-live-runners.test.ts
  - tests/moka-global-config.test.ts
  - tests/moka-submit.test.ts
  - tests/pipeline-init.test.ts
  - tests/pipeline-runtime.test.ts
  - tests/token-estimator.test.ts
  - tests/tracer-bullet.test.ts
parent_task_id: PIPE-95
priority: medium
ordinal: 356000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
What to build: Clear strict/type-aware/Effect lint diagnostics owned by Argo submission/modeling, remote submit, factory, context/repo-map, package/public runtime surfaces, and paired tests.
Scope: src/argo\*.ts, src/remote/**, src/factory/**, src/context/\*\*, public package/runtime helper files not owned by earlier lanes, and paired tests. Do not touch runtime core, runner, run-control, CLI/config, planning/schedule/tickets, or package metadata unless recording a transferred residual.
Dependencies / Blocked by: PIPE-95.5.
Likely modified files: remote/Argo/factory/context/public-surface files and paired tests named by the fresh lint JSON.
Research required: inspect remote submit contracts, Argo models/templates, factory command boundaries, safe JSON/schema helpers, and existing service wrappers before edits.
Model recommendation:

- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-high -- remote/Argo lane has submit/runtime behaviour risk; current host exposes gpt-5.5.
- OpenCode: moka-code-writer/default -- dispatch must revalidate live availability.
  Escalation:
- Met: remote/Argo/factory diagnostics clear with focused tests and typecheck.
- Unmet: record exact file/rule/count and missing schema/service contract.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 Remote/Argo/factory/public-surface diagnostics are cleared. -- Evidence: parsed oxlint JSON filtered to this lane write boundary shows zero errors except transferred residuals with rule/file/count.
- [ ] #2 Remote/Argo/factory behaviours remain covered. -- Evidence: focused tests for touched files pass and nub run typecheck exits 0.
- [ ] #3 Write boundary is respected. -- Evidence: review lists any out-of-bound file touched and why it was required, otherwise no out-of-bound source/test edits.
- [ ] #4 No shortcut suppressions or type escapes are introduced. -- Evidence: git diff --check exits 0 and added-line escape scan exits 1.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Filter lint JSON to remote/Argo/factory/context/public-surface paths, group by submit/schema/service boundary, repair one seam at a time, run focused tests, then rerun filtered counts and typecheck.

<!-- SECTION:PLAN:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 The ticket global-rules feature-implementation workflow was run in order.
- [ ] #2 Focused proof ran fresh and output was recorded.
- [ ] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
