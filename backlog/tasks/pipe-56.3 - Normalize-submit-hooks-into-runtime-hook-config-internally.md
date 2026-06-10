---
id: PIPE-56.3
title: Normalize submit hooks into runtime hook config internally
status: To Do
assignee: []
created_date: '2026-06-10 22:12'
labels:
  - api
  - hooks
  - runtime
dependencies:
  - PIPE-56.2
modified_files:
  - src/moka-submit.ts
  - src/pipeline-runtime.ts
  - src/runtime/hooks/hooks.ts
  - tests/moka-submit.test.ts
  - src/runtime/hooks/hooks.test.ts
parent_task_id: PIPE-56
priority: high
ordinal: 181000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Convert the direct Moka submit hooks input into the existing PipelineConfig hook runtime structure inside the package. This keeps hooks.functions and hooks.on[event][] as internal runtime detail while giving Pipeline Console a clean TypeScript API.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 submitMoka builds an effective PipelineConfig from the provided config plus direct hooks without requiring callers to mutate nested PipelineConfig.hooks.
- [ ] #2 Generated internal hook ids are deterministic, valid registry ids, and stable across repeated submissions.
- [ ] #3 Command and module handlers map to existing runtime hook function specs, including timeout, trusted, failure, with/input, and publishResult/result.publish semantics.
- [ ] #4 Existing package-owned default hooks are preserved unless a submitted hook intentionally targets the same event and generated id conflict policy is documented and tested.
- [ ] #5 Unit tests prove direct hooks produce hook.start, hook.finish, and hook.result when publishResult is true through the existing runtime event flow.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add a small normalization boundary near submitMoka input parsing. Prefer a pure function that accepts PipelineConfig and validated direct hooks and returns PipelineConfig. Do not change the runner event sink contract in this ticket.
<!-- SECTION:PLAN:END -->
