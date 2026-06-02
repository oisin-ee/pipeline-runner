---
id: PIPE-39.3
title: Switch defaults from skill installation to ~/dev/skills
status: Done
assignee: []
created_date: '2026-06-02 16:33'
updated_date: '2026-06-02 20:46'
labels:
  - skills
  - init
  - opencode
  - codex
dependencies:
  - PIPE-39.2
references:
  - src/pipeline-init.ts
  - defaults/install-manifest.json
  - .pipeline/profiles.yaml
  - tests/pipeline-init.test.ts
  - tests/cli.test.ts
  - README.md
modified_files:
  - src/pipeline-init.ts
  - defaults/install-manifest.json
  - .pipeline/profiles.yaml
  - tests/pipeline-init.test.ts
  - tests/cli.test.ts
  - README.md
parent_task_id: PIPE-39
priority: high
ordinal: 67000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Remove the init-time default skill installation path and make the generated default profiles point at the opinionated external skills repository at ~/dev/skills. The package should stop copying skills into each initialized repo and stop treating skills-lock.json as generated pipeline output.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 pipe init no longer invokes npx skills add, no longer requires DEFAULT_SKILL_INSTALLS, and no longer verifies .agents/skills files after init.
- [x] #2 Generated .pipeline/profiles.yaml declares only skill IDs that exist in ~/dev/skills/.agents/skills or ~/dev/skills/skills, using the canonical short names such as test, verify, critique, trace, improve, secure, optimize, migrate, spec, scope, research, execute, and library-first-development.
- [x] #3 Default profile skill grants are updated from old long aliases to canonical external skill IDs, and missing old skill aliases are removed rather than silently kept.
- [x] #4 The thermo-nuclear/final review profile uses an available external review skill or a dedicated prompt; it does not reference a repo-local .agents/skills/thermo-nuclear-code-quality-review/SKILL.md unless that file is intentionally still generated.
- [x] #5 OpenCode command/agent generation remains present and does not depend on Codex-only skill installation.
- [x] #6 README and init tests describe the new prerequisite: ~/dev/skills must be present, and init does not copy skills into the target repo.
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
After PIPE-39.2 path resolution lands, update DEFAULT_PROFILES_YAML in src/pipeline-init.ts and the checked-in .pipeline/profiles.yaml to use external skill paths. Remove the skills CLI installer path, DEFAULT_SKILL_INSTALLS usage, assertDefaultSkillsInstalled, generated skill file reporting, and tests that fake repo-local skill copies. Preserve MCP installation behavior for now.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented as part of PIPE-39. Verification: bun run check passed; bun run typecheck passed; bun run test passed with 277 tests passing and 15 live-runner tests skipped.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Focused tests or documented research evidence cover the ticket acceptance criteria.
- [x] #2 Relevant project verification command is run and its result is recorded in the task final summary.
- [x] #3 Diff is reviewed for unrelated edits, unsafe casts/assertions, disabled checks, and shallow glue before marking done.
<!-- DOD:END -->
