---
id: PIPE-104.2
title: 'Generate TS types from yeet JSON Schema, importable in oisin-pipeline'
status: To Do
assignee: []
created_date: '2026-07-04 10:55'
updated_date: '2026-07-04 19:41'
labels: []
dependencies:
  - PIPE-104.1
parent_task_id: PIPE-104
priority: high
ordinal: 343000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation. What to build: a codegen step that turns yeet's emitted JSON Schema (from the schema ticket) into TypeScript types for RunSpec + Event, importable by oisin-pipeline so the executor never redeclares yeet's wire shapes. Wire it as a generation script (json-schema-to-typescript or equivalent) producing a checked-in or build-generated .ts, plus an npm/nub script to regenerate. One source of truth: types derive from yeet's schema, not hand-authored. Scope: oisin-pipeline — a generated types module + generation script + package script; consumes `yeet schema` output. Research required: json-schema-to-typescript (or ts-morph/quicktype) via research + library-first-development; confirm it handles the discriminated Event union tag cleanly. Model recommendation — Claude: Sonnet (mechanical codegen wiring; claude 2.1.199); Codex: gpt-5.5-medium (0.142.5); OpenCode: MoKa Code Writer default (1.17.12).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Generated RunSpec + Event TS types compile and an import file typechecks -- Evidence: tsc/nub typecheck passes on a file importing both
- [ ] #2 Regeneration is reproducible from yeet schema output -- Evidence: re-running the gen script on unchanged schema yields no diff
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Groomed 2026-07-04. Un-started, valid, correctly blocked on 104.1. No generated yeet TS types module and no schema-gen script in oisin-pipeline. NOTE: package manager here is `nub` + vitest + ultracite (not npm/bun) — the regen script should be a `nub run` package script (bin name is `moka`). Keep To Do.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 Typecheck + gen-idempotency check run fresh, output recorded
<!-- DOD:END -->
