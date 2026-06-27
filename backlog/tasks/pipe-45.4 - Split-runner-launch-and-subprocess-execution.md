---
id: PIPE-45.4
title: Split runner launch and subprocess execution
status: Done
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/runner.ts
  - src/runner/subprocess.ts
  - src/runner/subprocess-result.ts
modified_files:
  - src/runner.ts
  - src/runner/subprocess.ts
  - src/runner/subprocess-result.ts
  - tests/runner.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 299000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Keep `src/runner.ts` as the real launch-planning and runner-contract owner, and split subprocess execution, OpenCode excludes, timeout policy, and result mapping into `src/runner/*` owner modules. No facade, alias layer, or compatibility shim.
Dependencies: PIPE-45.1
Likely modified files: src/runner.ts, src/runner/*, tests/runner.test.ts, tests/protected-paths.test.ts
Reuse: execa remains subprocess library; no custom process runner.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Runner launch planning and subprocess execution have separate owners -- Evidence: `src/runner.ts` owns planning/contracts, `src/runner/subprocess.ts` owns execution, `src/runner/subprocess-result.ts` owns result mapping; focused runner tests passed 45 tests.
- [x] #2 Public `./runner` package surface remains a concrete owner module, not a facade -- Evidence: package export still maps to `dist/runner.js`; `tsdown.config.ts` builds `src/runner.ts` directly; subprocess execution is imported by internal callers from `src/runner/subprocess.ts`.
- [x] #3 Unsafe catch casts/assertions are removed or explicitly validated at boundaries -- Evidence: subprocess result mapping validates unknown errors in `src/runner/subprocess-result.ts`; `bun run typecheck` and `bun run check` passed.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run feature-implementation workflow in order and record proof. Proof: `bun run typecheck` passed; `bun run check` passed; `pnpm exec fallow audit --changed-since HEAD --production` exited 0 with no issues in changed files; `bun run build` passed; `bun run test` passed 144 files, 1088 tests, 41 skipped.
<!-- DOD:END -->
