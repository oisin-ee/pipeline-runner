---
id: PIPE-39.3
title: Install default skills with npx skills add
status: Done
assignee: []
created_date: "2026-06-02 16:33"
updated_date: "2026-06-02 20:46"
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

Install default project skills with npx skills add oisincoveney/skills and make generated default profiles point at the resulting .agents/skills paths.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 pipe init invokes npx skills add oisincoveney/skills through DEFAULT_SKILL_INSTALLS before config validation.
- [x] #2 Generated .pipeline/profiles.yaml declares canonical skill IDs installed into .agents/skills, such as test, verify, critique, trace, improve, secure, optimize, migrate, spec, scope, research, execute, and library-first-development.
- [x] #3 Default profile skill grants are updated from old long aliases to canonical project skill IDs, and missing old skill aliases are removed rather than silently kept.
- [x] #4 The thermo-nuclear/final review profile uses an installed project review skill or a dedicated prompt.
- [x] #5 OpenCode command/agent generation remains present and does not depend on Codex-only skill installation.
- [x] #6 README and init tests describe npx skills add oisincoveney/skills and project-installed .agents/skills.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Update DEFAULT_PROFILES_YAML in src/pipeline-init.ts and the checked-in .pipeline/profiles.yaml to use .agents/skills paths. Restore the skills CLI installer path with DEFAULT_SKILL_INSTALLS using npx skills add oisincoveney/skills. Preserve MCP installation behavior.

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
