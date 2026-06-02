---
id: PIPE-39.2
title: Add project skill path resolution
status: Done
assignee: []
created_date: '2026-06-02 16:33'
updated_date: '2026-06-02 20:46'
labels:
  - skills
  - config
dependencies: []
references:
  - src/config.ts
  - src/runner.ts
  - src/install-commands.ts
  - src/pipeline-runtime.ts
  - tests/config.test.ts
  - tests/runner.test.ts
modified_files:
  - src/path-refs.ts
  - src/config.ts
  - src/runner.ts
  - src/install-commands.ts
  - src/pipeline-runtime.ts
  - tests/config.test.ts
  - tests/runner.test.ts
parent_task_id: PIPE-39
priority: high
ordinal: 66000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Allow configured file references, especially skills.*.path, to point at project-installed .agents/skills and still support explicit absolute or home-relative paths for advanced configurations. This establishes one shared path-resolution contract before default profiles move to project-local skill installs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Config validation accepts skill paths that start with ~/ and resolves them against the current HOME directory.
- [x] #2 Config validation accepts absolute skill paths without prefixing the project root.
- [x] #3 Relative skill, rule, instruction, schema, and MCP ref paths continue to resolve relative to the project root.
- [x] #4 Runtime skill loading uses the same resolver as config validation for Codex, Kimi, Pi, generated Codex native agent config, and pipeline runtime context rendering.
- [x] #5 Tests cover relative, absolute, and ~/ skill paths, including the failure case where file-reference resolution should not blindly prefix every configured path with the project root.
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create a small path-reference helper, for example src/path-refs.ts, that resolves relative paths against project/worktree root, expands ~ using HOME, and preserves absolute paths. Replace ad hoc join(projectRoot, value) and join(worktreePath, skill.path) behavior only where file-reference semantics are intended.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented as part of PIPE-39. Verification: bun run check passed; bun run typecheck passed; bun run test passed with 279 tests passing and 15 live-runner tests skipped.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Focused tests or documented research evidence cover the ticket acceptance criteria.
- [x] #2 Relevant project verification command is run and its result is recorded in the task final summary.
- [x] #3 Diff is reviewed for unrelated edits, unsafe casts/assertions, disabled checks, and shallow glue before marking done.
<!-- DOD:END -->
