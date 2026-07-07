---
id: PIPE-49
title: "Epic: Architecturally separate self-contained devspace runner jobs"
status: Done
assignee: []
created_date: "2026-06-05 12:26"
updated_date: "2026-07-07 09:47"
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

## Grooming 2026-07-04 — epic superseded by moka/Argo; subtasks .1-.6 archived

The architecture this epic targets (self-contained Kubernetes devspace runner Jobs: `src/kubernetes-runner.ts` -> a `src/runner-job/` module, `OISIN_PIPELINE_RUNNER_PAYLOAD_JSON` payload contract, `/workspace/devspace.yaml` clean-checkout gating) was BUILT (f304e97 'feat(runner): add self-contained runner jobs' + follow-ons) then DELETED WHOLESALE in commit 269f097 'feat: moka' (2026-06-10). `git show --stat 269f097` shows the removals: `src/runner-job/run.ts` (869), `src/runner-job/workspace.ts` (181), `src/runner-job/devspace.ts` (77), `src/runner-job/k8s.ts`, `src/runner-job/delivery.ts`, `src/runner-job/pr-summary.ts`, `src/commands/runner-job-command.ts`, plus all `tests/runner-job*.test.ts`. `src/runner-job-contract.ts` and `src/kubernetes-runner.ts` are also gone.

Current remote-execution architecture: moka submit -> Argo Workflows. Surface lives in `src/remote/argo`, `src/remote/submit`, `src/runner-command/`, `src/runner-command-contract.ts`, `src/workflow-submit-contract.ts`. `devspace` appears NOWHERE in `src/` today (`git grep -l devspace -- 'src/**'` is empty).

Some epic INTENT survives under the new architecture but via different modules (not the runner-job module this epic specifies):

- AC#3 clean checkout of repo SHA into /workspace -> moka runner via `src/run-state/git-refs.ts` (DEFAULT_WORKSPACE_PATH='/workspace', runAuthenticatedGit).
- AC#4 schedules generated inside the Job -> `src/runner-command/pre-schedule.ts` (see PIPE-94, shipped).
- AC#6 PR at end of run -> `src/runtime/services/open-pull-request-git-service.ts` (moka runtime builtin).

Actions taken: subtasks PIPE-49.1 through PIPE-49.6 ARCHIVED (each targets a deleted file/module; see per-ticket comments citing 269f097).

RECOMMENDATION: archive/close this whole epic. Remaining subtasks .7-.12 (out of this grooming pass's scope) are premised on the same dead runner-job/devspace architecture — .8 'schedules inside runner jobs', .9 'devspace smoke command', .10 'dogfood clean devspace runner-job', .11 'document Console->runner-job contract' are moot; .7 (OpenCode gateway remote auth) and .12 (PR at end) have moka analogues that may already be shipped and should be re-verified/re-filed against the moka/Argo surface, not this epic. Triage .7-.12, then archive the epic.

<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->

## created: 2026-07-07 09:47

## Migrated to ENG-33.

<!-- COMMENTS:END -->
