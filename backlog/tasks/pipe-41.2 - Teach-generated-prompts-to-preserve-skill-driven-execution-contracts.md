---
id: PIPE-41.2
title: Teach generated prompts to preserve skill-driven execution contracts
status: Done
assignee: []
created_date: '2026-06-03 18:25'
updated_date: '2026-06-04 09:22'
labels:
  - pipeline
  - skills
  - phase-1
dependencies:
  - PIPE-41.1
references:
  - .pipeline/prompts/code-writer.md
  - .pipeline/prompts/schedule-planner.md
  - src/pipeline-init.ts
modified_files:
  - .pipeline/prompts/code-writer.md
  - .pipeline/prompts/schedule-planner.md
  - src/pipeline-init.ts
  - tests/pipeline-init.test.ts
parent_task_id: PIPE-41
priority: high
ordinal: 90000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the human-readable prompt layer match the new profile behavior so scheduled agents know that implementation is an execute-skill vertical slice and schedule refinement must preserve the full execution graph.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Checked-in `.pipeline/prompts/code-writer.md` names the `execute` contract: read context, choose the seam, use library-first/TDD, reject bandaids, and report targeted evidence
- [x] #2 Generated `src/pipeline-init.ts` code-writer prompt contains the same execute-contract guidance
- [x] #3 Checked-in `.pipeline/prompts/schedule-planner.md` tells planners to preserve research, test, implementation, acceptance, verification, and learning phases unless a valid graph change is justified
- [x] #4 Generated `src/pipeline-init.ts` schedule-planner prompt contains the same graph-preservation guidance
- [x] #5 Prompt tests assert the scaffolded prompt text contains the new contract language
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update only prompt markdown and the prompt strings inside `src/pipeline-init.ts`. Keep profile ids and workflow ids unchanged. Add or adjust `tests/pipeline-init.test.ts` assertions for scaffolded prompt content.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Updated checked-in and scaffolded prompts to preserve skill-driven execution contracts and schedule graph preservation expectations. Verified during backlog grooming on 2026-06-04 with the full repository verification suite.
<!-- SECTION:FINAL_SUMMARY:END -->
