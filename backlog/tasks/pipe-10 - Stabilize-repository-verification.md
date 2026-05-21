---
id: PIPE-10
title: Stabilize repository verification
status: In Progress
assignee:
  - Codex
created_date: '2026-05-21 09:19'
updated_date: '2026-05-21 09:34'
labels:
  - stabilization
  - verification
dependencies: []
references:
  - src/index.ts
  - src/mastra/steps/verify.ts
  - package.json
  - README.md
priority: high
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Bring the current pipeline repository to a clean verification baseline so future agents can trust the local checks. The current state passes Vitest, typecheck, and Mastra build, but `bun run check` reports formatting/lint issues and `bun test` invokes the wrong runner for this Vitest suite.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `bun run test` passes on a clean checkout.
- [ ] #2 `bun run typecheck` passes on a clean checkout.
- [ ] #3 `bun run build` passes on a clean checkout.
- [ ] #4 `bun run check` passes on a clean checkout.
- [ ] #5 Project documentation clearly states the supported test command and avoids implying that Bun's native test runner is the intended suite runner.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implementation plan:
1. Work in a dedicated `wt` branch/worktree `pipe-10-stabilize-verification` based on current `main`.
2. Fix the current verification failures without broad refactors: format/lint issues, static gate self-conflict, and any generated/noise files affecting clean status.
3. Update README/package docs so `bun run test` is clearly the supported Vitest command and Bun's native `bun test` is not implied as the project suite.
4. Run and require all acceptance checks: `bun run test`, `bun run typecheck`, `bun run check`, and `bun run build`.
5. Commit the scoped changes in the worktree, merge back to `main`, rerun verification on `main`, then check off acceptance criteria and mark the ticket Done.
<!-- SECTION:PLAN:END -->
