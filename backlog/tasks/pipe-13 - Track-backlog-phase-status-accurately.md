---
id: PIPE-13
title: Track backlog phase status accurately
status: To Do
assignee: []
created_date: '2026-05-21 09:19'
labels:
  - backlog
  - workflow
dependencies:
  - PIPE-11
references:
  - src/index.ts
  - src/mastra/backlog.ts
  - src/mastra/workflows/pipeline.ts
  - tests/cli.test.ts
priority: medium
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wire the pipeline phase tasks to the actual run lifecycle. The CLI currently creates research, test-write, implement, verify, and learn tasks, but only marks research in progress and learn done. Phase status should reflect the real step progression and failure point.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each phase task is marked In Progress when its corresponding step starts.
- [ ] #2 Each phase task is marked Done only when its corresponding step succeeds.
- [ ] #3 When a step fails, the corresponding phase records a failed or blocked state supported by Backlog.md, and later phases are not incorrectly marked Done.
- [ ] #4 The implementation either uses `findReadyPhase` meaningfully or removes/replaces it with tested lifecycle logic.
- [ ] #5 Tests cover phase status updates for successful and failing pipeline runs.
<!-- AC:END -->
