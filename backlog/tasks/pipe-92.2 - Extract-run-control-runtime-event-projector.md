---
id: PIPE-92.2
title: Extract run-control runtime event projector
status: Done
assignee: []
created_date: "2026-06-26 22:05"
updated_date: "2026-06-26 23:26"
labels: []
dependencies:
  - PIPE-92.1
references:
  - src/run-control/runtime-reporter.ts
  - tests/run-control-runtime-reporter.test.ts
  - "https://vitest.dev/api/describe#describe-each"
modified_files:
  - src/run-control/runtime-event-projection.ts
  - src/run-control/runtime-reporter.ts
  - tests/run-control-runtime-event-projection.test.ts
  - tests/run-control-runtime-reporter.test.ts
parent_task_id: PIPE-92
priority: medium
ordinal: 291000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: move private runtime event projection logic out of src/run-control/runtime-reporter.ts into a pure/state-explicit module. Keep filesystem JSONL appenders and store writes in the reporter shell.
Dependencies: PIPE-92.1 to avoid same-file write collision in runtime-reporter.ts
Likely modified files: src/run-control/runtime-event-projection.ts, src/run-control/runtime-reporter.ts, tests/run-control-runtime-event-projection.test.ts, tests/run-control-runtime-reporter.test.ts
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 projectRuntimeEvent or replacement accepts explicit projection state and returns store write intents without doing I/O -- Evidence: source inspection plus focused projector tests
- [x] #2 table tests cover workflow, node, agent, gate, hook, and session projection cases currently covered only through reporter I/O -- Evidence: focused projector test output
- [x] #3 runtime-reporter remains a thin shell: append runtime JSONL/stdout, apply projector writes to RunControlStore, forward original reporter -- Evidence: reporter tests unchanged/pass
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented in commit bba14dd. Extracted runtime-event-projection.ts with explicit projection state and typed RunControlStore write intents; runtime-reporter now appends JSONL/stdout and applies projector intents as a shell. Proof: bun run test tests/run-control-runtime-event-projection.test.ts tests/run-control-runtime-reporter.test.ts passed 18 tests; bun run typecheck passed; bun x biome check on touched files passed; bun run check exited 0 but checked 0 files in this worktree.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run the feature-implementation workflow in order: research + library-first-development -> inspect existing patterns -> Build Contract -> targeted tests -> implementation -> quality-gate/critique -> verify
- [x] #2 Proof commands recorded: bun run test tests/run-control-runtime-event-projection.test.ts tests/run-control-runtime-reporter.test.ts && bun run typecheck && bun run check
<!-- DOD:END -->
