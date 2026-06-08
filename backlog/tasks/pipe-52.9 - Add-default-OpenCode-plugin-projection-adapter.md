---
id: PIPE-52.9
title: Add default OpenCode plugin projection adapter
status: Done
assignee: []
created_date: '2026-06-08 19:01'
labels:
  - opencode
  - plugins
  - host-resources
dependencies:
  - PIPE-52.8
references:
  - 'https://opencode.ai/docs/plugins'
  - src/install-commands.ts
modified_files:
  - src/install-commands.ts
  - src/config.ts
  - defaults/opencode-ecosystem.yaml
  - defaults/opencode/plugins/pipeline-goal-context.ts
  - tests/install-commands.test.ts
  - tests/opencode-ecosystem.test.ts
parent_task_id: PIPE-52
priority: medium
ordinal: 154000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Project the curated default OpenCode plugin stack into generated project OpenCode config without writing global config.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Config supports a package-owned default plugin stack with version pins or local paths for accepted plugins.
- [x] #2 Generated .opencode/opencode.json includes default plugin entries from the curated stack and never overwrites manually edited files without force.
- [x] #3 Installer check and dry-run modes show plugin projection changes without installing packages.
- [x] #4 The adapter can project local package-owned plugins for curated stack features.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use OpenCode plugin config semantics from official docs. Treat plugins as host resources alongside MCP and agents. Generate the curated default plugin stack deterministically.
<!-- SECTION:PLAN:END -->
