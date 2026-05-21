---
id: PIPE-10
title: Stabilize repository verification
status: To Do
assignee: []
created_date: '2026-05-21 09:19'
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
