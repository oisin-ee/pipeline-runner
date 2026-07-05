---
id: PIPE-45.16
title: Performance cleanup pass
status: Done
assignee: []
created_date: "2026-06-27 14:03"
labels: []
dependencies:
  - PIPE-45.2
  - PIPE-45.3
  - PIPE-45.4
  - PIPE-45.5
  - PIPE-45.6
  - PIPE-45.7
  - PIPE-45.8
  - PIPE-45.9
  - PIPE-45.10
  - PIPE-45.11
  - PIPE-45.12
  - PIPE-45.13
  - PIPE-45.14
  - PIPE-45.15
references:
  - .fallowrc.json
modified_files:
  - src/runtime/events/events.ts
  - src/runtime/events/events.test.ts
parent_task_id: PIPE-45
priority: medium
ordinal: 311000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: performance
Scope: Measure current hot/complex paths after structural splits and remove measurable avoidable cost only where evidence shows a bottleneck.
Dependencies: all structural cleanup tickets through PIPE-45.15
Likely modified files: modules identified by fallow/hotspot baseline
Reuse: existing fallow health/hotspot tooling and test suite; no speculative perf rewrites.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Baseline and after measurements use same command/conditions -- Evidence: `pnpm exec fallow health --production --complexity --targets --hotspots --report-only --top 20` before edit identified `src/runtime/events/events.ts` top complexity entries `runtimeObservabilitySummary` (cyclomatic 27, cognitive 19, CRAP 756) and `runtimeObservabilityNodeId` (cyclomatic 14, CRAP 210); after edit same command no longer lists `src/runtime/events/events.ts` in the top 20 complexity functions.
- [x] #2 Only measured bottlenecks are changed; no speculative optimization complexity is added -- Evidence: diff is limited to runtime event formatting/prefix/structured-output ownership; `pnpm exec fallow audit --changed-since HEAD --production` reports no issues in 2 changed files.
- [x] #3 Performance changes preserve behaviour -- Evidence: `bun run test src/runtime/events/events.test.ts tests/pipeline-runtime.test.ts tests/runner-event-sink.test.ts tests/runner-command-contract.test.ts` passed, 4 files / 98 tests.
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run performance workflow: baseline, identify bottleneck, change one bottleneck, remeasure, verify. Evidence: baseline/after fallow health recorded above; `bun run check`; `bun run typecheck`; focused runtime tests; `pnpm exec fallow audit --changed-since HEAD --production`.
<!-- DOD:END -->
