---
id: PIPE-45.17
title: Delete proven dead surface
status: Done
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.1
  - PIPE-45.2
  - PIPE-45.3
  - PIPE-45.4
  - PIPE-45.5
  - PIPE-45.6
  - PIPE-45.7
  - PIPE-45.8
  - PIPE-45.9
  - PIPE-45.10
  - PIPE-45.11
  - PIPE-45.12
  - PIPE-45.13
  - PIPE-45.14
  - PIPE-45.15
references:
  - src/runtime/index.ts
  - src/schedule/artifact.ts
  - package.json
modified_files:
  - .fallowrc.json
  - bun.lock
  - package.json
  - pnpm-lock.yaml
  - src/runtime/gates/adjudicator/adjudicator.test.ts
  - src/runtime/gates/gates.test.ts
  - src/runtime/gates/kinds/builtin/builtin.test.ts
  - src/runtime/gates/registry.test.ts
  - src/runtime/services/backlog-service.ts
  - src/tickets/completion/complete-ticket.test.ts
  - tests/gate-test-context.ts
  - tests/schedule-planner-boundaries.test.ts
parent_task_id: PIPE-45
priority: medium
ordinal: 312000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Delete static-analysis-proven dead files/exports/deps only after public contract guard proves they are private. Candidate surfaces from baseline include src/runtime/index.ts, src/schedule/artifact.ts, unused run-control exports, duplicate runner adapter exports, and package.json unused dependency rulesync if still confirmed.
Dependencies: PIPE-45.1 and structural splits through PIPE-45.15
Likely modified files: src/runtime/index.ts, src/schedule/artifact.ts, package.json, focused importers/tests
Reuse: knip, fallow, rg, package public API tests; no manual guess deletion.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every deletion has static-analysis and rg/import evidence proving no public/internal consumer -- Evidence: `pnpm dlx knip --reporter compact --no-progress` no longer reports `src/runtime/index.ts`, `src/schedule/artifact.ts`, `rulesync`, or `BacklogParseError`; `pnpm exec fallow audit --changed-since HEAD --production` reports no issues in 16 changed files; `rg` found no live imports of `runtime/index`, `schedule/artifact`, `runtime/gates/gate-test-context`, `BacklogParseError`, or a package manifest `rulesync` dependency. `src/runtime/gates/gate-test-context.ts` was moved to `tests/gate-test-context.ts` because it is test support, not production runtime surface.
- [x] #2 Public package surface remains compatible or migration evidence is explicit -- Evidence: `bun run test tests/schedule-planner-boundaries.test.ts tests/package-public-api.test.ts tests/runtime-actor-contract-boundary.test.ts tests/install-rules.test.ts src/runtime/gates/gates.test.ts src/runtime/gates/registry.test.ts src/runtime/gates/adjudicator/adjudicator.test.ts src/runtime/gates/kinds/builtin/builtin.test.ts src/tickets/completion/complete-ticket.test.ts` passed, 9 files / 55 tests. `./runtime` still maps to `dist/pipeline-runtime.js`; `./schedule` still maps to `dist/planning/generate.js`.
- [x] #3 Package dependency deletion updates lockfile through package manager only -- Evidence: `pnpm remove rulesync` removed the dependency and updated `pnpm-lock.yaml`; `bun install --lockfile-only` updated `bun.lock`; `bun pm why rulesync` reports `No packages matching 'rulesync' found in lockfile`. Runtime generation still shells the pinned CLI string `rulesync@8.30.1`, proven by `tests/install-rules.test.ts`.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run feature-implementation workflow with dead-code proof and quality-gate review; record proof. Evidence: `bun run check`; `bun run typecheck`; focused tests above; `pnpm exec fallow audit --changed-since HEAD --production`; `pnpm exec fallow dead-code --production`; `pnpm dlx knip --reporter compact --no-progress`. Non-deletions: `defaults/opencode/plugins/pipeline-goal-context.ts` is an install asset referenced by `defaults/opencode-ecosystem.yaml`; goal-loop/goal-state files remain because runtime/dogfood tests still exercise them internally and their removal is a separate retired-cluster decision, not a safe single-file deletion.
<!-- DOD:END -->
