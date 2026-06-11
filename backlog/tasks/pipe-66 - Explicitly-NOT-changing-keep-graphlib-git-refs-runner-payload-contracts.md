---
id: PIPE-66
title: 'Explicitly NOT changing: keep graphlib, git-refs, runner payload contracts'
status: To Do
assignee: []
created_date: '2026-06-11 20:40'
labels:
  - refactor
  - decisions
  - documentation
dependencies:
  - PIPE-60
priority: low
ordinal: 198000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 is the last substantive refactor phase; Phases 6+ are infrastructure (unblocking job spawning). Document what STAYS unchanged so future refactors do not re-question these: (1) @dagrejs/graphlib + iterative toposort in workflow-planner.ts - graphlib alg.topsort is recursive (stack-overflow risk on deep chains); we keep the iterative impl and document the tradeoff. (2) Git-ref state model (refs/heads/pipeline/runs/.../nodes/{nodeId}) - Argo artifacts pass files, not merged git history; git refs are load-bearing for semantic state passing and dependency pre-fetch. (3) Runner payload v1, event record schema, schedule artifact format, k8s label conventions (pipeline.oisin.dev/*) - all external contracts consumed by Pipeline Console; no breaking changes. (4) Hand-rolled AbortSignal-aware retry delay in src/runtime/retry.ts - gate-failure-to-remediation-reprompt flow, p-retry does not model it. (5) Custom event sink HTTP batching + retry logic - semantically richer than k8s events (docs explicitly warn against k8s events for automation); keeping bespoke sink. Add these as implementation notes so the codebase decision-history is clear.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A note in src/workflow-planner.ts explains the iterative toposort + graphlib choice.
- [ ] #2 A note in src/run-state/git-refs.ts explains why git refs, not Argo artifacts.
- [ ] #3 A note in src/runner-command-contract.ts documents the external consumer dependencies.
- [ ] #4 README or architecture doc references these decisions.
<!-- AC:END -->
