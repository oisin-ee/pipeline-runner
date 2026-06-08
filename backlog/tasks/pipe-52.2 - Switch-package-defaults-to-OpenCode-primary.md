---
id: PIPE-52.2
title: Switch package defaults to OpenCode primary
status: Done
assignee: []
created_date: '2026-06-08 19:00'
updated_date: '2026-06-08 19:31'
labels:
  - opencode
  - defaults
dependencies:
  - PIPE-52.1
references:
  - src/config.ts
  - src/runner-job/run.ts
  - src/install-commands.ts
modified_files:
  - src/config.ts
  - src/runner-job/run.ts
  - src/install-commands.ts
parent_task_id: PIPE-52
priority: high
ordinal: 147000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Change package-owned default profiles and runner-job default selection so built-in pipeline work uses OpenCode first while preserving Codex runner support and host projection compatibility.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All built-in package default profiles that currently use runner: codex use runner: opencode unless explicitly documented as Codex-only.
- [ ] #2 Codex remains declared and can still be selected by explicit runner/profile/runner-job orchestrator.
- [ ] #3 Generated OpenCode host resources remain package-owned and  passes.
- [ ] #4 Existing schema-driven OpenCode output normalization and profile timeouts are preserved.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update src/config.ts package defaults and any source-generated defaults that still point built-in profiles to Codex. Refresh tests that assert package defaults. Do not remove Codex support. Real verification later happens in PIPE-52.10.
<!-- SECTION:PLAN:END -->
