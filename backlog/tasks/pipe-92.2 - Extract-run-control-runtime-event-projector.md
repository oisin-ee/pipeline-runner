---
id: PIPE-92.2
title: Extract run-control runtime event projector
status: To Do
assignee: []
created_date: '2026-06-26 22:05'
labels: []
dependencies:
  - PIPE-92.1
references:
  - src/run-control/runtime-reporter.ts
  - tests/run-control-runtime-reporter.test.ts
  - 'https://vitest.dev/api/describe#describe-each'
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
- [ ] #1 projectRuntimeEvent or replacement accepts explicit projection state and returns store write intents without doing I/O -- Evidence: source inspection plus focused projector tests
- [ ] #2 table tests cover workflow, node, agent, gate, hook, and session projection cases currently covered only through reporter I/O -- Evidence: focused projector test output
- [ ] #3 runtime-reporter remains a thin shell: append runtime JSONL/stdout, apply projector writes to RunControlStore, forward original reporter -- Evidence: reporter tests unchanged/pass
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order: research + library-first-development -> inspect existing patterns -> Build Contract -> targeted tests -> implementation -> quality-gate/critique -> verify
- [ ] #2 Proof commands recorded: bun run test tests/run-control-runtime-event-projection.test.ts tests/run-control-runtime-reporter.test.ts && bun run typecheck && bun run check
<!-- DOD:END -->
