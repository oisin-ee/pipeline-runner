---
id: PIPE-52.12
title: Dogfood OpenCode-first goal loop through real pipeline usage
status: To Do
assignee: []
created_date: '2026-06-08 19:02'
labels:
  - verification
  - dogfood
  - opencode
dependencies:
  - PIPE-52.4
  - PIPE-52.5
  - PIPE-52.6
  - PIPE-52.7
  - PIPE-52.9
  - PIPE-52.10
  - PIPE-52.11
references:
  - AGENTS.md
  - package.json
  - tests/dogfood-installed.test.ts
modified_files:
  - tests/dogfood-installed.test.ts
  - tests/dogfood-live-runners.test.ts
parent_task_id: PIPE-52
priority: high
ordinal: 157000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Verify the complete OpenCode-first goal-loop system through real repository usage paths, not isolated scripts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Run package checks: bun run typecheck, bun run check, bun run test, and bun run build.
- [ ] #2 Run real generated-host checks: pipe install-commands --host opencode --check and pipe validate.
- [ ] #3 Generate and inspect at least one scheduled pipe artifact and one team-graph schedule artifact, then run validate and explain-plan on both.
- [ ] #4 Run a built or dogfood-installed OpenCode workflow that exercises goal-state persistence, a verifier failure or acceptance failure continuation, and a final PASS or explicit blocked outcome.
- [ ] #5 If Kubernetes runner-job path is in scope for the implementation branch, run the real runner-job manifest/product path with orchestrator opencode and report event evidence; do not use ad hoc cluster probes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
This is the final integration gate. Use the repository Verification Standard: real CLI, generated command surfaces, installed/dogfood flow, build, and representative end-to-end path. Report exact commands and what they proved.
<!-- SECTION:PLAN:END -->
