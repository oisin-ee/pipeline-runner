---
id: PIPE-41.1
title: Register execution companion skills in pipeline profiles
status: Done
assignee: []
created_date: "2026-06-03 18:25"
updated_date: "2026-06-04 09:22"
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

- [x] #1 `.pipeline/profiles.yaml` declares skill paths for `execute`, `grill`, and `quality-gate`
- [x] #2 `src/pipeline-init.ts` scaffolded `DEFAULT_PROFILES_YAML` declares the same skill paths
- [x] #3 `pipeline-code-writer` includes `execute`, `trace`, `test`, `fix`, `library-first-development`, `improve`, and `quality-gate`
- [x] #4 `pipeline-schedule-planner` includes `research`, `scope`, `grill`, `improve`, and `quality-gate`
- [x] #5 `pipeline-verifier` includes `verify`, `critique`, `secure`, `optimize`, and `quality-gate`
- [x] #6 Existing profile ids remain stable; no workflow node references need to change for this ticket
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Update checked-in `.pipeline/profiles.yaml` and the generated `DEFAULT_PROFILES_YAML` string in `src/pipeline-init.ts`. Add focused assertions in `tests/pipeline-init.test.ts` and, if useful, `tests/config.test.ts` that loaded scaffold config exposes the same skill registry and profile skill lists.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Registered the execution companion skills in checked-in and scaffolded pipeline profiles while preserving stable profile ids. Verified during backlog grooming on 2026-06-04 with `bun run typecheck`, `bun run check`, `bun run build`, `bun run test`, and `bun run test:dogfood`.

<!-- SECTION:FINAL_SUMMARY:END -->
