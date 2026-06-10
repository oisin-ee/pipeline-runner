---
id: PIPE-56.4
title: Make Moka submit hook policy explicit and honored
status: To Do
assignee: []
created_date: '2026-06-10 22:12'
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
- [ ] #1 The public submit API has one documented hook policy shape, or no hook policy field at all if per-run policy is not supported.
- [ ] #2 If per-run hook policy is supported, submitMoka carries it through the runner payload and runner-command passes it into runScheduledWorkflowTask hookPolicy.
- [ ] #3 If per-run hook policy is not supported, pipeline-console-facing types/tests stop accepting allowCommandHooks as an effective control.
- [ ] #4 Tests prove command hooks are allowed or denied according to the documented policy, not hardcoded runner behavior.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Audit src/runner-command-contract.ts, src/runner-command/run.ts, src/moka-submit.ts, and the Pipeline Console create-run call site. Choose one policy path and remove the contradictory state. Keep the change schema-backed and covered by runner-command tests.
<!-- SECTION:PLAN:END -->
