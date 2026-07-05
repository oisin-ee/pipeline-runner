---
id: PIPE-69
title: "REFACTOR EPIC: One engine, two thin frontends"
status: Done
assignee:
  - "@codex"
created_date: "2026-06-11 20:41"
updated_date: "2026-06-12 10:29"
labels: []
milestone: Refactor
dependencies: []
priority: high
ordinal: 201000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Comprehensive refactoring to unify the moka runtime, eliminate xstate redundancy, and unblock job spawning. This epic encompasses the full strategic refactor described in ~/.claude/plans/i-d-like-you-to-replicated-widget.md. Phase breakdown: Phase 0 (safety net), Phase 1 (dead code/dedup), Phase 2 (de-xstate keystone), Phase 3 (executor seam + Argo wins), Phase 4 (hands-on UX: live terminal + devspace), Phase 5 (monolith splits + decisions), Phase 6 (infra unblocking + preflight tooling). The owner uses TWO modes: autonomous (fire ticket at cluster from console/phone, let Argo run it) and hands-on (pair with agent at desk, local CLI or devspace pod). The refactor unifies these into one node engine (gates, retries, remediation, hooks) + two thin schedulers/frontends (local ready-queue, Argo controller). Result: ~2,000 lines deleted (xstate + dead code), ~500 added (plain async), one mental model, faster iteration, easier debugging, and an infra preflight tool to unblock job spawning.

Corrected child structure: PIPE-57 pins behavior before refactors; PIPE-59.5 extracts runtime actor/observability contracts before machine deletion; PIPE-59.1 through PIPE-59.4 remove gate/hook/node/workflow machines and xstate across all seven import sites; PIPE-60.1 through PIPE-60.5 split the scheduler seam, Argo lifecycle parity, startup-only retryStrategy, LocalScheduler-vs-Argo parity contract, and RuntimeContext cleanup; PIPE-67 is value-free cluster preflight/doctor tooling, with OpenBao/ESO auth drift owned outside this repo.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Phase 0-2 complete: PIPE-57 event/behavior goldens pass, PIPE-59.5 preserves runtime actor contracts, xstate is deleted, and the plain async scheduler covers all seven former xstate import sites.
- [x] #2 Phase 3: PIPE-60.1 through PIPE-60.5 define PipelineScheduler, prove lifecycle hook parity, add startup-only Argo retryStrategy for exit 70, prove LocalScheduler-versus-Argo parity, and trim RuntimeContext.
- [x] #3 Phase 4: live terminal rendering + devspace recipe for hands-on work.
- [x] #4 Phase 5: monoliths split (config, schedule, cli), architecture decisions documented.
- [x] #5 Phase 6: moka doctor tool added, minimal real-usage e2e runs, and infra unblocking remains separate (INFRA-050/OpenBao/ESO owner responsibility).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Each phase is independently shippable after its dependencies. Phase 0 lands before any Phase 1+. Regression gates at each phase include PIPE-57 goldens, focused runtime tests, the representative pipeline-runtime test suite, typecheck, and repository check. Use `backlog sequence list --plain` to drain dependency batches rather than guessing order. Estimated effort: ~2-3 weeks full-time if done in sequence, with most non-conflicting child tickets parallelizable after their shared contract tickets land.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Comprehensive research completed (ARGO-3.7 capabilities, dual-scheduler anti-patterns, durable execution alternatives, agent pipeline frameworks, library choices). Verified facts: (1) xstate machines do not use snapshots/resumption/hierarchical states - just callbacks (2) node engine already unified (both paths call runScheduledWorkflowTask) (3) existing test coverage ~19k lines de-risks refactor (4) only the xstate inspection API is a real contract (event names/runtimeActorId format) (5) infra blocker (OpenBao/ESO) is separate from code refactor. The plan is concrete, phases are sequential with independent regression gates, and the outcome is a stronger, leaner codebase with both execution modes properly supported.

Preserve the original rationale while draining children: this is not a wholesale runtime rewrite. It is a contract-preserving removal of redundant xstate orchestration, followed by a named scheduler boundary and Argo-specific hardening where Argo is the right tool.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

PIPE-69 accepted and closed. The runtime is now one plain async node engine with two thin frontends. PIPE-57 goldens and focused contract tests pass; xstate and src/runtime-machines are gone from source, package metadata, and lockfile; PipelineScheduler/LocalScheduler, shared workflow lifecycle, startup-only Argo retryStrategy for exit 70, Argo/local parity, and NodeStateStore are in place. Hands-on mode has default live terminal reporting plus a DevSpace runner pod recipe. config, schedule planner, and CLI monoliths are split behind stable public barrels, and keep-decisions for graphlib, git refs, runner payload/event/schedule/label contracts, AbortSignal retry delay, and event sink are documented. PIPE-67 added value-free moka doctor checks and recorded real cluster smoke evidence while leaving OpenBao/ESO repair to infra. PIPE-68 completed the no-consumer package export decision: goal-loop/goal-state subpath exports and tsdown entrypoints were removed for the next major release with semantic-release/GitHub Actions as the publishing path. MoKa Acceptance Reviewer passed all five PIPE-69 ACs; focused verification passed refactor acceptance tests, golden/package/Argo/schedule contract tests, and CLI/doctor tests.

<!-- SECTION:FINAL_SUMMARY:END -->
