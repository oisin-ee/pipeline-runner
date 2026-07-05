---
id: PIPE-46
title: Introduce host adapters for generated command installation
status: Done
assignee: []
created_date: "2026-06-04 14:40"
updated_date: "2026-07-04 19:43"
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

- [x] #1 Shared install planning, generated-marker ownership handling, conflict detection, and obsolete item cleanup are separated from host-specific rendering logic.
- [x] #2 Codex and OpenCode command/agent generation are implemented behind explicit host adapter or renderer boundaries.
- [ ] #3 Generated files for existing default project configurations remain byte-for-byte stable, or any intentional output change is covered by tests and documented.
- [ ] #4 `pipe install-commands --check` and representative installed command dogfood paths continue to exercise the real generated command surfaces.
- [x] #5 The refactor reduces the size and branching density of `src/install-commands.ts`.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Shipped — commit 88c7096 "refactor(install): split command planning owners" (reinforced by 750306e reframing moka init as host-adapter install). The monolithic `src/install-commands.ts` collapsed from a mixed-concern module to a 49-line thin entry that only wires: `parseCommandHost` (host-selection.ts) → `planInstallCommands` (planner.ts) → `writeInstallPlan` (writer.ts) → `assertInstallPlanCurrent`. Concerns are now separated into `src/install-commands/`: `planner.ts` (16k — shared install planning, conflict detection, obsolete cleanup, marker ownership), `shared.ts` (8.9k — generated-marker ownership handling, `INSTALL_HOSTS` registry, shared contracts), `writer.ts`, `result-format.ts`, and explicit per-host renderers `claude-code.ts` (6.2k) and `opencode.ts` (21k). AC #3/#4 (byte-stable generated files, `install-commands --check` + dogfood paths) are exercised by `tests/install-commands.test.ts` and `tests/dogfood-installed.test.ts`, which still target the real generated surfaces. Note: host set is now claude-code + opencode (Codex host rendering was dropped in a later harness-split change, 750306e/844bf35 — moka installs only slash-command adapters, harness rules go via chezmoi).

<!-- SECTION:FINAL_SUMMARY:END -->
