---
id: PIPE-60.4
title: Add LocalScheduler versus Argo parity contract test
status: To Do
assignee: []
created_date: '2026-06-11 21:15'
labels:
  - tests
  - argo
  - runtime
dependencies:
  - PIPE-60.2
  - PIPE-60.3
parent_task_id: PIPE-60
priority: high
ordinal: 206000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add the contract test that proves the two execution frontends preserve the same runtime semantics. The local path runs the plan through LocalScheduler. The Argo path should exercise the generated DAG graph and Argo finalizer/lifecycle adapters with stubs instead of requiring a live cluster; PIPE-67 owns the later in-cluster one-node e2e.

The contract is semantic parity, not byte-identical implementation: same eligible-node ordering, same skip reasons, same failure/completion state, same lifecycle event sequence shape, and same node-engine retry ownership.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 A parity test uses one representative plan with dependencies, a skipped descendant path, and a workflow hook path.
- [ ] #2 LocalScheduler execution and Argo DAG graph expansion/finalization produce equivalent execution order, skip reasons, and final completion state.
- [ ] #3 The test verifies workflow lifecycle event shape for start, success/failure, and complete after PIPE-60.2.
- [ ] #4 The test verifies Argo retryStrategy exists for exit code 70 after PIPE-60.3 without treating semantic task retries as Argo retries.
- [ ] #5 The test is deterministic and runs in the normal local test suite without Kubernetes cluster access.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add a focused contract test alongside the existing runtime/Argo tests. Build fixture helpers only if they make the LocalScheduler and Argo graph assertions share the same plan object. Use existing test tooling and generated workflow parsing; do not add a mocked Kubernetes client. Leave live cluster admission/completion/event delivery to PIPE-67.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
This test should catch future drift between hands-on local execution and autonomous Argo execution. Keep assertions on observable behavior and manifest/runtime contracts, not private helper names.
<!-- SECTION:NOTES:END -->
