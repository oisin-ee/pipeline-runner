---
id: PIPE-19.2
title: Scaffold default pipeline with `pipe init`
status: Done
assignee: []
created_date: "2026-05-24 14:17"
updated_date: "2026-05-25 08:52"
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
modified_files:
  - src/pipeline-init.ts
  - src/index.ts
  - tests/pipeline-init.test.ts
  - tests/cli.test.ts
  - backlog/tasks/pipe-19.2 - Scaffold-default-pipeline-with-`pipe-init`.md
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

- [x] #1 `pipe init` creates `.pipeline/pipeline.yaml` when no config exists.
- [x] #2 The scaffold includes prompt files, JSON schema files where needed, and generated host resource inputs required by the default workflow.
- [x] #3 The scaffolded default workflow expresses research, red, green, verify, and learn as configurable workflow nodes rather than runtime constants.
- [x] #4 `pipe init` refuses to overwrite existing user config unless an explicit overwrite flag is used.
- [x] #5 Tests cover first-time init, existing config protection, overwrite behavior, and generated file completeness.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Implement `pipe init` as a first-class CLI subcommand that creates `.pipeline/pipeline.yaml` plus prompt/schema/resource-input files for the default research/red/green/verify/learn workflow. Reuse the v1 config contract from PIPE-19.1, refuse overwrites by default, support explicit overwrite, and add CLI/scaffold tests for generated completeness.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented `pipe init` with a complete default `.pipeline/pipeline.yaml` scaffold, prompt files, JSON schema files, rules, and host-resource input files. Added overwrite protection with `--overwrite`, direct `pipe init` binary handling, and tests for first-time init, generated completeness, workflow node shape, conflict protection, overwrite behavior, and CLI invocation.

<!-- SECTION:FINAL_SUMMARY:END -->
