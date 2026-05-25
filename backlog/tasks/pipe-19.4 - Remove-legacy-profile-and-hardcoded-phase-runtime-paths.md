---
id: PIPE-19.4
title: Remove legacy profile and hardcoded phase runtime paths
status: To Do
assignee: []
created_date: '2026-05-24 14:17'
updated_date: '2026-05-24 14:18'
labels:
  - pipeline
  - cleanup
  - runtime
dependencies:
  - PIPE-19.1
  - PIPE-19.2
  - PIPE-19.3
references:
  - src/pipeline-spec.ts
  - src/mastra/config.ts
  - src/mastra/steps
  - src/install-commands.ts
parent_task_id: PIPE-19
priority: high
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Delete or retire the active runtime dependency on hardcoded phase arrays, role/profile resolution, `.pipeline/config.toml`, built-in prompt constants, and phase-specific orchestration code. The runtime should consume only the validated YAML config and compiled execution plan.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Runtime execution no longer imports hardcoded phase lists as the source of workflow truth.
- [ ] #2 `.pipeline/config.toml` and profile resolution are not used by `pipe run`.
- [ ] #3 Phase-specific prompt constants are replaced by configured instruction files or inline instruction references.
- [ ] #4 Tests fail if `pipe run` succeeds without `.pipeline/pipeline.yaml`.
- [ ] #5 Existing generated-resource code is updated to derive from YAML config instead of legacy agent definitions.
<!-- AC:END -->
