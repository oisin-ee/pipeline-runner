---
id: PIPE-49
title: 'Epic: Architecturally separate self-contained devspace runner jobs'
status: To Do
assignee: []
created_date: '2026-06-05 12:26'
labels:
  - epic
  - runner-job
  - devspace
  - kubernetes
dependencies: []
references:
  - src/index.ts
  - src/runner-job-contract.ts
priority: high
ordinal: 116000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Separate the Kubernetes runner-job product surface from the pipeline command/runtime. The runner job prepares a clean devspace workspace from payload and secrets, then invokes the pipeline engine as a caller. The pipeline command remains its own user-facing command and must not import runner-job internals.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Pipeline command registration and runner-job command registration are separate command surfaces.
- [ ] #2 Runner-job implementation lives under a dedicated module boundary and invokes the pipeline engine instead of embedding pipeline command behavior.
- [ ] #3 Clean devspace runner jobs clone and checkout the requested repository SHA into /workspace before invoking the pipeline.
- [ ] #4 Ticket-specific schedules and run artifacts are generated inside the Job, not committed before the run.
- [ ] #5 No compatibility shims, legacy kubernetes-runner file, or runKubernetesRunnerJob symbol remain.
- [ ] #6 Successful runner-job pipeline runs create a GitHub pull request after verification and emit the PR URL as run evidence.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Deliver as atomic dependent tickets: command separation, runner-job module extraction, payload contract, workspace bootstrap, devspace readiness, phase events, MCP OpenCode fix, in-job schedule proof, dogfood verification, PR delivery, and documentation.
<!-- SECTION:PLAN:END -->
