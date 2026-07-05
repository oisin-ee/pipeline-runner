---
id: PIPE-56.3
title: Normalize submit hooks into runtime hook config internally
status: Done
assignee:
  - "@codex"
created_date: "2026-06-10 22:12"
updated_date: "2026-06-10 22:54"
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

- [x] #1 submitMoka builds an effective PipelineConfig from the provided config plus direct hooks without requiring callers to mutate nested PipelineConfig.hooks.
- [x] #2 Generated internal hook ids are deterministic, valid registry ids, and stable across repeated submissions.
- [x] #3 Command and module handlers map to existing runtime hook function specs, including timeout, trusted, failure, with/input, and publishResult/result.publish semantics.
- [x] #4 Existing package-owned default hooks are preserved unless a submitted hook intentionally targets the same event and generated id conflict policy is documented and tested.
- [x] #5 Unit tests prove direct hooks produce hook.start, hook.finish, and hook.result when publishResult is true through the existing runtime event flow.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Add a small normalization boundary near submitMoka input parsing. Prefer a pure function that accepts PipelineConfig and validated direct hooks and returns PipelineConfig. Do not change the runner event sink contract in this ticket.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Implemented direct submit hook normalization in src/moka-submit.ts. Added deterministic generated ids, command/module mapping, preservation of existing hooks, conflict rejection, and runtime event-flow coverage for hook.start/hook.finish/hook.result.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Normalized public Moka submit direct hooks into the package-owned PipelineConfig hook runtime shape.

Changes:

- Added Zod-backed direct command/module hook inputs keyed by supported lifecycle events.
- Generated deterministic internal hook ids such as moka-submit-node-finish, preserving existing hooks and rejecting generated id collisions before submission.
- Mapped submit inputs onto runtime hook functions and bindings, including timeout, trust, failure, input, publishResult, and saveResultAs semantics.
- Documented generated id and collision behavior in README and the operator guide.

Tests:

- bun test tests/moka-submit.test.ts tests/runner-command-policy.test.ts tests/runner-command-contract.test.ts tests/package-public-api.test.ts --runInBand
- bun run typecheck
- bun run build:cli

Note: bun run check still fails on pre-existing formatter drift in unrelated files: src/install-commands.ts, tests/config.test.ts, tests/install-commands.test.ts, tests/schedule-planner.test.ts, and tests/tracer-bullet.test.ts.

<!-- SECTION:FINAL_SUMMARY:END -->
