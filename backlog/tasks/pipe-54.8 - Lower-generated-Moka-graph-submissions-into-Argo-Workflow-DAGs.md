---
id: PIPE-54.8
title: Lower generated Moka graph submissions into Argo Workflow DAGs
status: In Progress
assignee: []
created_date: '2026-06-11 15:24'
updated_date: '2026-06-11 15:47'
labels:
  - momokaya
  - argo
  - compiler
dependencies:
  - PIPE-54.4
references:
  - src/argo-workflow.ts
  - src/argo-submit.ts
  - src/moka-submit.ts
  - src/runner-command-contract.ts
  - tests/argo-workflow.test.ts
  - tests/argo-submit.test.ts
  - tests/moka-submit.test.ts
modified_files:
  - src/argo-workflow.ts
  - src/argo-submit.ts
  - src/moka-submit.ts
  - tests/argo-workflow.test.ts
  - tests/argo-submit.test.ts
  - tests/moka-submit.test.ts
parent_task_id: PIPE-54
priority: high
ordinal: 184000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the missing graph-to-Argo lowering needed for moka submit full and quick modes. The current verifier proved command-mode Argo submission works, but full/quick generated graph submissions correctly fail because the Argo compiler only accepts explicit command nodes and rejects generated agent, builtin, workflow, and parallel graph nodes. This ticket owns real lowering semantics; PIPE-54.7 owns live cluster verification after this lands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 moka submit full and quick generated schedules compile to valid Argo Workflow DAG templates without using fake builtin/group/parallel lowering.
- [ ] #2 Generated agent/profile nodes become runner-command tasks with the correct schedule/run/task context, dependencies, image, env, and secret wiring.
- [ ] #3 Builtin, workflow, and parallel/container nodes either lower to explicit Argo DAG structure with preserved needs semantics or fail with typed validation errors naming the unsupported node kind and id.
- [ ] #4 Tests cover full and quick graph submissions containing agent nodes, dependency fan-out/fan-in, builtin/parallel/workflow cases, and schedule-backed submission.
- [ ] #5 PIPE-54.7 can be rerun against a disposable Argo cluster without hitting unsupported non-command node-kind errors.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Inspect src/argo-workflow.ts, src/argo-submit.ts, src/moka-submit.ts, workflow planning output, and runner-command payload contracts. Add failing compiler/submission tests for representative full/quick generated schedules. Implement graph lowering through the existing Argo workflow builder and runner-command contract, preserving schedule dependencies and avoiding compatibility shims. Keep live cluster proof in PIPE-54.7.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
SSH root-cause work corrected on 2026-06-11: the previous SSH-to-HTTPS fallback was removed. Runner git workspace preparation now keeps SSH remotes on SSH and fails before git clone with an explicit error when the mounted git credential Secret lacks identity and known_hosts. When identity plus known_hosts are mounted, the runner uses GIT_SSH_COMMAND with IdentitiesOnly=yes, UserKnownHostsFile, and StrictHostKeyChecking=yes. Live cluster inspection showed the configured Secret oisin-bot-git-credentials in momokaya-pipeline contains only username and password, so real SSH authentication is still not provisioned in the cluster until that Secret is updated with an SSH private key identity and known_hosts. Verification passed: bunx vitest run tests/run-state-git-refs.test.ts tests/moka-submit.test.ts tests/runner-command-contract.test.ts; bun run typecheck; bun run check; bun run build.
<!-- SECTION:NOTES:END -->
