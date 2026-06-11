---
id: PIPE-60.3
title: Add Argo retryStrategy for startup-only exit code 70
status: To Do
assignee: []
created_date: '2026-06-11 21:15'
updated_date: '2026-06-11 21:15'
labels:
  - argo
  - runtime
dependencies:
  - PIPE-60.1
parent_task_id: PIPE-60
priority: high
ordinal: 205000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add Argo retryStrategy for infrastructure startup failures only. The runtime node engine already owns semantic retries such as task failure retry policy, gate-failure remediation, and retry backoff. Argo should retry only the runner startup failure code used for infra flakes, exit code 70, so pod startup crashes and transient cluster conditions do not masquerade as user task failures.

The current strict workflow schema in `src/argo-workflow.ts` does not include retryStrategy, so this ticket owns the schema update, workflow generation change, and golden snapshot updates.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 The Argo Workflow TypeScript/schema model accepts retryStrategy in the generated DAG task/template location used by runner jobs.
- [ ] #2 Generated workflow manifests retry only startup exit code 70; task failure exit codes are not retried by Argo.
- [ ] #3 Runtime semantic retry tests still prove attempts/backoff/gate remediation are handled by the node engine, not Argo.
- [ ] #4 Golden workflow snapshots include the retryStrategy expression and no unrelated manifest churn.
- [ ] #5 Tests include the documented Argo `lastRetry.exitCode` caveat: if the expression can evaluate `-1` in the local template shape, the implementation chooses a shape or guard that keeps non-70 task exits from retrying.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update `src/argo-workflow.ts` schema/types first, then the workflow generation path that emits runner DAG tasks/templates, then the Argo workflow snapshot tests. Use Argo's native retryStrategy/expression facility; do not add a custom retry wrapper in runner-command or the pipeline runtime. Keep retry limits conservative and tied to startup-only infrastructure failure.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Known caveat from the earlier plan review: upstream Argo issue argoproj/argo-workflows#13297 reports `lastRetry.exitCode` can appear as `-1` in some same-YAML template cases. The implementing agent must inspect the generated template shape and prove the chosen expression does not retry normal task failures. If that cannot be proven in generated manifests/tests, stop and escalate rather than broadening Argo retries.
<!-- SECTION:NOTES:END -->
