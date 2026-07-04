---
id: PIPE-104.4
title: 'moka: opencode parity gate — yeet executor == SDK executor'
status: To Do
assignee: []
created_date: '2026-07-04 10:56'
labels: []
dependencies:
  - PIPE-104.3
parent_task_id: PIPE-104
priority: high
ordinal: 345000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation. What to build: a parity test harness proving the yeet-backed executor is behaviourally equivalent to the @opencode-ai/sdk executor for opencode — the gate that unlocks widening + teardown in later phases. Run a representative set of opencode graph runs through BOTH executors and assert the emitted RunnerEventRecord streams (normalized for nondeterministic fields — session ids, timestamps, usage counts) and node outcomes (PASS/FAIL, structured output) are identical. Vertical slice: a repeatable parity command/test that is green. Scope: oisin-pipeline test harness + a normalization helper for nondeterministic event fields; no production-path changes beyond what the executor ticket landed. Research required: none (both executors exist after prior tickets); inspect existing runner event fixtures for the representative run set. Model recommendation — Claude: Opus (cross-executor equivalence reasoning, normalization of nondeterminism is subtle; claude 2.1.199); Codex: gpt-5.5-high (0.142.5); OpenCode: MoKa Acceptance Reviewer default (1.17.12).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Representative opencode runs produce identical normalized RunnerEventRecord streams across both executors -- Evidence: parity test diffs the two streams, empty diff
- [ ] #2 Node outcomes (pass/fail + structured output) match across executors -- Evidence: parity test asserts equal outcomes per run
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 Parity test run fresh against both executors, output recorded
<!-- DOD:END -->
