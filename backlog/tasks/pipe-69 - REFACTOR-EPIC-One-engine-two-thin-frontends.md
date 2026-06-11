---
id: PIPE-69
title: 'REFACTOR EPIC: One engine, two thin frontends'
status: To Do
assignee:
  - '@codex'
created_date: '2026-06-11 20:41'
labels: []
milestone: Refactor
dependencies: []
priority: high
ordinal: 201000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Comprehensive refactoring to unify the moka runtime, eliminate xstate redundancy, and unblock job spawning. This epic encompasses the full strategic refactor described in ~/.claude/plans/i-d-like-you-to-replicated-widget.md. Phase breakdown: Phase 0 (safety net), Phase 1 (dead code/dedup), Phase 2 (de-xstate keystone), Phase 3 (executor seam + Argo wins), Phase 4 (hands-on UX: live terminal + devspace), Phase 5 (monolith splits + decisions), Phase 6 (infra unblocking + preflight tooling). The owner uses TWO modes: autonomous (fire ticket at cluster from console/phone, let Argo run it) and hands-on (pair with agent at desk, local CLI or devspace pod). The refactor unifies these into one node engine (gates, retries, remediation, hooks) + two thin thin schedulers (local ready-queue, Argo controller). Result: ~2,000 lines deleted (xstate + dead code), ~500 added (plain async), one mental model, faster iteration, easier debugging, and an infra preflight tool to unblock job spawning.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Phase 0-2 complete: xstate deleted, plain async scheduler, event contracts pinned.
- [ ] #2 Phase 3: PipelineScheduler interface, hook parity, Argo retryStrategy for exit 70.
- [ ] #3 Phase 4: live terminal rendering + devspace recipe for hands-on work.
- [ ] #4 Phase 5: monoliths split (config, schedule, cli), architecture decisions documented.
- [ ] #5 Phase 6: moka doctor tool added, minimal e2e, infra unblocking separate (INFRA-050 owner responsibility).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Each phase is independently shippable after its dependencies. Phase 0 lands before any Phase 1+. Regression gates at each phase (PIPE-57 goldens, tests/pipeline-runtime.test.ts unchanged). Estimated effort: ~2-3 weeks full-time if done in sequence, but most phases are parallelizable by different developers.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Comprehensive research completed (ARGO-3.7 capabilities, dual-scheduler anti-patterns, durable execution alternatives, agent pipeline frameworks, library choices). Verified facts: (1) xstate machines do not use snapshots/resumption/hierarchical states - just callbacks (2) node engine already unified (both paths call runScheduledWorkflowTask) (3) existing test coverage ~19k lines de-risks refactor (4) only the xstate inspection API is a real contract (event names/runtimeActorId format) (5) infra blocker (OpenBao/ESO) is separate from code refactor. The plan is concrete, phases are sequential with independent regression gates, and the outcome is a stronger, leaner codebase with both execution modes properly supported.
<!-- SECTION:NOTES:END -->
