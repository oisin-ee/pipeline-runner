---
id: PIPE-52.10
title: Introduce OpenCode runtime capability adapter seam
status: Done
assignee: []
created_date: "2026-06-08 19:01"
labels:
  - opencode
  - sdk
  - runtime
dependencies:
  - PIPE-52.2
references:
  - src/runner.ts
  - src/runner-output.ts
  - "https://opencode.ai/docs/plugins"
modified_files:
  - src/runner.ts
  - src/runner-output.ts
  - src/runtime/opencode-adapter.ts
  - tests/runner.test.ts
  - docs/adr-opencode-first-goal-loop-runtime.md
parent_task_id: PIPE-52
priority: medium
ordinal: 155000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Define a runtime adapter seam for OpenCode capabilities so the pipeline can start with CLI subprocess execution and later support SDK/server-backed session continuation, session inspection, and plugin event integration.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Adapter interface separates runner launch, output normalization, session metadata, and optional continuation/session APIs.
- [x] #2 Existing CLI subprocess path remains the default implementation and behavior-compatible.
- [x] #3 Official @opencode-ai/sdk and @opencode-ai/plugin are vetted and documented as candidates for future native session integration, not blindly added as runtime dependencies.
- [x] #4 Tests prove existing OpenCode runner launch plans still produce expected argv and output format handling.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Extract enough structure around src/runner.ts to avoid baking continuation logic into raw argv rendering. Do not implement OpenCode server/plugin integration until the seam and CLI compatibility are tested.

<!-- SECTION:PLAN:END -->
