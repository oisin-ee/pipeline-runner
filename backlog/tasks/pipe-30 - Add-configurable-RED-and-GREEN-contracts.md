---
id: PIPE-30
title: Add configurable RED and GREEN contracts
status: Done
assignee: []
created_date: '2026-05-25 20:03'
updated_date: '2026-05-25 20:32'
labels:
  - gates
  - testing
  - workflow-contracts
dependencies:
  - PIPE-25
  - PIPE-27
priority: high
ordinal: 42000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Recover useful RED/GREEN guarantees from the old hardcoded pipeline as generic configurable runtime contracts. The old Mastra implementation knew what RED and GREEN meant, but it was hardcoded to the old phase model. The YAML runtime needs equivalent enforcement primitives that remain project-configured and tool-agnostic.

RED should be able to require that a node changes test files and that a project-configured command fails. GREEN should be able to require project-configured commands to pass and optionally prevent implementation agents from modifying tests. The core must not assume `tests/`, Vitest, Bun, TypeScript, `src/`, or any language-specific layout.

Scope:
- Add runtime support for taking a worktree snapshot before a node and evaluating changed files after the node.
- Add configurable changed-file policies with allow/deny/require-any globs.
- Add or compose gates/contracts so RED can require expected command failure and GREEN can require expected command success.
- Keep all commands and file globs project-configured.

Non-goals:
- Do not build a Vitest/Jest-specific parser into core.
- Do not hardcode test directories or source directories.
- Do not add acceptance-criteria coverage gating here.
- Do not reintroduce old hardcoded Mastra RED/GREEN steps.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Runtime can enforce changed-file policies around a node.
- [x] #2 RED can require changed test files using project-configured globs.
- [x] #3 RED can require a project-configured command to fail.
- [x] #4 GREEN can require project-configured commands to pass.
- [x] #5 Core does not assume tests/, Vitest, Bun, TypeScript, or src/.
- [x] #6 Changed-file policies handle tracked and untracked files intentionally.
- [x] #7 Tests cover allowed changes, denied changes, missing required changes, and expected command outcomes.
- [x] #8 Documentation includes examples for at least two different project layouts.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a worktree snapshot abstraction, likely git-backed first, that records changed files before and after a node.
2. Add config schema for changed-file policies: `allow`, `deny`, `require_any`, and optional behavior for untracked files.
3. Implement a `changed_files` gate or equivalent contract that evaluates the node's file changes.
4. Use existing `command` gates for expected pass/fail command outcomes where possible; add contract syntax only if composition is too awkward.
5. Add runtime tests with temporary git worktrees or controlled diff providers for allowed changes, denied changes, no required changes, and untracked files.
6. Add RED workflow tests showing project-configured test globs and expected failing command behavior.
7. Add GREEN workflow tests showing project-configured passing commands and optional test-file denial.
8. Document examples for different project layouts so the feature is clearly config-driven.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added git-backed changed-file policy gates plus command pass/fail composition for RED/GREEN contracts, with project-configured globs/commands, no test-framework assumptions, tests, and docs.
<!-- SECTION:FINAL_SUMMARY:END -->
