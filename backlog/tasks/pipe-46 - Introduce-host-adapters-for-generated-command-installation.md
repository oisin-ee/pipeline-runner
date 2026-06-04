---
id: PIPE-46
title: Introduce host adapters for generated command installation
status: To Do
assignee: []
created_date: '2026-06-04 14:40'
labels:
  - tech-debt
  - maintainability
  - install-commands
  - codex
  - opencode
  - thermo-review
milestone: m-1
dependencies: []
references:
  - src/install-commands.ts
  - tests/install-commands.test.ts
  - tests/dogfood-installed.test.ts
  - .agents/plugins/oisin-pipeline/commands
priority: medium
ordinal: 113000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Generated command installation currently mixes shared install planning, ownership marker handling, obsolete-file cleanup, and host-specific Codex/OpenCode rendering in `src/install-commands.ts`. Refactor this into a small shared install planner plus host adapters/renderers that produce the same command definition contract. The behavior of generated files must remain stable unless an intentional compatibility change is documented.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Shared install planning, generated-marker ownership handling, conflict detection, and obsolete item cleanup are separated from host-specific rendering logic.
- [ ] #2 Codex and OpenCode command/agent generation are implemented behind explicit host adapter or renderer boundaries.
- [ ] #3 Generated files for existing default project configurations remain byte-for-byte stable, or any intentional output change is covered by tests and documented.
- [ ] #4 `pipe install-commands --check` and representative installed command dogfood paths continue to exercise the real generated command surfaces.
- [ ] #5 The refactor reduces the size and branching density of `src/install-commands.ts`.
<!-- AC:END -->
