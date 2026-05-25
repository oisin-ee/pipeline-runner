---
id: PIPE-19.2
title: Scaffold default pipeline with `pipe init`
status: To Do
assignee: []
created_date: '2026-05-24 14:17'
updated_date: '2026-05-24 14:18'
labels:
  - pipeline
  - cli
  - scaffold
dependencies:
  - PIPE-19.1
references:
  - src/index.ts
  - src/install-commands.ts
  - src/pipeline-spec.ts
parent_task_id: PIPE-19
priority: high
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace hidden built-in defaults with an explicit initialization flow. `pipe init` should create a complete default pipeline config and supporting files that represent the current research/red/green/verify/learn behavior as data. The scaffolded files become the user-editable source of truth for subsequent `pipe run` executions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `pipe init` creates `.pipeline/pipeline.yaml` when no config exists.
- [ ] #2 The scaffold includes prompt files, JSON schema files where needed, and generated host resource inputs required by the default workflow.
- [ ] #3 The scaffolded default workflow expresses research, red, green, verify, and learn as configurable workflow nodes rather than runtime constants.
- [ ] #4 `pipe init` refuses to overwrite existing user config unless an explicit overwrite flag is used.
- [ ] #5 Tests cover first-time init, existing config protection, overwrite behavior, and generated file completeness.
<!-- AC:END -->
