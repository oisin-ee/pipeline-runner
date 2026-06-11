---
id: PIPE-56.4
title: Make Moka submit hook policy explicit and honored
status: Done
assignee:
  - '@codex'
created_date: '2026-06-10 22:12'
updated_date: '2026-06-10 22:54'
labels:
  - api
  - hooks
  - runner
dependencies:
  - PIPE-56.2
modified_files:
  - src/moka-submit.ts
  - src/runner-command-contract.ts
  - src/runner-command/run.ts
  - tests/moka-submit.test.ts
  - tests/runner-command-contract.test.ts
parent_task_id: PIPE-56
priority: high
ordinal: 182000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Resolve the stale allowCommandHooks API leak by making hook execution policy an explicit, tested Moka submit concern or removing it from the console-facing request path. The runner must not silently ignore a policy field accepted by Pipeline Console.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The public submit API has one documented hook policy shape, or no hook policy field at all if per-run policy is not supported.
- [x] #2 If per-run hook policy is supported, submitMoka carries it through the runner payload and runner-command passes it into runScheduledWorkflowTask hookPolicy.
- [x] #3 Tests prove command hooks are allowed or denied according to the documented policy, not hardcoded runner behavior.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Audit src/runner-command-contract.ts, src/runner-command/run.ts, src/moka-submit.ts, and the Pipeline Console create-run call site. Choose one policy path and remove the contradictory state. Keep the change schema-backed and covered by runner-command tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added public hookPolicy schema/types, carries hookPolicy through submitMoka into runner payload, and runner-command now passes payload.hookPolicy into runScheduledWorkflowTask instead of hardcoding allowCommandHooks true. Remaining AC: add direct runner-command policy allow/deny behavior coverage before closing.

Added behavior coverage: direct submit command hooks fail under allowCommandHooks:false, and runner-command passes payload.hookPolicy into runScheduledWorkflowTask instead of hardcoding policy.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Made Moka submit hook execution policy explicit and honored end to end.

Changes:
- Added public mokaSubmitHookPolicySchema and derived input/output types.
- Carried hookPolicy through submitMoka into the runner command payload.
- Updated runner-command to pass payload.hookPolicy into runScheduledWorkflowTask instead of hardcoding allowCommandHooks true.
- Removed the non-applicable acceptance criterion for the unsupported-policy path because per-run policy is now the documented supported behavior.

Tests:
- bun test tests/moka-submit.test.ts tests/runner-command-policy.test.ts tests/runner-command-contract.test.ts tests/package-public-api.test.ts --runInBand
- bun run typecheck
- bun run build:cli

Note: bun run check still fails on pre-existing formatter drift in unrelated files: src/install-commands.ts, tests/config.test.ts, tests/install-commands.test.ts, tests/schedule-planner.test.ts, and tests/tracer-bullet.test.ts.
<!-- SECTION:FINAL_SUMMARY:END -->
