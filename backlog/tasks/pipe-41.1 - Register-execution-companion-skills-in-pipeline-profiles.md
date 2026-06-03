---
id: PIPE-41.1
title: Register execution companion skills in pipeline profiles
status: To Do
assignee: []
created_date: '2026-06-03 18:25'
updated_date: '2026-06-03 18:25'
labels:
  - pipeline
  - skills
  - phase-1
dependencies: []
references:
  - .pipeline/profiles.yaml
  - src/pipeline-init.ts
modified_files:
  - .pipeline/profiles.yaml
  - src/pipeline-init.ts
  - tests/pipeline-init.test.ts
  - tests/config.test.ts
parent_task_id: PIPE-41
priority: high
ordinal: 89000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add the missing profile-level skill wiring for the recommended first phase: make execute, grill, and quality-gate available in the profile registry, and attach execute/improve/quality-gate to the profiles that schedule and implement workflow nodes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `.pipeline/profiles.yaml` declares skill paths for `execute`, `grill`, and `quality-gate`
- [ ] #2 `src/pipeline-init.ts` scaffolded `DEFAULT_PROFILES_YAML` declares the same skill paths
- [ ] #3 `pipeline-code-writer` includes `execute`, `trace`, `test`, `fix`, `library-first-development`, `improve`, and `quality-gate`
- [ ] #4 `pipeline-schedule-planner` includes `research`, `scope`, `grill`, `improve`, and `quality-gate`
- [ ] #5 `pipeline-verifier` includes `verify`, `critique`, `secure`, `optimize`, and `quality-gate`
- [ ] #6 Existing profile ids remain stable; no workflow node references need to change for this ticket
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update checked-in `.pipeline/profiles.yaml` and the generated `DEFAULT_PROFILES_YAML` string in `src/pipeline-init.ts`. Add focused assertions in `tests/pipeline-init.test.ts` and, if useful, `tests/config.test.ts` that loaded scaffold config exposes the same skill registry and profile skill lists.
<!-- SECTION:PLAN:END -->
