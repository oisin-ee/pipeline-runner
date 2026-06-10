---
id: PIPE-54.5
title: Regenerate host commands for Moka
status: Done
assignee: []
created_date: '2026-06-10 14:09'
updated_date: '2026-06-10 14:32'
labels:
  - momokaya
  - generated-assets
dependencies:
  - PIPE-54.4
references:
  - src/install-commands.ts
  - tests/install-commands.test.ts
  - README.md
modified_files:
  - src/install-commands.ts
  - tests/install-commands.test.ts
parent_task_id: PIPE-54
priority: high
ordinal: 169000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Update package-generated Codex/OpenCode command and skill surfaces so users are guided to `moka submit`, not `pipe`, `quick`, or `execute` as CLI concepts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Generated quick surface invokes `moka submit --quick <task>`
- [ ] #2 Generated execute/full surface invokes `moka submit <task>` or is renamed to the Moka submit surface if the host supports one command
- [ ] #3 AGENTS.md guidance names Moka submission as the package-owned route
- [ ] #4 install-commands tests assert generated files contain `moka submit` and do not contain old `oisin-pipeline quick` or `oisin-pipeline execute` guidance
- [ ] #5 No hand-edited generated fixture drift remains; update source templates/assets that produce the generated files
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update src/install-commands.ts and any generated asset templates it owns. Keep host command names only where they are true host entrypoint aliases; the CLI they call must be `moka submit`. Run install-commands tests after changes.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Updated generated host command text so scheduled entrypoints point at moka submit / moka submit --quick instead of oisin-pipeline quick/execute.
<!-- SECTION:FINAL_SUMMARY:END -->
